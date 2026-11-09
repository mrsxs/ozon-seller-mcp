// One-call funnel analysis for pay-per-click (CPC) campaigns:
// views → clicks (CTR) → add-to-cart → orders, with spend, CPC, cost per order and DRR.
//
// Campaign totals come from /api/client/statistics/campaign/product/json (synchronous, no report quota).
// Product rows come from the asynchronous campaign report (/api/client/statistics/json): it covers any
// period up to 62 days and includes products already removed from a campaign. The synchronous
// /api/client/statistics/products/sku only accepts today or yesterday (live check 2026-11-09).
import { sleep } from '../http.js';
import { adsRequest } from './http.js';

const DAY = 86_400_000;
const MOSCOW_OFFSET = 3 * 3_600_000;
const MICRO_RUB = 1_000_000;
const MAX_DAYS = 62;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const CONCURRENCY = 4;
const CAMPAIGN_STATS_BATCH = 50;
const REPORT_BATCH = 10; // official: at most 10 campaigns per report
// Report polling: every 3 s, at most 90 s in total for all batches of one tool call.
const DEFAULT_REPORT_TIMING = Object.freeze({ pollMs: 3000, waitMs: 90_000 });
let reportTiming = DEFAULT_REPORT_TIMING;
export function setReportTimingForTests(timing) {
  reportTiming = { ...DEFAULT_REPORT_TIMING, ...timing };
}
const FIELDS = ['views', 'clicks', 'toCart', 'orders', 'sales', 'expense', 'modelOrders', 'modelSales'];

export const DEFAULT_THRESHOLDS = Object.freeze({ target_drr: 30, min_views: 1000, min_clicks: 100, low_ctr_ratio: 0.7 });

// Ozon's advertising cabinet groups dates by Moscow time (UTC+3, no DST).
export const moscowDate = (now = Date.now()) => new Date(now + MOSCOW_OFFSET).toISOString().slice(0, 10);
const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

function resolvePeriod(args) {
  const to = args.date_to ?? moscowDate();
  const from = args.date_from ?? shiftDate(to, -((args.days ?? 7) - 1));
  if (from > to) throw new Error('date_from 不能晚于 date_to。');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY + 1;
  if (days > MAX_DAYS) throw new Error(`统计周期 ${days} 天，超过 Performance API 的 ${MAX_DAYS} 天上限；请缩短日期范围或分段查询。`);
  return { date_from: from, date_to: to };
}

// "1 234,56", "1,234.56", "1234.56" and 1234.56 all mean the same amount; a missing value counts as 0.
export function amount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined || value === '') return 0;
  const compact = String(value).replace(/[\s\u00a0]/g, '');
  // With both separators the comma groups thousands; alone it is the decimal mark (Ozon's format).
  const n = Number(compact.includes('.') ? compact.replaceAll(',', '') : compact.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

const round2 = (v) => Math.round(v * 100) / 100;
const ratio = (part, whole, scale = 1) => (whole > 0 ? round2((part / whole) * scale) : null);
const rubles = (micro) => (micro === undefined || micro === null || micro === '' ? undefined : round2(amount(micro) / MICRO_RUB));
const emptyTotals = () => Object.fromEntries(FIELDS.map((f) => [f, 0]));
const addTotals = (a, b) => Object.fromEntries(FIELDS.map((f) => [f, a[f] + b[f]]));

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));
}

// Runs fn over items with at most `limit` requests in flight; results keep the input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Orders and sales include other variants of the same model, as Ozon's cabinet and its official
// DRR do (checked live: campaign orders = product orders + models for every campaign).
function funnel(t) {
  const orders = t.orders + t.modelOrders;
  const sales = t.sales + t.modelSales;
  return {
    views: t.views,
    clicks: t.clicks,
    ctr_pct: ratio(t.clicks, t.views, 100),
    to_cart: t.toCart,
    cart_rate_pct: ratio(t.toCart, t.clicks, 100),
    orders,
    order_rate_pct: ratio(orders, t.clicks, 100),
    sales: round2(sales),
    expense: round2(t.expense),
    avg_cpc: ratio(t.expense, t.clicks),
    cpa: ratio(t.expense, orders),
    drr_pct: ratio(t.expense, sales, 100),
    model_orders: t.modelOrders || undefined,
    model_sales: t.modelSales ? round2(t.modelSales) : undefined,
  };
}

