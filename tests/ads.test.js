// Ozon Performance API (advertising): registry, auth, transport, CSV reports, CTR analysis.
import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseCsv } from '../src/ads/csv.js';
import { adsRequest } from '../src/ads/http.js';
import { adsBodySchema, adsParamsSchema } from '../src/ads/schema.js';
import { ADS_OPERATIONS, ADS_SPEC, READ_ONLY_IDS, WRITE_IDS, findAdsOperation } from '../src/ads/spec.js';
import { amount, moscowDate, setReportTimingForTests } from '../src/ads/stats.js';
import { ReadOnlyError, ValidationError } from '../src/errors.js';
import { setFetchForTests } from '../src/http.js';
import { callTool, listTools } from '../src/tools.js';
import { PERF_ID, PERF_SECRET, json, mockOzon, parse, withEnv } from './helpers.js';

const TOKEN = '/api/client/token';
const tokenRoute = (counter) => () => {
  counter.n += 1;
  return { access_token: `tok-${counter.n}`, expires_in: 1800, token_type: 'Bearer' };
};

test('ads: every official operation is registered and explicitly classified', () => {
  const official = [];
  for (const item of Object.values(ADS_SPEC.paths)) {
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) if (item[m]) official.push(item[m].operationId);
  }
  assert.equal(official.length, 48);
  assert.deepEqual(new Set([...READ_ONLY_IDS, ...WRITE_IDS]), new Set(official));
  assert.equal([...READ_ONLY_IDS].filter((id) => WRITE_IDS.has(id)).length, 0);
  // The 12 `/json` report variants are named in the official descriptions.
  assert.equal(ADS_OPERATIONS.length, 48 + 12);
  assert.equal(findAdsOperation('/api/client/statistics/daily/json', 'GET').read_only, true);
  // A GET that switches promotion on is still a write.
  assert.equal(findAdsOperation('/api/client/campaign/all_sku_promo/activate', 'GET').read_only, false);
  const meta = new Ajv2020({ strict: false });
  for (const op of ADS_OPERATIONS) {
    assert.ok(meta.validateSchema(adsParamsSchema(op)), op.path);
    const body = adsBodySchema(op);
    if (body) assert.ok(meta.validateSchema(body), op.path);
  }
});

test('ads: writes are blocked before any token or network call in read-only mode', async () => {
  await withEnv({ OZON_READ_ONLY: 'true' }, async () => {
    let network = 0;
    setFetchForTests(async () => {
      network += 1;
      return json({});
    });
    for (const op of ADS_OPERATIONS) {
      if (!op.read_only) await assert.rejects(adsRequest(op.path, { method: op.method }), ReadOnlyError, op.path);
    }
    assert.equal(network, 0);
  });
});

test('ads: token is fetched once, reused, and refreshed after a 401', async () => {
  await withEnv({}, async () => {
    const counter = { n: 0 };
    const calls = mockOzon({
      [TOKEN]: tokenRoute(counter),
      '/api/client/campaign': (_, n) => (n === 2 ? json({ error: 'expired' }, 401) : { list: [{ id: '1', title: 'A' }] }),
    });
    assert.equal((await adsRequest('/api/client/campaign')).data.list[0].id, '1');
    assert.equal((await adsRequest('/api/client/campaign')).data.list[0].id, '1');
    const tokenCalls = calls.filter((c) => c.path === TOKEN);
    assert.equal(tokenCalls.length, 2);
    assert.deepEqual(tokenCalls[0].body, { client_id: PERF_ID, client_secret: PERF_SECRET, grant_type: 'client_credentials' });
    const apiCalls = calls.filter((c) => c.path === '/api/client/campaign');
    assert.deepEqual(apiCalls.map((c) => c.init.headers.Authorization), ['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2']);
    assert.ok(calls.every((c) => c.url.startsWith('https://api-performance.ozon.ru/')));
    assert.ok(calls.every((c) => c.init.redirect === 'manual'));
  });
});

test('ads: bad or missing credentials give a clear error and never echo the secret', async () => {
  await withEnv({}, async () => {
    mockOzon({ [TOKEN]: () => json({ error: `invalid_client ${PERF_SECRET}` }, 401) });
    const out = await callTool('ozon_ads_api_call', { endpoint: '/api/client/campaign', method: 'GET' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /OZON_PERF_CLIENT_ID/);
    assert.ok(!out.content[0].text.includes(PERF_SECRET));
  });
  await withEnv({ OZON_PERF_CLIENT_ID: undefined, OZON_PERF_CLIENT_SECRET: undefined }, async () => {
    const calls = mockOzon({});
    const out = await callTool('ozon_ads_api_call', { endpoint: '/api/client/campaign', method: 'GET' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /OZON_PERF_CLIENT_SECRET/);
    assert.equal(calls.length, 0);
  });
});

test('ads: path and query parameters are validated, encoded, and never sent as a GET body', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon({
      [TOKEN]: tokenRoute({ n: 0 }),
      '/api/client/campaign/123/v2/products': () => ({ products: [] }),
      '/api/client/statistics/daily/json': () => ({ rows: [] }),
    });
    await adsRequest('/api/client/campaign/{campaignId}/v2/products', { params: { campaignId: '123', pageSize: 100 } });
    const products = calls.find((c) => c.path === '/api/client/campaign/123/v2/products');
    assert.equal(new URL(products.url).search, '?pageSize=100');
    await adsRequest('/api/client/statistics/daily/json', { params: { campaignIds: ['1', '2'], dateFrom: '2026-11-03', dateTo: '2026-11-09' } });
    const daily = calls.find((c) => c.path === '/api/client/statistics/daily/json');
    assert.deepEqual(new URL(daily.url).searchParams.getAll('campaignIds'), ['1', '2']);
    assert.equal(daily.init.method, 'GET');
    assert.equal(daily.init.body, undefined);

    const sent = calls.length;
    await assert.rejects(adsRequest('/api/client/statistics/{UUID}', { params: { UUID: '../campaign' } }), ValidationError);
    await assert.rejects(adsRequest('/api/client/campaign/{campaignId}/v2/products', { params: {} }), /campaignId/);
    await assert.rejects(adsRequest('/api/client/campaign', { params: { invented: 1 } }), /invented/);
    await assert.rejects(adsRequest('/api/client/campaign', { params: { state: 'RUNNING' } }), ValidationError);
    await assert.rejects(adsRequest('/api/client/statistics/products/sku', { method: 'POST', body: { campaignIds: ['1'], dateFrom: '2026/11/03' } }), ValidationError);
    await assert.rejects(adsRequest('/api/client/statistics/products/sku', { method: 'POST', body: { campaignIds: ['1'], invented: true } }), /invented/);
    await assert.rejects(adsRequest('/api/client/unknown'), /未在/);
    assert.equal(calls.length, sent, 'invalid requests must not reach the network');
  });
});

