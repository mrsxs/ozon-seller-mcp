// One-call answers for common seller questions. Each tool fans out to the
// official endpoints (in parallel where possible) and returns compact rows.
import { request } from './http.js';

const DAY = 86_400_000;
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const round2 = (v) => Math.round(v * 100) / 100;
const isoDate = (d) => d.toISOString().slice(0, 10);

function resolvePeriod(args, defaultDays) {
  const to = args.date_to ?? isoDate(new Date());
  const days = args.days ?? defaultDays;
  const from = args.date_from ?? isoDate(new Date(Date.parse(to + 'T00:00:00Z') - (days - 1) * DAY));
  if (from > to) throw new Error('date_from 不能晚于 date_to。');
  return { date_from: from, date_to: to };
}

class Run {
  notes = [];
  timing_ms = {};
  sources = new Set();
  started = performance.now();

  async call(label, endpoint, body) {
    const t = performance.now();
    this.sources.add(endpoint);
    try {
      return (await request(endpoint, body)).data;
    } finally {
      if (label) this.timing_ms[label] = Math.round(performance.now() - t);
    }
  }

  // Secondary data: a failure becomes a note instead of failing the whole answer.
  async optional(label, endpoint, body) {
    try {
      return await this.call(label, endpoint, body);
    } catch (error) {
      this.notes.push(`${label}（${endpoint}）失败，相关字段缺失：${error.message}`);
      return null;
    }
  }

  finish(payload) {
    this.timing_ms.total = Math.round(performance.now() - this.started);
    return { ...payload, notes: this.notes, timing_ms: this.timing_ms, sources: [...this.sources] };
  }
}

const ANALYTICS_NOTE = '销量/营收来自 /v1/analytics/data（官方限 1 次/分钟、50 次/天；相同查询 5 分钟内复用缓存）。revenue 为下单金额口径，接口不返回币种。';
const ANALYTICS_PAGE = 1000;

// ---- shared product helpers ------------------------------------------------

function stockBySource(item) {
  const out = {};
  for (const s of item?.stocks?.stocks ?? []) {
    const key = s.source ?? s.type ?? 'unknown';
    out[key] ??= { present: 0, reserved: 0 };
    out[key].present += s.present ?? 0;
    out[key].reserved += s.reserved ?? 0;
  }
  return out;
}

function productBasics(item) {
  if (!item) return {};
  return {
    product_id: item.id,
    offer_id: item.offer_id,
    name: item.name,
    skus: [...new Set((item.sources ?? []).map((s) => s.sku))],
    status: item.statuses?.status_name,
    moderate_status: item.statuses?.moderate_status,
    archived: Boolean(item.is_archived || item.is_autoarchived),
    price: num(item.price),
    old_price: num(item.old_price),
    min_price: num(item.min_price),
    currency: item.currency_code,
    stocks: stockBySource(item),
    image: item.primary_image?.[0] ?? item.images?.[0],
    description_category_id: item.description_category_id,
    type_id: item.type_id,
    created_at: item.created_at,
  };
}

function indexBySku(items) {
  const map = new Map();
  for (const item of items ?? []) {
    for (const source of item.sources ?? []) map.set(String(source.sku), item);
    if (item.sku) map.set(String(item.sku), item);
  }
  return map;
}

const namesCache = new Map();
const RICH_CONTENT_ID = 11254;

async function attributeNames(run, attrItems, language) {
  const pairs = new Map();
  for (const a of attrItems) {
    if (a.description_category_id && a.type_id) pairs.set(`${a.description_category_id}:${a.type_id}`, a);
  }
  const result = new Map();
  await Promise.all([...pairs.entries()].map(async ([key, a]) => {
    const cacheKey = `${key}:${language}`;
    const hit = namesCache.get(cacheKey);
    if (hit && Date.now() - hit.at < DAY) {
      result.set(key, hit.names);
      return;
    }
    const data = await run.optional(`属性名称 ${key}`, '/v1/description-category/attribute',
      { description_category_id: a.description_category_id, type_id: a.type_id, language });
    if (!data) return;
    const names = new Map((data.result ?? []).map((x) => [x.id, x.name]));
    namesCache.set(cacheKey, { at: Date.now(), names });
    result.set(key, names);
  }));
  return result;
}