function productFlags(p, campaignCtr, th) {
  const flags = [];
  if (p.views > 0 && p.views < th.min_views) {
    flags.push(`样本少（展示 ${p.views} < ${th.min_views}），点击率暂不下结论`);
  } else if (campaignCtr && p.ctr_pct !== null && p.ctr_pct < campaignCtr * th.low_ctr_ratio) {
    flags.push(`点击率 ${p.ctr_pct}% 明显低于本活动均值 ${campaignCtr}%：先优化主图、价格、标题`);
  }
  if (p.clicks >= th.min_clicks && p.orders === 0) flags.push(`点击 ${p.clicks} 次无订单：检查详情页、价格、评价、配送时效`);
  if (p.drr_pct !== null && p.drr_pct > th.target_drr) flags.push(`DRR ${p.drr_pct}% 高于目标 ${th.target_drr}%`);
  return flags;
}

function campaignFlags(c, th) {
  const flags = [];
  if (c.drr_pct !== null && c.drr_pct > th.target_drr) flags.push(`DRR ${c.drr_pct}% 高于目标 ${th.target_drr}%`);
  if (c.expense > 0 && c.orders === 0) flags.push('有花费无订单');
  return flags;
}

class Run {
  notes = [];
  timing_ms = {};
  sources = new Set();
  started = performance.now();

  async call(label, endpoint, options) {
    const t = performance.now();
    this.sources.add(endpoint);
    try {
      return (await adsRequest(endpoint, options)).data;
    } finally {
      this.timing_ms[label] = (this.timing_ms[label] ?? 0) + Math.round(performance.now() - t);
    }
  }

  finish(payload) {
    this.timing_ms.total = Math.round(performance.now() - this.started);
    return { ...payload, notes: this.notes, timing_ms: this.timing_ms, sources: [...this.sources] };
  }
}

// The spec gives page/pageSize but no total: read until a page is empty, shorter than the first one,
// or adds nothing new (a server that ignores paging). Returns the items and whether the page cap cut it short.
async function readPages(fetchPage, keyOf) {
  const seen = new Map();
  let firstLength = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const items = (await fetchPage(page)) ?? [];
    const before = seen.size;
    for (const item of items) seen.set(keyOf(item), item);
    if (page === 1) firstLength = items.length;
    if (!items.length || items.length < firstLength || seen.size === before) return { items: [...seen.values()], complete: true };
  }
  return { items: [...seen.values()], complete: false };
}

async function listCampaigns(run, args) {
  const wanted = args.campaign_ids?.map(String);
  const filter = { advObjectType: 'SKU', ...(wanted ? { campaignIds: wanted } : {}) };
  const { items, complete } = await readPages(async (page) => (await run.call('活动列表', '/api/client/campaign',
    { params: { ...filter, page, pageSize: PAGE_SIZE } }))?.list, (c) => String(c.id));
  if (!complete) run.notes.push(`活动超过 ${MAX_PAGES * PAGE_SIZE} 个，只统计了前 ${items.length} 个，totals 偏小；请用 campaign_ids 缩小范围。`);
  if (wanted) {
    const known = new Set(items.map((c) => String(c.id)));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length) run.notes.push(`未找到这些按点击付费活动：${missing.join(', ')}（可能不是 CPC 活动或 ID 有误）。`);
    return { complete, campaigns: items.filter((c) => wanted.includes(String(c.id))) };
  }
  return { complete, campaigns: items.filter((c) => args.include_archived || c.state !== 'CAMPAIGN_STATE_ARCHIVED') };
}

const campaignTotals = (row) => ({
  views: amount(row.views), clicks: amount(row.clicks), toCart: amount(row.toCart), orders: amount(row.orders),
  sales: amount(row.ordersMoney), expense: amount(row.moneySpent), modelOrders: 0, modelSales: 0,
});