test('ads: CSV reports parse with a title line, quoted fields and semicolons', async () => {
  const text = '\uFEFFОтчёт по кампании 1\nДата;Показы;Клики;Расход, ₽\n03.11.2026;1 000;50;"12,5"\n"a;b";2;"say ""hi""";0\n';
  const out = parseCsv(text);
  assert.equal(out.title, 'Отчёт по кампании 1');
  assert.deepEqual(out.columns, ['Дата', 'Показы', 'Клики', 'Расход, ₽']);
  assert.deepEqual(out.rows[0], { Дата: '03.11.2026', Показы: '1 000', Клики: '50', 'Расход, ₽': '12,5' });
  assert.equal(out.rows[1].Дата, 'a;b');
  assert.equal(out.rows[1].Клики, 'say "hi"');
  // Decimal commas must not be mistaken for the delimiter.
  assert.deepEqual(parseCsv('Расход;CTR\n12,50;1,25\n3,10;0,90\n').rows, [{ Расход: '12,50', CTR: '1,25' }, { Расход: '3,10', CTR: '0,90' }]);
  assert.deepEqual(parseCsv('a,b\n1,2\n').rows, [{ a: '1', b: '2' }]);
  await withEnv({}, async () => {
    mockOzon({
      [TOKEN]: tokenRoute({ n: 0 }),
      '/api/client/statistics/report': () => new Response(text, { headers: { 'content-type': 'text/csv; charset=utf-8' } }),
    });
    const report = await adsRequest('/api/client/statistics/report', { params: { UUID: 'abc-1' } });
    assert.equal(report.data.format, 'csv');
    assert.equal(report.data.rows.length, 2);
  });
});

const campaignStat = (id, v) => ({ id, views: v[0], clicks: v[1], toCart: v[2], orders: v[3], ordersMoney: v[4], moneySpent: v[5] });
const reportRow = (sku, v, extra = {}) => ({ search_query: '', sku, title: `T${sku}`, price: '250,00', views: v[0], clicks: v[1], toCart: v[2],
  orders: v[3], ordersMoney: v[4], moneySpent: v[5], createdAt: '2026-10-01', ...extra });

// Ozon's real shapes (checked live 2026-11-09): comma decimals, report keyed by campaign ID.
function statsRoutes({ reportState = 'OK' } = {}) {
  const submitted = [];
  const routes = {
    [TOKEN]: tokenRoute({ n: 0 }),
    '/api/client/campaign': () => ({ list: [
      { id: '10', title: 'Hot', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU', placement: ['PLACEMENT_TOP_PROMOTION'],
        weeklyBudget: '72000000000', productAutopilotStrategy: 'NO_AUTO_STRATEGY' },
      { id: '20', title: 'New', state: 'CAMPAIGN_STATE_STOPPED', advObjectType: 'SKU' },
      { id: '30', title: 'Idle', state: 'CAMPAIGN_STATE_INACTIVE', advObjectType: 'SKU' },
    ] }),
    '/api/client/statistics/campaign/product/json': () => ({ rows: [
      campaignStat('10', ['8000', '400', '70', '30', '7500,00', '1100,00']),
      campaignStat('20', ['300', '3', '0', '0', '0,00', '20,00']),
      campaignStat('30', ['0', '0', '0', '0', '0,00', '0,00']),
    ] }),
    '/api/client/statistics/json': (body) => {
      submitted.push(body);
      return { UUID: 'u-1', vendor: false };
    },
    '/api/client/statistics/u-1': () => ({ UUID: 'u-1', state: reportState, error: reportState === 'ERROR' ? 'quota' : undefined }),
    '/api/client/statistics/report': () => ({
      10: { title: 'Кампания 10', report: { rows: [
        reportRow('111', ['3000', '300', '60', '30', '7500,00', '600,00'], { product_gmv: '12000,00' }),
        reportRow('222', ['5000', '100', '10', '0', '0,00', '500,00'], { createdAt: '0001-01-01' }),
        reportRow('444', ['0', '0', '0', '2', '500,00', '0,00'], { createdAt: '0001-01-01' }),
      ] } },
      20: { title: 'Кампания 20', report: { rows: [reportRow('333', ['300', '3', '0', '0', '0,00', '20,00'], { models: '1', modelsMoney: '100,00' })] } },
    }),
  };
  return { routes, submitted };
}

test('ozon_ads_stats: campaign totals, product funnel from the report, sorted rows and flags', async () => {
  await withEnv({}, async () => {
    const { routes, submitted } = statsRoutes();
    const calls = mockOzon(routes);
    const result = await callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' });
    assert.equal(result.isError, undefined, result.content[0].text);
    const out = parse(result);
    assert.equal(new URL(calls.find((c) => c.path === '/api/client/campaign').url).searchParams.get('advObjectType'), 'SKU');
    const statsQuery = new URL(calls.find((c) => c.path === '/api/client/statistics/campaign/product/json').url).searchParams;
    assert.deepEqual([statsQuery.getAll('campaignIds'), statsQuery.get('dateFrom'), statsQuery.get('dateTo')], [['10', '20', '30'], '2026-11-03', '2026-11-09']);
    // The idle campaign is left out of the report to save quota.
    assert.deepEqual(submitted, [{ campaigns: ['10', '20'], dateFrom: '2026-11-03', dateTo: '2026-11-09', groupBy: 'NO_GROUP_BY' }]);

    const hot = out.campaigns.find((c) => c.id === '10');
    assert.deepEqual(
      [hot.views, hot.clicks, hot.ctr_pct, hot.expense, hot.drr_pct, hot.weekly_budget_rub, hot.title],
      [8000, 400, 5, 1100, 14.67, 72000, 'Hot'],
    );
    assert.equal(out.campaigns[0].id, '10', 'campaigns are sorted by spend');
    const grass = out.products.find((p) => p.sku === '111');
    assert.deepEqual(
      [grass.title, grass.campaign_title, grass.views, grass.ctr_pct, grass.cart_rate_pct, grass.order_rate_pct, grass.cpa, grass.avg_cpc, grass.drr_pct, grass.drr_total_pct],
      ['T111', 'Hot', 3000, 10, 20, 10, 20, 2, 8, 5],
    );
    const tree = out.products.find((p) => p.sku === '222');
    assert.equal(tree.removed_from_campaign, true);
    assert.ok(tree.flags.some((f) => /点击率 2%/.test(f)), JSON.stringify(tree.flags));
    assert.ok(tree.flags.some((f) => /无订单/.test(f)), JSON.stringify(tree.flags));
    const variant = out.products.find((p) => p.sku === '333');
    assert.ok(variant.flags.some((f) => /样本/.test(f)));
    // Other variants of the model count, as in Ozon's cabinet and official DRR.
    assert.deepEqual([variant.orders, variant.sales, variant.model_orders, variant.drr_pct, variant.cpa], [1, 100, 1, 20, 20]);
    assert.deepEqual(out.products.find((p) => p.sku === '444').flags ?? [], [], 'a removed product with late orders and no views is not flagged');
    assert.deepEqual(out.products.map((p) => p.sku), ['111', '222', '333', '444'], 'products are sorted by spend');
    assert.equal(out.totals.expense, 1120);
    assert.ok(out.notes.some((n) => /已移出活动/.test(n)));
  });
});