function namedAttributes(item, names, maxLength) {
  const table = names.get(`${item.description_category_id}:${item.type_id}`);
  const out = {};
  for (const attr of item.attributes ?? []) {
    let label = table?.get(attr.id) ?? `#${attr.id}`;
    if (label in out) label = `${label}#${attr.id}`;
    if (attr.id === RICH_CONTENT_ID) {
      out[label] = '（富内容 JSON 已省略，需要时用 ozon_api_call 查询 /v4/product/info/attributes）';
      continue;
    }
    let value = (attr.values ?? []).map((v) => v.value).filter((v) => v !== '' && v !== null && v !== undefined)
      .map((v) => String(v).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).join('; ');
    if (value.length > maxLength) value = value.slice(0, maxLength) + '…';
    if (value) out[label] = value;
  }
  return out;
}

const dimensions = (a) => (a ? {
  size: [a.depth, a.width, a.height].every((v) => v !== undefined) ? `${a.depth}×${a.width}×${a.height} ${a.dimension_unit ?? ''}`.trim() : undefined,
  weight: a.weight !== undefined ? `${a.weight} ${a.weight_unit ?? ''}`.trim() : undefined,
  barcodes: a.barcodes,
} : {});

// ---- tools ---------------------------------------------------------------

const periodProps = {
  date_from: { type: 'string', format: 'date', description: '开始日期 YYYY-MM-DD（含）；不填则按 days 推算' },
  date_to: { type: 'string', format: 'date', description: '结束日期 YYYY-MM-DD（含）；默认今天（UTC）' },
};
const langProp = { type: 'string', enum: ['ZH_HANS', 'RU', 'EN'], default: 'ZH_HANS', description: '属性名称语言' };
const ID_TYPES = { offer_ids: 'offer_id', skus: 'sku', product_ids: 'product_id' };
const idProps = {
  offer_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: '卖家货号 offer_id' },
  skus: { type: 'array', items: { type: 'string', pattern: '^[0-9]+$' }, minItems: 1, maxItems: 20, description: 'Ozon SKU' },
  product_ids: { type: 'array', items: { type: 'string', pattern: '^[0-9]+$' }, minItems: 1, maxItems: 20, description: 'Ozon product_id' },
};

async function topProducts(args) {
  const run = new Run();
  const period = resolvePeriod(args, args.days ?? 30);
  const metric = args.metric ?? 'ordered_units';
  const limit = args.limit ?? 20;
  // Observed 2026-10-26: requests carrying `sort` were rejected with 429 "rate limit per second"
  // on every attempt while the same request without `sort` succeeded, so rank locally.
  const analytics = await run.call('销量排行', '/v1/analytics/data', {
    ...period, metrics: ['ordered_units', 'revenue'], dimension: ['sku'], limit: ANALYTICS_PAGE,
  });
  const all = analytics?.result?.data ?? [];
  const index = metric === 'revenue' ? 1 : 0;
  const rows = [...all].sort((a, b) => (b.metrics?.[index] ?? 0) - (a.metrics?.[index] ?? 0)).slice(0, limit);
  if (all.length >= ANALYTICS_PAGE) {
    run.notes.push(`有销量的 SKU 超过 ${ANALYTICS_PAGE} 个，排行只在接口返回的前 ${ANALYTICS_PAGE} 个 SKU 中计算，可能不完整。`);
  }
  const skus = rows.map((r) => String(r.dimensions?.[0]?.id));
  let info = null;
  let attrs = null;
  if (skus.length) {
    [info, attrs] = await Promise.all([
      run.optional('商品详情', '/v3/product/info/list', { sku: skus }),
      args.include_attributes === false ? null
        : run.optional('商品属性', '/v4/product/info/attributes', { filter: { sku: skus, visibility: 'ALL' }, limit: skus.length }),
    ]);
  }
  const infoBySku = indexBySku(info?.items);
  const attrBySku = new Map((attrs?.result ?? []).map((a) => [String(a.sku), a]));
  const names = attrs ? await attributeNames(run, attrs.result ?? [], args.attribute_language ?? 'ZH_HANS') : new Map();
  const maxLength = args.max_attribute_length ?? 200;
  const items = rows.map((row, index) => {
    const sku = String(row.dimensions?.[0]?.id);
    const attr = attrBySku.get(sku);
    const basics = productBasics(infoBySku.get(sku));
    return {
      rank: index + 1,
      sku,
      ordered_units: row.metrics?.[0],
      revenue: row.metrics?.[1] === undefined ? undefined : round2(row.metrics[1]),
      ...basics,
      name: basics.name ?? row.dimensions?.[0]?.name,
      ...dimensions(attr),
      attributes: attr ? namedAttributes(attr, names, maxLength) : undefined,
    };
  });
  if (!rows.length) run.notes.push('该时间段没有销量数据。');
  run.notes.push(ANALYTICS_NOTE);
  return run.finish({
    period, sort_by: metric, count: items.length,
    period_totals_all_skus: analytics?.result?.totals ? { ordered_units: analytics.result.totals[0], revenue: round2(analytics.result.totals[1] ?? 0) } : undefined,
    items,
  });
}