async function fetchCampaignTotals(run, ids, period) {
  const pages = await mapLimit(chunks(ids, CAMPAIGN_STATS_BATCH), CONCURRENCY, (batch) => run.call('活动统计',
    '/api/client/statistics/campaign/product/json', { params: { campaignIds: batch, dateFrom: period.date_from, dateTo: period.date_to } }));
  return new Map(pages.flatMap((page) => page?.rows ?? []).map((row) => [String(row.id), campaignTotals(row)]));
}

async function waitForReport(run, uuid, deadline) {
  for (;;) {
    const status = await run.call('等待商品报表', '/api/client/statistics/{UUID}', { params: { UUID: uuid } });
    if (status?.state === 'OK') return { ready: true };
    if (status?.state === 'ERROR') return { ready: false, reason: `生成失败：${status.error ?? 'Ozon 未说明原因'}` };
    if (Date.now() + reportTiming.pollMs > deadline) {
      return { ready: false, reason: `在 ${Math.round(reportTiming.waitMs / 1000)} 秒内未生成完（状态 ${status?.state ?? '未知'}）` };
    }
    await sleep(reportTiming.pollMs);
  }
}

const productTotals = (row) => ({
  views: amount(row.views), clicks: amount(row.clicks), toCart: amount(row.toCart), orders: amount(row.orders),
  sales: amount(row.ordersMoney), expense: amount(row.moneySpent), modelOrders: amount(row.models), modelSales: amount(row.modelsMoney),
});

// The JSON report is keyed by campaign ID: { "<id>": { title, report: { rows: [...] } } }.
// An unkeyed { report } is only attributable when the batch has a single campaign.
function reportRows(data, batch) {
  const entries = data?.report
    ? (batch.length === 1 ? [[batch[0], data]] : [])
    : Object.entries(data ?? {}).filter(([, entry]) => entry?.report);
  if (!entries.length) return null;
  return entries.flatMap(([campaignId, entry]) => (entry.report.rows ?? []).map((row) => ({ campaignId: String(campaignId), row })));
}

async function reportBatch(run, batch, period, deadline) {
  const submitted = await run.call('生成商品报表', '/api/client/statistics/json',
    { method: 'POST', body: { campaigns: batch, dateFrom: period.date_from, dateTo: period.date_to, groupBy: 'NO_GROUP_BY' } });
  const uuid = submitted?.UUID;
  if (!uuid) throw new Error('Ozon 未返回商品报表的 UUID');
  const { ready, reason } = await waitForReport(run, uuid, deadline);
  if (!ready) {
    throw new Error(`商品报表${reason}；稍后可用 ozon_ads_api_call 查 /api/client/statistics/{UUID}（UUID=${uuid}），状态为 OK 后调用 /api/client/statistics/report 下载`);
  }
  const rows = reportRows(await run.call('下载商品报表', '/api/client/statistics/report', { params: { UUID: uuid } }), batch);
  if (!rows) throw new Error(`商品报表为空或不是预期的 JSON 格式（UUID=${uuid}）`);
  return rows;
}

// Reports run one at a time per account (official limit), so batches go strictly in sequence.
// A failure keeps what was fetched and names every campaign left without product rows.
async function fetchProductRows(run, ids, period) {
  const rows = [];
  const deadline = Date.now() + reportTiming.waitMs;
  const batches = chunks(ids, REPORT_BATCH);
  for (const [index, batch] of batches.entries()) {
    try {
      for (const row of await reportBatch(run, batch, period, deadline)) rows.push(row);
    } catch (error) {
      run.notes.push(`${error.message}。以下活动没有商品明细：${batches.slice(index).flat().join(', ')}。`);
      return { rows, complete: false };
    }
  }
  return { rows, complete: true };
}

function aggregateProducts(rows) {
  const byProduct = new Map();
  for (const { campaignId, row } of rows) {
    const key = `${campaignId}:${row.sku}`;
    const previous = byProduct.get(key) ?? { campaignId, sku: String(row.sku), totals: emptyTotals() };
    byProduct.set(key, {
      ...previous,
      totals: addTotals(previous.totals, productTotals(row)),
      title: row.title ?? previous.title,
      price: row.price ?? previous.price,
      // GMV is per product and repeats on every row of the same product, so it is not summed.
      gmv: row.product_gmv ?? previous.gmv,
      added: row.createdAt ?? previous.added,
    });
  }
  return [...byProduct.values()];
}