test('ozon_ads_stats: a failed report keeps campaign totals and tells how to fetch it later', async () => {
  await withEnv({}, async () => {
    mockOzon(statsRoutes({ reportState: 'ERROR' }).routes);
    const out = parse(await callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' }));
    assert.equal(out.campaigns.find((c) => c.id === '10').clicks, 400);
    assert.equal(out.products_complete, false);
    assert.equal(out.products_total, 0);
    assert.ok(out.notes.some((n) => /quota/.test(n) && /u-1/.test(n)), JSON.stringify(out.notes));
  });
});

test('ozon_ads_stats: report submission errors and odd formats keep campaign totals', async () => {
  await withEnv({}, async () => {
    const { routes } = statsRoutes();
    mockOzon({ ...routes, '/api/client/statistics/json': () => json({ error: 'another report is in progress' }, 400) });
    const result = await callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' });
    assert.equal(result.isError, undefined, result.content[0].text);
    const out = parse(result);
    assert.equal(out.campaigns.find((c) => c.id === '10').clicks, 400);
    assert.equal(out.products_complete, false);
    assert.ok(out.notes.some((n) => /in progress/.test(n) && /10, 20/.test(n)), JSON.stringify(out.notes));
  });
  await withEnv({}, async () => {
    const { routes } = statsRoutes();
    mockOzon({ ...routes, '/api/client/statistics/report': () => new Response('a;b\n1;2\n', { headers: { 'content-type': 'text/csv' } }) });
    const out = parse(await callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' }));
    assert.equal(out.products_complete, false);
    assert.ok(out.notes.some((n) => /不是预期的 JSON/.test(n)), JSON.stringify(out.notes));
  });
});

test('ozon_ads_stats: when the report wait runs out, every remaining campaign is named', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 1, waitMs: 40 });
    try {
      const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
      const submitted = [];
      mockOzon({
        [TOKEN]: tokenRoute({ n: 0 }),
        '/api/client/campaign': () => ({ list: ids.map((id) => ({ id, title: `C${id}`, state: 'CAMPAIGN_STATE_RUNNING' })) }),
        '/api/client/statistics/campaign/product/json': () => ({ rows: ids.map((id) => campaignStat(id, ['10', '1', '0', '0', '0', '1'])) }),
        '/api/client/statistics/json': (body) => {
          submitted.push(body.campaigns);
          return { UUID: 'u-1' };
        },
        '/api/client/statistics/u-1': () => ({ state: 'IN_PROGRESS' }),
      });
      const out = parse(await callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' }));
      assert.equal(submitted.length, 1, 'no further batches after the wait is used up');
      assert.equal(out.products_complete, false);
      assert.ok(out.notes.some((n) => /IN_PROGRESS/.test(n) && n.includes(ids.join(', '))), JSON.stringify(out.notes));
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ads: amounts in Ozon and international formats', () => {
  assert.deepEqual(['1 234,56', '1\u00a0234,56', '1,234.56', '1234.56', '72000,00', '', null, 'n/a'].map(amount),
    [1234.56, 1234.56, 1234.56, 1234.56, 72000, 0, 0, 0]);
});

test('ozon_ads_stats: include_products=false skips the report', async () => {
  await withEnv({}, async () => {
    const { routes, submitted } = statsRoutes();
    mockOzon(routes);
    const out = parse(await callTool('ozon_ads_stats', { include_products: false, date_from: '2026-11-03', date_to: '2026-11-09' }));
    assert.equal(submitted.length, 0);
    assert.equal(out.campaigns.length, 3);
  });
});

test('ozon_ads_stats: campaign filter and empty account', async () => {
  await withEnv({}, async () => {
    const { routes, submitted } = statsRoutes();
    const calls = mockOzon(routes);
    const out = parse(await callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09', campaign_ids: ['20'] }));
    const listQuery = new URL(calls.find((c) => c.path === '/api/client/campaign').url).searchParams;
    assert.deepEqual(listQuery.getAll('campaignIds'), ['20'], 'the filter goes to Ozon, not only applied locally');
    assert.deepEqual(submitted[0].campaigns, ['20']);
    assert.deepEqual(out.campaigns.map((c) => c.id), ['20']);
  });
  await withEnv({}, async () => {
    mockOzon({ [TOKEN]: tokenRoute({ n: 0 }), '/api/client/campaign': () => ({ list: [] }) });
    const out = parse(await callTool('ozon_ads_stats', {}));
    assert.deepEqual(out.campaigns ?? [], []);
    assert.ok(out.notes.some((n) => /没有/.test(n)));
  });
});

test('ozon_ads_stats: reads every campaign page and reports at most 10 campaigns at a time', async () => {
  await withEnv({}, async () => {
    const campaigns = Array.from({ length: 150 }, (_, i) => ({ id: String(i + 1), title: `C${i + 1}`, state: 'CAMPAIGN_STATE_RUNNING' }));
    const submitted = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = mockOzon({
      [TOKEN]: tokenRoute({ n: 0 }),
      '/api/client/campaign': () => {
        const page = Number(new URL(calls.at(-1).url).searchParams.get('page'));
        return { list: campaigns.slice((page - 1) * 100, page * 100) };
      },
      '/api/client/statistics/campaign/product/json': () => ({ rows: campaigns.map((c) => campaignStat(c.id, ['10', '1', '0', '0', '0', '1'])) }),
      '/api/client/statistics/json': (body) => {
        submitted.push(body.campaigns);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return { UUID: 'u-1' };
      },
      '/api/client/statistics/u-1': () => ({ state: 'OK' }),
      '/api/client/statistics/report': () => {
        inFlight -= 1;
        const batch = submitted.at(-1);
        return Object.fromEntries(batch.map((id) => [id, { report: { rows: [reportRow(`9${id}`, ['10', '1', '0', '0', '0', '1'])] } }]));
      },
    });
    const out = parse(await callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09', product_limit: 500 }));
    assert.equal(out.campaigns.length, 150);
    assert.equal(calls.filter((c) => c.path === '/api/client/statistics/campaign/product/json').length, 3, '150 campaigns in batches of 50');
    assert.equal(submitted.length, 15);
    assert.ok(submitted.every((batch) => batch.length <= 10));
    assert.equal(maxInFlight, 1, 'Ozon allows one report at a time per account');
    assert.equal(out.products_total, 150);
  });
});

test('ozon_ads_stats: periods longer than 62 days are refused before any request', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon({});
    const out = await callTool('ozon_ads_stats', { date_from: '2026-01-01', date_to: '2026-11-09' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /62/);
    assert.equal(calls.length, 0);
  });
});

test('ads tools are listed only when Performance API credentials are configured', async () => {
  await withEnv({ OZON_PERF_CLIENT_ID: undefined, OZON_PERF_CLIENT_SECRET: undefined }, async () => {
    assert.ok(!listTools().some((t) => t.name.startsWith('ozon_ads_')));
    const status = parse(await callTool('ozon_status', {}));
    assert.equal(status.ads.credentials_configured, false);
    assert.match(status.ads.setup_hint, /OZON_PERF_CLIENT_ID/);
  });
  await withEnv({}, () => assert.equal(listTools().filter((t) => t.name.startsWith('ozon_ads_')).length, 3));
});

test('ads: default period uses the Moscow calendar date', () => {
  assert.equal(moscowDate(Date.parse('2026-11-09T21:30:00Z')), '2026-11-10');
  assert.equal(moscowDate(Date.parse('2026-11-09T20:59:00Z')), '2026-11-09');
});

test('ozon_ads_api_catalog: search and describe', async () => {
  await withEnv({}, async () => {
    const list = parse(await callTool('ozon_ads_api_catalog', { query: 'statistics/daily' }));
    assert.ok(list.operations.some((o) => o.path === '/api/client/statistics/daily/json'));
    const one = parse(await callTool('ozon_ads_api_catalog', { endpoint: '/api/client/statistics/products/sku', method: 'POST' }));
    assert.ok(one.body_schema.properties.campaignIds);
    assert.equal(one.read_only, true);
    const missing = await callTool('ozon_ads_api_catalog', { endpoint: '/nope' });
    assert.equal(missing.isError, true);
  });
});

// ---- review fixes (2026-11-14) -----------------------------------------------------------------

test('ads: a bearer token in a network error never reaches the output, also after the token was replaced', async () => {
  await withEnv({}, async () => {
    const tokens = [];
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let campaignCalls = 0;
    setFetchForTests(async (url, init) => {
      const path = new URL(url).pathname;
      if (path === TOKEN) {
        tokens.push(`eyJ.long-bearer-${tokens.length + 1}-${'x'.repeat(40)}`);
        return json({ access_token: tokens.at(-1), expires_in: 1800 });
      }
      campaignCalls += 1;
      const auth = init.headers.Authorization;
      if (campaignCalls === 1) {
        // Still in flight while another call refreshes the token; fails afterwards, echoing its header.
        await held;
        throw new TypeError('fetch failed', { cause: Object.assign(new Error(`socket hang up (Authorization: ${auth})`), { code: 'ECONNRESET' }) });
      }
      if (campaignCalls === 2) return json({ error: 'expired' }, 401);
      return json({ list: [] });
    });
    const first = callTool('ozon_ads_api_call', { endpoint: '/api/client/campaign', method: 'GET' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await callTool('ozon_ads_api_call', { endpoint: '/api/client/campaign', method: 'GET' })).isError, undefined);
    assert.equal(tokens.length, 2, 'the token was replaced while the first request was in flight');
    release();
    const out = await first;
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /ECONNRESET.*Bearer \[已隐藏令牌\]/s);
    for (const token of tokens) assert.ok(!out.content[0].text.includes(token));
  });
});