async function productOverview(args) {
  const run = new Run();
  const limit = args.limit ?? 50;
  const filter = { visibility: args.visibility ?? 'ALL' };
  for (const [arg, field] of Object.entries({ offer_ids: 'offer_id', product_ids: 'product_id' })) {
    if (args[arg]) filter[field] = args[arg];
  }
  const list = await run.call('商品列表', '/v3/product/list', { filter, limit, ...(args.last_id ? { last_id: args.last_id } : {}) });
  const result = list?.result ?? {};
  const ids = (result.items ?? []).map((i) => String(i.product_id));
  const info = ids.length ? await run.optional('商品详情', '/v3/product/info/list', { product_id: ids }) : null;
  const byId = new Map((info?.items ?? []).map((i) => [String(i.id), i]));
  const items = (result.items ?? []).map((row) => {
    const basics = productBasics(byId.get(String(row.product_id)));
    return {
      ...basics,
      product_id: row.product_id,
      offer_id: row.offer_id,
      sku: row.sku,
      archived: row.archived ?? basics.archived,
      has_fbo_stocks: row.has_fbo_stocks,
      has_fbs_stocks: row.has_fbs_stocks,
      skus: undefined,
      description_category_id: undefined,
      type_id: undefined,
    };
  });
  const total = result.total_items ?? result.total;
  const hasMore = Boolean(result.last_id) && items.length === limit;
  return run.finish({
    visibility: filter.visibility, total, returned: items.length,
    has_more: hasMore, next_last_id: hasMore ? result.last_id : undefined,
    items,
    pagination_hint: hasMore ? '如需下一页，把 next_last_id 作为 last_id 再调用本工具。' : undefined,
  });
}

async function productDetail(args) {
  const run = new Run();
  const given = Object.keys(ID_TYPES).filter((k) => args[k]);
  if (given.length !== 1) throw new Error('offer_ids、skus、product_ids 必须且只能填写一种。');
  const key = given[0];
  const field = ID_TYPES[key];
  const info = await run.call('商品详情', '/v3/product/info/list', { [field]: args[key] });
  const products = info?.items ?? [];
  if (!products.length) return run.finish({ count: 0, items: [], hint: '没有找到对应商品，请核对标识符类型（货号/SKU/product_id）。' });
  const productIds = products.map((p) => String(p.id));
  const skus = [...new Set(products.flatMap((p) => (p.sources ?? []).map((s) => String(s.sku))))];
  const [attrs, prices, fbs, fbo] = await Promise.all([
    run.optional('商品属性', '/v4/product/info/attributes', { filter: { product_id: productIds, visibility: 'ALL' }, limit: productIds.length }),
    run.optional('价格与佣金', '/v5/product/info/prices', { filter: { product_id: productIds, visibility: 'ALL' }, limit: productIds.length }),
    skus.length ? run.optional('FBS 分仓库存', '/v2/product/info/stocks-by-warehouse/fbs', { sku: skus, limit: 1000 }) : null,
    skus.length ? run.optional('FBO 分仓库存', '/v1/product/info/stocks-by-warehouse/fbo', { skus, limit: 1000 }) : null,
  ]);
  const attrById = new Map((attrs?.result ?? []).map((a) => [String(a.id), a]));
  const priceById = new Map((prices?.items ?? []).map((p) => [String(p.product_id), p]));
  const names = attrs ? await attributeNames(run, attrs.result ?? [], args.attribute_language ?? 'ZH_HANS') : new Map();
  const warehouses = (rows, scheme) => (rows ?? []).map((w) => ({
    scheme, sku: String(w.sku), warehouse: w.warehouse_name ?? w.warehouse_id, present: w.present, reserved: w.reserved,
    free: w.free_stock ?? (w.present ?? 0) - (w.reserved ?? 0),
  }));
  const allWarehouses = [...warehouses(fbs?.products, 'FBS'), ...warehouses(fbo?.products, 'FBO')];
  const items = products.map((p) => {
    const id = String(p.id);
    const attr = attrById.get(id);
    const price = priceById.get(id);
    const own = new Set((p.sources ?? []).map((s) => String(s.sku)));
    return {
      ...productBasics(p),
      images_count: (p.images ?? []).length,
      barcodes: p.barcodes,
      ...dimensions(attr),
      price_detail: price ? {
        marketing_seller_price: price.price?.marketing_seller_price,
        sales_percent: { fbo: price.commissions?.sales_percent_fbo, fbs: price.commissions?.sales_percent_fbs, rfbs: price.commissions?.sales_percent_rfbs },
        acquiring: price.acquiring, price_index: price.price_indexes?.color_index,
      } : undefined,
      warehouses: allWarehouses.filter((w) => own.has(w.sku)),
      attributes: attr ? namedAttributes(attr, names, args.max_attribute_length ?? 500) : undefined,
    };
  });
  return run.finish({ count: items.length, items });
}

