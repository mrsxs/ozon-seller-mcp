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
    setReportTimingForTests({ pollMs: 1, waitMs: 0 });
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