test('ads: concurrent 429s are retried within the account budget, then the account cools down', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon({ [TOKEN]: tokenRoute({ n: 0 }), '/api/client/campaign': () => json({}, 429, { 'retry-after': '0' }) });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => adsRequest('/api/client/campaign')));
    assert.ok(results.every((r) => r.status === 'rejected'));
    assert.equal(calls.filter((c) => c.path === '/api/client/campaign').length, 14, '10 sends + 4 budgeted retries, not 20');

    mockOzon({ [TOKEN]: tokenRoute({ n: 0 }), '/api/client/campaign': () => json({}, 429, { 'retry-after': '30' }) });
    await assert.rejects(adsRequest('/api/client/campaign'), /HTTP 429.*Retry-After=30 秒/);
    const later = mockOzon({});
    await assert.rejects(adsRequest('/api/client/campaign', { params: { page: 2 } }), /限流保护：Ozon 刚对该账号返回 429/);
    assert.equal(later.length, 0);
  });
});

test('ads: a write whose response body breaks off reports an unknown outcome', async () => {
  await withEnv({ OZON_READ_ONLY: 'false' }, async () => {
    let sent = false;
    const broken = () => new Response(new ReadableStream({
      pull(controller) {
        if (sent) controller.error(new TypeError('terminated', { cause: new Error('other side closed') }));
        else {
          sent = true;
          controller.enqueue(new TextEncoder().encode('{"ok":'));
        }
      },
    }), { headers: { 'content-type': 'application/json' } });
    mockOzon({ [TOKEN]: tokenRoute({ n: 0 }), '/api/client/campaign/77/activate': broken });
    await assert.rejects(adsRequest('/api/client/campaign/{campaignId}/activate', { method: 'POST', params: { campaignId: '77' } }),
      /读取 Ozon 响应时连接中断.*other side closed.*写入结果未知/);
  });
});