async function stockOverview(args) {
  const run = new Run();
  const threshold = args.low_stock_threshold ?? 0;
  const maxItems = args.max_items ?? 50;
  const all = [];
  let cursor;
  let total;
  for (let page = 0; page < 20; page += 1) {
    const data = await run.call(`库存第 ${page + 1} 页`, '/v4/product/info/stocks',
      { filter: { visibility: args.visibility ?? 'ALL' }, limit: 1000, ...(cursor ? { cursor } : {}) });
    const items = data?.items ?? [];
    all.push(...items);
    total = data?.total_items ?? data?.total;
    cursor = data?.cursor;
    if (!cursor || items.length < 1000 || (total !== undefined && all.length >= total)) break;
  }
  const byType = {};
  const rows = all.map((item) => {
    const stocks = {};
    let free = 0;
    for (const s of item.stocks ?? []) {
      stocks[s.type] ??= { present: 0, reserved: 0 };
      stocks[s.type].present += s.present ?? 0;
      stocks[s.type].reserved += s.reserved ?? 0;
      byType[s.type] ??= { present: 0, reserved: 0 };
      byType[s.type].present += s.present ?? 0;
      byType[s.type].reserved += s.reserved ?? 0;
      free += (s.present ?? 0) - (s.reserved ?? 0);
    }
    return { product_id: item.product_id, offer_id: item.offer_id, sku: item.stocks?.[0]?.sku, available_estimate: free, stocks };
  });
  const problems = rows.filter((r) => r.available_estimate <= threshold);
  const pool = (args.only_problem ?? true) ? problems : rows;
  const selected = [...pool].sort((a, b) => a.available_estimate - b.available_estimate).slice(0, maxItems);
  if (selected.length) {
    const info = await run.optional('商品名称', '/v3/product/info/list', { product_id: selected.map((r) => String(r.product_id)) });
    const names = new Map((info?.items ?? []).map((i) => [String(i.id), i.name]));
    for (const row of selected) row.name = names.get(String(row.product_id));
  }
  run.notes.push('available_estimate = present − reserved（/v4/product/info/stocks 口径，按方案相加），不是仓库级 free_stock；分仓明细用 ozon_product_detail。');
  return run.finish({
    summary: {
      products: rows.length, total_reported: total, complete: total === undefined || rows.length >= total,
      zero_or_negative: rows.filter((r) => r.available_estimate <= 0).length,
      at_or_below_threshold: problems.length, threshold, by_type: byType,
    },
    listed: (args.only_problem ?? true) ? `库存 ≤ ${threshold} 的商品，按可售量升序，最多 ${maxItems} 条` : `全部商品按可售量升序，最多 ${maxItems} 条`,
    items: selected,
  });
}