function campaignRow(meta, totals, th) {
  const row = {
    id: String(meta.id),
    title: meta.title,
    state: meta.state,
    placement: meta.placement,
    strategy: meta.productAutopilotStrategy,
    weekly_budget_rub: rubles(meta.weeklyBudget),
    daily_budget_rub: rubles(meta.dailyBudget) || undefined,
    ...funnel(totals ?? emptyTotals()),
  };
  return { ...row, flags: campaignFlags(row, th) };
}

function productRow(p, campaign, th) {
  const row = {
    campaign_id: p.campaignId,
    campaign_title: campaign?.title,
    sku: p.sku,
    title: p.title,
    price: p.price === undefined ? undefined : amount(p.price),
    ...funnel(p.totals),
    // Spend against all sales of the product, organic included (Ozon's general_drr).
    drr_total_pct: ratio(p.totals.expense, amount(p.gmv), 100) ?? undefined,
    // Ozon reports 0001-01-01 as the added date of products no longer in the campaign.
    removed_from_campaign: p.added?.startsWith('0001-') || undefined,
  };
  return { ...row, flags: productFlags(row, campaign?.ctr_pct, th) };
}

export async function adsStats(args) {
  const run = new Run();
  const period = resolvePeriod(args);
  const th = Object.fromEntries(Object.entries(DEFAULT_THRESHOLDS).map(([key, fallback]) => [key, args[key] ?? fallback]));
  const { complete: campaignsComplete, campaigns } = await listCampaigns(run, args);
  if (!campaigns.length) {
    run.notes.push('没有找到按点击付费（CPC）活动。');
    return run.finish({ period, currency: 'RUB', campaigns: [], products: [] });
  }
  const totalsById = await fetchCampaignTotals(run, campaigns.map((c) => String(c.id)), period);
  const campaignRows = campaigns.map((c) => campaignRow(c, totalsById.get(String(c.id)), th)).sort((a, b) => b.expense - a.expense);
  const total = campaignRows.reduce((sum, c) => addTotals(sum, totalsById.get(c.id) ?? emptyTotals()), emptyTotals());

  // Campaigns without views or spend have no product rows; skipping them saves report quota.
  const active = campaignRows.filter((c) => c.views > 0 || c.expense > 0).map((c) => c.id);
  const report = args.include_products === false || !active.length ? { rows: [], complete: true } : await fetchProductRows(run, active, period);
  const productRows = report.rows;
  const campaignById = new Map(campaignRows.map((c) => [c.id, c]));
  const products = aggregateProducts(productRows)
    .map((p) => productRow(p, campaignById.get(p.campaignId), th))
    .sort((a, b) => b.expense - a.expense);

  const limit = args.product_limit ?? 50;
  if (products.length > limit) run.notes.push(`商品共 ${products.length} 行，按花费只列前 ${limit} 行；可调大 product_limit 或用 campaign_ids 缩小范围。`);
  if (productRows.length) {
    run.notes.push('商品明细来自异步报表（官方：同一账号同时只能生成 1 个、每天有次数上限），包含本期内已移出活动的商品（removed_from_campaign）。');
  }
  run.notes.push('金额单位卢布，日期按莫斯科时间；最近 1–2 天的订单会因归因延迟继续增加。orders/sales 与后台「已售商品数量 / 推广带来的销售额」一致，含同款其他变体；其中变体部分是 model_orders/model_sales。');
  run.notes.push(`DRR = 花费 ÷ 广告带来的销售额；drr_total_pct = 花费 ÷ 该商品全部销售额。flags 按 target_drr=${th.target_drr}% 判断，应按商品毛利率调整；`
    + `展示少于 ${th.min_views} 次不评判点击率，点击少于 ${th.min_clicks} 次不评判转化。`);
  return run.finish({
    period,
    currency: 'RUB',
    thresholds: th,
    totals: funnel(total),
    campaigns_complete: campaignsComplete,
    campaigns: campaignRows,
    products_complete: report.complete,
    products_total: products.length,
    products: products.slice(0, limit),
  });
}