// Report routes for concurrent ozon_ads_stats calls: every submission gets its own UUID.
function queuedReportRoutes(events, { statusGate } = {}) {
  const { routes } = statsRoutes();
  let submitted = 0;
  const uuids = [];
  const reportRoutes = {
    '/api/client/statistics/json': async (body) => {
      submitted += 1;
      const uuid = `u-${submitted}`;
      uuids.push(uuid);
      events.push(`submit ${uuid} ${body.dateFrom}`);
      return { UUID: uuid };
    },
    '/api/client/statistics/report': () => {
      events.push('download');
      return routes['/api/client/statistics/report']();
    },
  };
  for (let i = 1; i <= 4; i += 1) {
    reportRoutes[`/api/client/statistics/u-${i}`] = async () => {
      if (statusGate) await statusGate;
      if (!events.includes(`ok u-${i}`)) events.push(`ok u-${i}`);
      return { state: 'OK' };
    };
  }
  return { ...routes, ...reportRoutes, uuids };
}

// Reports Ozon is building at the same time: from submission until its status first reads OK.
const inFlightMax = (events) => {
  let open = 0;
  let max = 0;
  for (const e of events) {
    if (e.startsWith('submit')) open += 1;
    if (e.startsWith('ok ')) open -= 1;
    max = Math.max(max, open);
  }
  return max;
};

test('ozon_ads_stats: concurrent calls on one account never have two reports in progress', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 1 });
    try {
      const events = [];
      mockOzon(queuedReportRoutes(events));
      const [a, b] = await Promise.all([
        callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' }),
        callTool('ozon_ads_stats', { date_from: '2026-11-02', date_to: '2026-11-08' }),
      ]);
      assert.equal(a.isError, undefined, a.content[0].text);
      assert.equal(b.isError, undefined, b.content[0].text);
      assert.equal(events.filter((e) => e.startsWith('submit')).length, 2);
      assert.equal(inFlightMax(events), 1, JSON.stringify(events));
      assert.equal(parse(a).products_complete, true);
      assert.equal(parse(b).products_complete, true);
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ozon_ads_stats: identical concurrent calls share one report', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 1 });
    try {
      const events = [];
      let release;
      const statusGate = new Promise((resolve) => { release = resolve; });
      mockOzon(queuedReportRoutes(events, { statusGate }));
      const args = { date_from: '2026-11-03', date_to: '2026-11-09' };
      const pending = Promise.all([callTool('ozon_ads_stats', args), callTool('ozon_ads_stats', args)]);
      setTimeout(release, 30);
      const [a, b] = (await pending).map(parse);
      assert.equal(events.filter((e) => e.startsWith('submit')).length, 1, JSON.stringify(events));
      assert.deepEqual(a.products, b.products);
      assert.ok([a, b].some((out) => out.notes.some((n) => /共用/.test(n))));
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ozon_ads_api_call: a report submission waits for the report ozon_ads_stats is generating', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 1 });
    try {
      const events = [];
      let release;
      const statusGate = new Promise((resolve) => { release = resolve; });
      mockOzon(queuedReportRoutes(events, { statusGate }));
      const stats = callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' });
      while (!events.length) await new Promise((resolve) => setTimeout(resolve, 2));
      const generic = callTool('ozon_ads_api_call', { endpoint: '/api/client/statistics/json', method: 'POST',
        body: { campaigns: ['10'], dateFrom: '2026-10-01', dateTo: '2026-10-02' } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(events, ['submit u-1 2026-11-03'], 'the generic submission is held back');
      release();
      assert.equal((await stats).isError, undefined);
      assert.equal(parse(await generic).data.UUID, 'u-2');
      assert.ok(events.indexOf('ok u-1') < events.indexOf('submit u-2 2026-10-01'), JSON.stringify(events));
    } finally {
      setReportTimingForTests(null);
    }
  });
});

// ---- second review round (2026-11-14) ----------------------------------------------------------

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('ads: a token in use stays hidden even after it expires and many newer tokens push history out', async () => {
  const { rememberToken } = await import('../src/privacy.js');
  await withEnv({}, async () => {
    const token = `short-lived-${'z'.repeat(40)}`;
    setFetchForTests(async (url, init) => {
      if (new URL(url).pathname === TOKEN) return json({ access_token: token, expires_in: 0.001 });
      await pause(5); // the token has expired by now
      for (let i = 0; i < 200; i += 1) rememberToken(`old-${String(i).padStart(3, '0')}-tok`, Date.now() - 1);
      throw new TypeError('fetch failed', { cause: Object.assign(new Error(`reset (${init.headers.Authorization})`), { code: 'ECONNRESET' }) });
    });
    const out = await callTool('ozon_ads_api_call', { endpoint: '/api/client/campaign', method: 'GET' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /Bearer \[已隐藏令牌\]/);
    assert.ok(!out.content[0].text.includes(token));
  });
});

test('ads: a 429 from the token endpoint cools the account down; Retry-After is read', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon({ [TOKEN]: () => json({ error: 'slow down' }, 429, { 'retry-after': '30' }), '/api/client/campaign': () => ({ list: [] }) });
    await assert.rejects(adsRequest('/api/client/campaign'), /授权接口限流（HTTP 429）：Retry-After=30 秒/);
    await assert.rejects(adsRequest('/api/client/campaign'), /限流保护：Ozon 刚对该账号返回 429.*约 30 秒/);
    assert.equal(calls.length, 1, 'the second call did not ask for a token again');
  });
  await withEnv({}, async () => {
    const retryAt = new Date(Date.now() + 20_000).toUTCString();
    const calls = mockOzon({ [TOKEN]: () => json({}, 429, { 'retry-after': retryAt }) });
    await assert.rejects(adsRequest('/api/client/campaign'), /Retry-After=(19|20) 秒/);
    await assert.rejects(adsRequest('/api/client/campaign'), /限流保护/);
    assert.equal(calls.length, 1);
  });
});