const STATUS_LABELS = {
  awaiting_registration: '待登记', acceptance_in_progress: '验收中', awaiting_approve: '待确认', awaiting_packaging: '待打包',
  awaiting_deliver: '待发运', awaiting_verification: '待核验', arbitration: '仲裁中', client_arbitration: '客户仲裁',
  delivering: '配送中', driver_pickup: '司机取件中', delivered: '已送达', cancelled: '已取消', not_accepted: '分拣中心未接收',
  sent_by_seller: '卖家已发出',
};

// Cursor pagination is sequential, so split the period into windows and page them concurrently.
function windows(period) {
  const start = Date.parse(period.date_from + 'T00:00:00Z');
  const end = Date.parse(period.date_to + 'T00:00:00Z') + DAY;
  const step = Math.ceil((end - start) / DAY / 31) * DAY;
  const out = [];
  for (let t = start; t < end; t += step) out.push([new Date(t).toISOString(), new Date(Math.min(t + step, end)).toISOString()]);
  return out;
}

const POSTING_CONCURRENCY = 4;

async function fetchPostings(run, scheme, endpoint, period, statuses, maxPostings) {
  const started = performance.now();
  // Newest windows first, so a capped run covers the most recent postings.
  const queue = windows(period).reverse();
  const seen = new Map();
  let pages = 0;
  let capped = false;
  let failure = null;
  async function worker() {
    try {
      while (queue.length && !capped && !failure) {
        const [since, to] = queue.shift();
        const filter = { since, to, ...(statuses?.length ? { statuses } : {}) };
        let cursor;
        while (!failure) {
          if (seen.size >= maxPostings) {
            capped = true;
            return;
          }
          const data = await run.call(null, endpoint, { filter, limit: 100, ...(cursor ? { cursor } : {}) });
          pages += 1;
          for (const p of data?.postings ?? []) seen.set(p.posting_number, p);
          if (!(data?.has_next && data?.cursor)) break;
          cursor = data.cursor;
        }
      }
    } catch (error) {
      failure ??= error; // stop the other workers instead of letting them keep paging
    }
  }
  await Promise.all(Array.from({ length: Math.min(POSTING_CONCURRENCY, queue.length) }, worker));
  if (failure) throw failure;
  run.timing_ms[`${scheme} 货件（${pages} 页）`] = Math.round(performance.now() - started);
  const newestFirst = [...seen.values()].sort((a, b) =>
    String(b.in_process_at ?? b.created_at ?? '').localeCompare(String(a.in_process_at ?? a.created_at ?? '')));
  return { postings: newestFirst.slice(0, maxPostings), complete: !capped && seen.size <= maxPostings };
}

function summarize(postings) {
  const byStatus = {};
  const amount = {};
  let units = 0;
  for (const p of postings) {
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    if (p.status === 'cancelled') continue;
    for (const item of p.products ?? []) {
      units += item.quantity ?? 0;
      const currency = item.price?.currency ?? item.currency_code ?? 'unknown';
      amount[currency] = round2((amount[currency] ?? 0) + (num(item.price?.amount ?? item.price) ?? 0) * (item.quantity ?? 0));
    }
  }
  return {
    postings: postings.length,
    by_status: Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([status, count]) => ({ status, label: STATUS_LABELS[status] ?? status, count })),
    units_excluding_cancelled: units,
    amount_excluding_cancelled: amount,
  };
}