test('ads: a write whose error response breaks off says the outcome is unknown', async () => {
  await withEnv({ OZON_READ_ONLY: 'false' }, async () => {
    let sent = false;
    const broken = () => new Response(new ReadableStream({
      pull(controller) {
        if (sent) controller.error(new TypeError('terminated', { cause: new Error('other side closed') }));
        else {
          sent = true;
          controller.enqueue(new TextEncoder().encode('{"error":'));
        }
      },
    }), { status: 502, headers: { 'content-type': 'application/json' } });
    mockOzon({ [TOKEN]: tokenRoute({ n: 0 }), '/api/client/campaign/77/activate': broken });
    await assert.rejects(adsRequest('/api/client/campaign/{campaignId}/activate', { method: 'POST', params: { campaignId: '77' } }),
      /HTTP 502 POST .*读取 Ozon 响应时连接中断.*other side closed.*写入结果未知/s);
  });
});

// Generic report submissions with a status per UUID that the test controls.
function reportSlotRoutes(events, states) {
  let n = 0;
  const routes = { [TOKEN]: tokenRoute({ n: 0 }) };
  const submit = (body) => {
    n += 1;
    events.push(`submit u-${n}`);
    return { UUID: `u-${n}` };
  };
  routes['/api/client/statistics/json'] = submit;
  for (let i = 1; i <= 4; i += 1) {
    routes[`/api/client/statistics/u-${i}`] = () => {
      const state = states[`u-${i}`] ?? 'OK';
      if (typeof state === 'function') return state();
      if (state === 'OK' && !events.includes(`u-${i} OK`)) events.push(`u-${i} OK`);
      return { state };
    };
  }
  return routes;
}

const genericReport = (dateFrom) => callTool('ozon_ads_api_call', { endpoint: '/api/client/statistics/json', method: 'POST',
  body: { campaigns: ['10'], dateFrom, dateTo: dateFrom } });

test('ozon_ads_api_call: the next report waits until Ozon has finished the previous one (tracked by UUID)', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2 });
    try {
      const events = [];
      const states = { 'u-1': 'IN_PROGRESS' };
      mockOzon(reportSlotRoutes(events, states));
      assert.equal(parse(await genericReport('2026-10-01')).data.UUID, 'u-1');
      const second = genericReport('2026-10-02');
      await pause(30);
      assert.deepEqual(events, ['submit u-1'], 'u-1 is still being built');
      states['u-1'] = 'OK';
      assert.equal(parse(await second).data.UUID, 'u-2');
      assert.deepEqual(events.slice(0, 3), ['submit u-1', 'u-1 OK', 'submit u-2']);
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ozon_ads_stats after a generic submission waits for that report, at most until it is maxAgeMs old', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2, maxAgeMs: 60 });
    try {
      const events = [];
      const { routes } = statsRoutes();
      // u-1 (generic) never finishes: the next submission polls it until it is maxAgeMs old.
      mockOzon({ ...routes, ...reportSlotRoutes(events, { 'u-1': 'IN_PROGRESS' }), '/api/client/statistics/report': routes['/api/client/statistics/report'] });
      await genericReport('2026-10-01');
      const started = Date.now();
      const out = parse(await callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' }));
      assert.ok(Date.now() - started >= 50, 'waited for the generic report');
      assert.equal(out.products_complete, true, JSON.stringify(out.notes));
      assert.deepEqual(events.filter((e) => e.startsWith('submit')), ['submit u-1', 'submit u-2']);
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ozon_ads_stats: a hung status request cannot starve the account; nothing is submitted in the background', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 1, waitMs: 80, maxAgeMs: 20 });
    try {
      const events = [];
      const hang = () => new Promise(() => {});
      const { routes } = statsRoutes();
      mockOzon({ ...routes, ...reportSlotRoutes(events, { 'u-1': hang, 'u-2': hang }) });
      const started = Date.now();
      const a = parse(await callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' }));
      const b = parse(await callTool('ozon_ads_stats', { date_from: '2026-11-02', date_to: '2026-11-08' }));
      assert.ok(Date.now() - started < 2000, 'both calls end within their time budget');
      for (const out of [a, b]) {
        assert.equal(out.products_complete, false);
        assert.ok(out.notes.some((n) => /未生成完/.test(n) && /UUID=u-/.test(n)), JSON.stringify(out.notes));
      }
      assert.deepEqual(events, ['submit u-1', 'submit u-2'], 'the second call was not starved');
      await pause(100);
      assert.deepEqual(events, ['submit u-1', 'submit u-2'], 'no submission after the calls returned');
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ozon_ads_api_call: a submission whose budget runs out while the previous report is built never runs later', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2, waitMs: 30, maxAgeMs: 150 });
    try {
      const events = [];
      mockOzon(reportSlotRoutes(events, { 'u-1': 'IN_PROGRESS' }));
      await genericReport('2026-10-01');
      const late = await genericReport('2026-10-02');
      assert.equal(late.isError, true);
      assert.match(late.content[0].text, /上一份报表（UUID=u-1）还在生成.*未提交新报表/);
      await pause(200); // u-1 is past maxAgeMs by now
      assert.deepEqual(events.filter((e) => e.startsWith('submit')), ['submit u-1']);
    } finally {
      setReportTimingForTests(null);
    }
  });
});

// ---- third review round (2026-11-14): no background work, one deadline per call ---------------

test('ozon_ads_stats: one deadline from entry covers the token fetch; nothing is sent once it is used up', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ waitMs: 20 });
    try {
      const calls = mockOzon({
        [TOKEN]: async () => {
          await pause(60);
          return { access_token: 'late-token', expires_in: 1800 };
        },
        '/api/client/campaign': () => ({ list: [] }),
      });
      const started = Date.now();
      const out = await callTool('ozon_ads_stats', {});
      assert.ok(Date.now() - started < 50, 'ended at the deadline, not when the token arrived');
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /广告统计在 \d+ 秒内未完成，已取消剩余请求/);
      await pause(100);
      assert.deepEqual(calls.map((c) => c.path), [TOKEN], 'the late token was not used to send anything');
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ozon_ads_stats: the deadline covers the campaign phase, also with include_products=false', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ waitMs: 20 });
    try {
      mockOzon({
        [TOKEN]: tokenRoute({ n: 0 }),
        '/api/client/campaign': async () => {
          await pause(60);
          return { list: [] };
        },
      });
      const started = Date.now();
      const out = await callTool('ozon_ads_stats', { include_products: false });
      assert.ok(Date.now() - started < 50);
      assert.match(out.content[0].text, /广告统计在 \d+ 秒内未完成/);
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ozon_ads_stats: a status response whose body never ends is cut off by the deadline', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 1, waitMs: 60 });
    try {
      const { routes } = statsRoutes();
      const endless = () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"state":'));
        },
      }), { headers: { 'content-type': 'application/json' } });
      mockOzon({ ...routes, '/api/client/statistics/u-1': endless });
      const started = Date.now();
      const out = parse(await callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' }));
      assert.ok(Date.now() - started < 1000);
      assert.equal(out.products_complete, false);
      assert.ok(out.notes.some((n) => /未生成完/.test(n) && /UUID=u-1/.test(n)), JSON.stringify(out.notes));
      assert.equal(out.campaigns.find((c) => c.id === '10').clicks, 400, 'campaign totals are kept');
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ads: cancelling during a retry delay sends nothing more', async () => {
  const { timeLimit } = await import('../src/ads/http.js');
  await withEnv({}, async () => {
    const calls = mockOzon({ [TOKEN]: tokenRoute({ n: 0 }), '/api/client/campaign': () => json({}, 503, { 'retry-after': '0.5' }) });
    const limit = timeLimit(50);
    const started = Date.now();
    await assert.rejects(adsRequest('/api/client/campaign', { signal: limit.signal }), /时间预算，请求未发送/);
    limit.done();
    assert.ok(Date.now() - started < 300, 'the retry delay was cut short');
    await pause(700);
    assert.equal(calls.filter((c) => c.path === '/api/client/campaign').length, 1);
  });
});

test('untilAborted leaves no unhandled rejection behind', async () => {
  const { untilAborted } = await import('../src/ads/http.js');
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(untilAborted(Promise.reject(new Error('rejected while already aborted')), aborted.signal));
    const later = new AbortController();
    let fail;
    const raced = untilAborted(new Promise((_, reject) => {
      fail = reject;
    }), later.signal);
    later.abort();
    await assert.rejects(raced);
    fail(new Error('rejected after the race was lost'));
    await pause(20);
    assert.deepEqual(seen, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('ozon_ads_api_call: a failed status poll is not a final state; the next report still waits', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2 });
    try {
      const events = [];
      let failures = 0;
      const states = {
        'u-1': () => {
          if (failures < 2) {
            failures += 1;
            return json({ message: 'internal' }, 500);
          }
          return { state: 'IN_PROGRESS' };
        },
      };
      mockOzon(reportSlotRoutes(events, states));
      await genericReport('2026-10-01');
      const second = genericReport('2026-10-02');
      await pause(40);
      assert.equal(failures, 2);
      assert.deepEqual(events, ['submit u-1'], 'two failed polls did not free the slot');
      states['u-1'] = 'OK';
      assert.equal(parse(await second).data.UUID, 'u-2');
      assert.deepEqual(events, ['submit u-1', 'u-1 OK', 'submit u-2']);
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ozon_ads_api_call: vendor reports take the slot and are checked on the vendor status endpoint', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2 });
    try {
      let vendorState = 'IN_PROGRESS';
      const calls = mockOzon({
        [TOKEN]: tokenRoute({ n: 0 }),
        '/api/client/vendors/statistics': () => ({ UUID: 'v-1', vendor: true }),
        '/api/client/vendors/statistics/v-1': () => ({ state: vendorState }),
        '/api/client/statistics/json': () => ({ UUID: 'u-1' }),
      });
      const vendor = parse(await callTool('ozon_ads_api_call', { endpoint: '/api/client/vendors/statistics', method: 'POST',
        body: { dateFrom: '2026-10-01', dateTo: '2026-10-02', type: 'ORDERS' } }));
      assert.equal(vendor.data.UUID, 'v-1');
      const next = genericReport('2026-10-03');
      await pause(30);
      assert.equal(calls.filter((c) => c.path === '/api/client/statistics/json').length, 0, 'waits for the vendor report');
      vendorState = 'CANCEL'; // a final state of vendor reports
      assert.equal(parse(await next).data.UUID, 'u-1');
      assert.ok(calls.some((c) => c.path === '/api/client/vendors/statistics/v-1'));
      assert.ok(!calls.some((c) => c.path === '/api/client/statistics/v-1'), 'not the ordinary status endpoint');
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ozon_ads_api_call: a status the caller already read as final spares the next submission a poll', async () => {
  await withEnv({}, async () => {
    const events = [];
    const states = { 'u-1': 'IN_PROGRESS' };
    const calls = mockOzon(reportSlotRoutes(events, states));
    await genericReport('2026-10-01');
    states['u-1'] = 'OK';
    const status = parse(await callTool('ozon_ads_api_call', { endpoint: '/api/client/statistics/{UUID}', method: 'GET', params: { UUID: 'u-1' } }));
    assert.equal(status.data.state, 'OK');
    await genericReport('2026-10-02');
    assert.equal(calls.filter((c) => c.path === '/api/client/statistics/u-1').length, 1);
  });
});

test('a pending ads call and a finished report submission do not keep the process alive', async () => {
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ads-hung-exit.mjs');
  const started = Date.now();
  const { code, stdout } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the process was kept alive'));
    }, 10_000);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve({ code: exitCode, stdout: output });
    });
  });
  assert.equal(code, 0);
  assert.match(stdout, /submitted u-1/);
  assert.ok(Date.now() - started < 5000, `exited after ${Date.now() - started} ms`);
});

// ---- fourth review round (2026-11-14) ----------------------------------------------------------

// Fails a test instead of letting it hang when something waits forever.
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms).unref();
})]);

// A response whose body cancel never settles (a stalled connection).
const stuckBody = (status, headers = {}) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('{}'));
  },
  cancel() {
    return new Promise(() => {});
  },
}), { status, headers: { 'content-type': 'application/json', ...headers } });