async function ordersOverview(args) {
  const run = new Run();
  const period = resolvePeriod(args, args.days ?? 7);
  const schemes = args.schemes ?? ['fbs', 'fbo'];
  const maxPostings = args.max_postings ?? 5000;
  const [fbs, fbo] = await Promise.all([
    schemes.includes('fbs') ? fetchPostings(run, 'FBS', '/v4/posting/fbs/list', period, args.statuses, maxPostings) : null,
    schemes.includes('fbo') ? fetchPostings(run, 'FBO', '/v3/posting/fbo/list', period, args.statuses, maxPostings) : null,
  ]);
  const tagged = [...(fbs?.postings ?? []).map((p) => ({ ...p, scheme: 'FBS' })), ...(fbo?.postings ?? []).map((p) => ({ ...p, scheme: 'FBO' }))];
  const products = new Map();
  const reasons = new Map();
  for (const p of tagged) {
    if (p.status === 'cancelled') {
      const reason = p.cancellation?.cancel_reason ?? (p.cancel_reason_id ? `原因 ID ${p.cancel_reason_id}` : '未注明');
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      continue;
    }
    for (const item of p.products ?? []) {
      const row = products.get(item.sku) ?? { sku: item.sku, offer_id: item.offer_id, name: item.name, units: 0, postings: 0 };
      row.units += item.quantity ?? 0;
      row.postings += 1;
      products.set(item.sku, row);
    }
  }
  const listLimit = args.list_limit ?? 20;
  const recent = [...tagged].sort((a, b) => String(b.in_process_at ?? b.created_at).localeCompare(String(a.in_process_at ?? a.created_at)))
    .slice(0, listLimit).map((p) => ({
      posting_number: p.posting_number, scheme: p.scheme, status: STATUS_LABELS[p.status] ?? p.status,
      in_process_at: p.in_process_at ?? p.created_at, shipment_date: p.shipment_date,
      items: (p.products ?? []).map((i) => `${i.offer_id}×${i.quantity}`).join(', '),
      warehouse: p.delivery_method?.warehouse,
      cancel_reason: p.cancellation?.cancel_reason,
    }));
  run.notes.push('货件（posting）数不等于订单数：一个订单可拆成多个货件。金额为商品售价 × 数量，不含取消货件，按币种分别合计。');
  for (const [name, part] of [['FBS', fbs], ['FBO', fbo]]) {
    if (part && !part.complete) run.notes.push(`${name} 货件超过 max_postings=${maxPostings}，统计只覆盖最近的 ${part.postings.length} 个；需要完整统计请调大 max_postings 或缩短日期范围。`);
  }
  return run.finish({
    period,
    fbs: fbs ? { ...summarize(fbs.postings), complete: fbs.complete } : undefined,
    fbo: fbo ? { ...summarize(fbo.postings), complete: fbo.complete } : undefined,
    top_products: [...products.values()].sort((a, b) => b.units - a.units).slice(0, 10),
    cancel_reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason, count })),
    recent_postings: recent,
  });
}

async function salesOverview(args) {
  const run = new Run();
  const period = resolvePeriod(args, args.days ?? 30);
  const groupBy = args.group_by ?? 'day';
  const [analytics, balance] = await Promise.all([
    run.call('销量趋势', '/v1/analytics/data', { ...period, metrics: ['ordered_units', 'revenue'], dimension: [groupBy], limit: 1000 }),
    args.include_finance === false ? null : run.optional('财务余额', '/v1/finance/balance', period),
  ]);
  const series = (analytics?.result?.data ?? [])
    .map((r) => ({ period: r.dimensions?.[0]?.id, ordered_units: r.metrics?.[0], revenue: round2(r.metrics?.[1] ?? 0) }))
    .sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const totals = analytics?.result?.totals;
  let finance;
  if (balance) {
    const services = [...(balance.cashflows?.services ?? [])].sort((a, b) => Math.abs(b.amount?.value ?? 0) - Math.abs(a.amount?.value ?? 0));
    finance = { ...balance, cashflows: { ...balance.cashflows, services: services.slice(0, 12) } };
    if (services.length > 12) run.notes.push(`财务服务费共 ${services.length} 项，只列出金额最大的 12 项。`);
  }
  run.notes.push(ANALYTICS_NOTE);
  return run.finish({
    period, group_by: groupBy,
    totals: totals ? { ordered_units: totals[0], revenue: round2(totals[1] ?? 0) } : undefined,
    series, finance,
  });
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const obj = (properties) => ({ type: 'object', properties, additionalProperties: false });

export const COMPOSITE_TOOLS = [
  {
    name: 'ozon_top_products',
    description: '【一次调用】销量/营收 Top N 商品：排行 + 商品详情（价格、库存、状态）+ 中文属性。回答“销量最高的 N 个商品/爆款/卖得最好”时优先用它，不要逐个调用底层接口。'
      + '⚠ 限流：内部调用 /v1/analytics/data（官方 1 次/分钟、50 次/天），调用前告知用户；相同参数 5 分钟内返回缓存。',
    inputSchema: obj({
      ...periodProps,
      days: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: '未填 date_from 时统计最近多少天' },
      metric: { type: 'string', enum: ['ordered_units', 'revenue'], default: 'ordered_units', description: '排序指标：销量或营收' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      include_attributes: { type: 'boolean', default: true },
      attribute_language: langProp,
      max_attribute_length: { type: 'integer', minimum: 20, maximum: 2000, default: 200, description: '单个属性值最大字符数' },
    }),
    annotations: RO,
    handler: topProducts,
  },
  {
    name: 'ozon_product_overview',
    description: '【一次调用】商品列表 + 详情：名称、货号、SKU、状态、价格、FBO/FBS 库存。查“商品列表/有哪些商品/在售商品”时用它，支持分页。',
    inputSchema: obj({
      visibility: { type: 'string', enum: ['ALL', 'VISIBLE', 'INVISIBLE', 'EMPTY_STOCK', 'NOT_MODERATED', 'MODERATED', 'DISABLED', 'STATE_FAILED', 'READY_TO_SUPPLY', 'IN_SALE', 'REMOVED_FROM_SALE', 'ARCHIVED'], default: 'ALL' },
      offer_ids: { ...idProps.offer_ids, maxItems: 1000 },
      product_ids: { ...idProps.product_ids, maxItems: 1000 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      last_id: { type: 'string', description: '上一页返回的 next_last_id' },
    }),
    annotations: RO,
    handler: productOverview,
  },
  {
    name: 'ozon_product_detail',
    description: '【一次调用】指定商品的完整信息：详情 + 中文属性 + 尺寸重量 + 价格/佣金 + FBS/FBO 分仓库存。offer_ids、skus、product_ids 三选一，最多 20 个。',
    inputSchema: obj({ ...idProps, attribute_language: langProp, max_attribute_length: { type: 'integer', minimum: 20, maximum: 5000, default: 500 } }),
    annotations: RO,
    handler: productDetail,
  },
  {
    name: 'ozon_stock_overview',
    description: '【一次调用】全店库存汇总：各方案现有/预留合计、零库存与低库存商品清单（含名称）。查“库存情况/缺货/低库存/哪些要补货”时用它。',
    inputSchema: obj({
      visibility: { type: 'string', enum: ['ALL', 'VISIBLE', 'INVISIBLE', 'EMPTY_STOCK', 'NOT_MODERATED', 'MODERATED', 'DISABLED', 'STATE_FAILED'], default: 'ALL' },
      low_stock_threshold: { type: 'integer', minimum: 0, default: 0, description: '可售量 ≤ 该值视为问题商品' },
      only_problem: { type: 'boolean', default: true, description: 'true 只列问题商品；false 列全部（按可售量升序）' },
      max_items: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
    }),
    annotations: RO,
    handler: stockOverview,
  },
  {
    name: 'ozon_orders_overview',
    description: '【一次调用】时间段内 FBS + FBO 货件汇总：按状态计数、件数、金额（按币种）、热销商品、取消原因、最近货件。查“最近订单/发货情况/取消原因”时用它。',
    inputSchema: obj({
      ...periodProps,
      days: { type: 'integer', minimum: 1, maximum: 365, default: 7 },
      schemes: { type: 'array', items: { type: 'string', enum: ['fbs', 'fbo'] }, minItems: 1, default: ['fbs', 'fbo'] },
      statuses: { type: 'array', items: { type: 'string' }, description: '只统计这些状态，例如 awaiting_packaging、delivering' },
      max_postings: { type: 'integer', minimum: 1, maximum: 20000, default: 5000, description: '每种方案最多读取的货件数（按天并行翻页）' },
      list_limit: { type: 'integer', minimum: 0, maximum: 100, default: 20 },
    }),
    annotations: RO,
    handler: ordersOverview,
  },
  {
    name: 'ozon_sales_overview',
    description: '【一次调用】经营概览：按天/周/月的销量与营收趋势 + 合计，并附同期财务余额（期初/期末、销售、退货、各项服务费）。查“最近卖了多少/营收趋势/经营情况”时用它。'
      + '⚠ 限流：内部调用 /v1/analytics/data（官方 1 次/分钟、50 次/天），与 ozon_top_products 共用额度，调用前告知用户。',
    inputSchema: obj({
      ...periodProps,
      days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
      group_by: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' },
      include_finance: { type: 'boolean', default: true },
    }),
    annotations: RO,
    handler: salesOverview,
  },
];