test('ads: a body cancel that never settles holds neither the call nor the report slot', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2 });
    try {
      let submits = 0;
      mockOzon({
        [TOKEN]: tokenRoute({ n: 0 }),
        '/api/client/statistics/json': () => {
          submits += 1;
          return submits === 1 ? stuckBody(401) : { UUID: `u-${submits - 1}` };
        },
        '/api/client/statistics/u-1': () => ({ state: 'OK' }),
        '/api/client/campaign': () => stuckBody(302, { location: 'https://example.com/' }),
      });
      // 401 → the body is dropped, a new token fetched, the submission resent.
      assert.equal(parse(await within(genericReport('2026-10-01'), 1000, 'first submission')).data.UUID, 'u-1');
      assert.equal(parse(await within(genericReport('2026-10-02'), 1000, 'second submission')).data.UUID, 'u-2', 'the slot was released');
      await within(assert.rejects(adsRequest('/api/client/campaign'), /重定向/), 1000, 'redirect');
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('ozon_ads_stats: a call that joins a shared report keeps its own deadline', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2, waitMs: 100 });
    try {
      const { routes } = statsRoutes();
      let lists = 0;
      mockOzon({
        ...routes,
        // The first call's campaign list is slow, so it reaches the report after the second call created it.
        '/api/client/campaign': async () => {
          lists += 1;
          if (lists === 1) await pause(75);
          return routes['/api/client/campaign']();
        },
        '/api/client/statistics/u-1': () => ({ state: 'IN_PROGRESS' }),
      });
      const args = { date_from: '2026-11-03', date_to: '2026-11-09' };
      const startedA = Date.now();
      const a = callTool('ozon_ads_stats', args);
      await pause(50);
      const b = callTool('ozon_ads_stats', args);
      const outA = parse(await a);
      const elapsedA = Date.now() - startedA;
      assert.ok(elapsedA < 135, `the first call ended at its own deadline, after ${elapsedA} ms`);
      assert.equal(outA.products_complete, false);
      assert.ok(outA.notes.some((n) => /共用/.test(n)), JSON.stringify(outA.notes));
      assert.equal(parse(await b).products_complete, false, 'the shared job ran on for the second call');
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('report submissions: sent without a definite answer, the next one waits until it ages out', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2, maxAgeMs: 80, waitMs: 400 });
    try {
      const events = [];
      let submits = 0;
      const routes = reportSlotRoutes(events, {});
      mockOzon({
        ...routes,
        '/api/client/statistics/json': (body) => {
          submits += 1;
          // Ozon accepted the first one, but its answer breaks off.
          if (submits === 1) return new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated')); } }), { headers: { 'content-type': 'application/json' } });
          return routes['/api/client/statistics/json'](body);
        },
      });
      const started = Date.now();
      assert.equal((await genericReport('2026-10-01')).isError, true);
      assert.equal(parse(await genericReport('2026-10-02')).data.UUID, 'u-1');
      assert.ok(Date.now() - started >= 75, 'waited for the unknown submission to age out');
      assert.equal(submits, 2);
    } finally {
      setReportTimingForTests(null);
    }
  });
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2, maxAgeMs: 400, waitMs: 40 });
    try {
      let submits = 0;
      mockOzon({
        [TOKEN]: tokenRoute({ n: 0 }),
        '/api/client/statistics/json': () => {
          submits += 1;
          return json({ message: 'bad gateway' }, 502);
        },
      });
      assert.equal((await genericReport('2026-10-01')).isError, true);
      assert.equal(submits, 1, 'a report submission is not retried like a plain read');
      const started = Date.now();
      const out = await genericReport('2026-10-02');
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /时间预算已用完.*上一份报表（已提交但结果未知）/);
      assert.ok(Date.now() - started < 30, 'refused at once: the budget cannot cover the wait');
      assert.equal(submits, 1);
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('report submissions: one never sent, or refused outright, holds nothing back', async () => {
  const { noteRateLimited, resetRateLimits } = await import('../src/ratelimit.js');
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2, maxAgeMs: 400 });
    try {
      const events = [];
      mockOzon(reportSlotRoutes(events, {}));
      noteRateLimited({ path: '/api/client/campaign' }, `perf:${PERF_ID}`, 30_000);
      assert.match((await genericReport('2026-10-01')).content[0].text, /限流保护/);
      resetRateLimits();
      const started = Date.now();
      assert.equal(parse(await genericReport('2026-10-02')).data.UUID, 'u-1');
      assert.ok(Date.now() - started < 50, 'nothing was sent, so nothing to wait for');
    } finally {
      setReportTimingForTests(null);
    }
  });
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2, maxAgeMs: 400 });
    try {
      let submits = 0;
      mockOzon({ [TOKEN]: tokenRoute({ n: 0 }), '/api/client/statistics/json': () => {
        submits += 1;
        return submits === 1 ? json({ error: 'bad period' }, 400) : { UUID: 'u-1' };
      } });
      assert.equal((await genericReport('2026-10-01')).isError, true);
      const started = Date.now();
      assert.equal(parse(await genericReport('2026-10-02')).data.UUID, 'u-1');
      assert.ok(Date.now() - started < 50, 'a 400 is a definite refusal');
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('report submissions: a hanging status poll is cut off by the previous report\'s age, not only the budget', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2, maxAgeMs: 40, waitMs: 400 });
    try {
      const events = [];
      mockOzon(reportSlotRoutes(events, { 'u-1': () => new Promise(() => {}) }));
      await genericReport('2026-10-01');
      const started = Date.now();
      assert.equal(parse(await genericReport('2026-10-02')).data.UUID, 'u-2', 'the age ran out: submitted');
      assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
    } finally {
      setReportTimingForTests(null);
    }
  });
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2, maxAgeMs: 400, waitMs: 40 });
    try {
      const events = [];
      mockOzon(reportSlotRoutes(events, { 'u-1': () => new Promise(() => {}) }));
      await genericReport('2026-10-01');
      const out = await genericReport('2026-10-02');
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /本次调用的时间预算已用完.*上一份报表（UUID=u-1）.*未提交新报表/);
      assert.deepEqual(events, ['submit u-1']);
    } finally {
      setReportTimingForTests(null);
    }
  });
});

test('report submissions: a failed token request is not a submission and holds nothing back', async () => {
  await withEnv({}, async () => {
    setReportTimingForTests({ pollMs: 2, maxAgeMs: 400 });
    try {
      let tokens = 0;
      let submits = 0;
      mockOzon({
        [TOKEN]: () => {
          tokens += 1;
          if (tokens === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
          return { access_token: `tok-${tokens}`, expires_in: 1800 };
        },
        '/api/client/statistics/json': () => {
          submits += 1;
          return { UUID: `u-${submits}` };
        },
      });
      const first = await genericReport('2026-10-01');
      assert.equal(first.isError, true);
      assert.match(first.content[0].text, /ECONNRESET/);
      assert.equal(submits, 0, 'no report request went out');
      const started = Date.now();
      assert.equal(parse(await genericReport('2026-10-02')).data.UUID, 'u-1');
      assert.ok(Date.now() - started < 100, `held back for ${Date.now() - started} ms`);
    } finally {
      setReportTimingForTests(null);
    }
  });
});
