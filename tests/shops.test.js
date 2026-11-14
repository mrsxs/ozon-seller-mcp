// Several shops in one MCP: OZON_SHOPS array, per-call `shop`, market endpoints on the market shop.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkConfiguration, callTool, listTools } from '../src/tools.js';
import { json, mockOzon, parse, withEnv } from './helpers.js';

const SHOP_A = { name: 'alpha', client_id: '1110001', api_key: 'alpha-secret-key', perf_client_id: 'p1@advertising.performance.ozon.ru', perf_client_secret: 'alpha-perf-secret', market: true, default: true };
const SHOP_B = { name: 'beta', client_id: 2220002, api_key: 'beta-secret-key', perf_client_id: 'p2@advertising.performance.ozon.ru', perf_client_secret: 'beta-perf-secret' };
const SHOPS = JSON.stringify([SHOP_A, SHOP_B]);
const SECRETS = ['alpha-secret-key', 'beta-secret-key', 'alpha-perf-secret', 'beta-perf-secret'];
const TOKEN = '/api/client/token';

const clientIds = (calls, path) => calls.filter((c) => c.path === path).map((c) => c.init.headers['Client-Id']);

test('shops: config mistakes fail at startup, naming the entry and field but never a value', async () => {
  const bad = [
    ['not json', /不是合法 JSON/],
    ['[]', /至少含一个店铺/],
    [JSON.stringify([{ ...SHOP_A }, { ...SHOP_B, name: 'alpha' }]), /重复/],
    [JSON.stringify([{ ...SHOP_A, api_key: '' }]), /client_id 和 api_key 要么都填/],
    [JSON.stringify([{ ...SHOP_A, apikey: 'x' }]), /未知字段：apikey/],
    [JSON.stringify([SHOP_A, { ...SHOP_B, market: true }]), /只能有一个店铺标 "market"/],
    [JSON.stringify([{ ...SHOP_A, perf_client_secret: undefined }]), /要么都填/],
    [JSON.stringify([{ ...SHOP_A, market: 'yes' }]), /market 只能是 true 或 false/],
    [JSON.stringify([{ ...SHOP_A, name: 'a b' }]), /name 必须是/],
    [JSON.stringify([SHOP_A, { ...SHOP_B, client_id: SHOP_A.client_id }]), /两个店铺的 client_id 相同（alpha、beta）/],
    [JSON.stringify([SHOP_A, { ...SHOP_B, perf_client_id: SHOP_A.perf_client_id }]), /perf_client_id 相同/],
    [JSON.stringify([{ ...SHOP_A, api_key: undefined }]), /client_id 和 api_key 要么都填/],
    [JSON.stringify([{ name: 'empty' }]), /至少要填一组凭证/],
  ];
  for (const [value, message] of bad) {
    await withEnv({ OZON_SHOPS: value }, async () => {
      assert.throws(() => checkConfiguration(), (error) => {
        assert.match(error.message, message, value);
        for (const secret of SECRETS) assert.ok(!error.message.includes(secret), value);
        return true;
      });
    });
  }
});

test('shops: tools that reach Ozon gain a shop argument; local tools do not', async () => {
  await withEnv({ OZON_SHOPS: SHOPS }, async () => {
    const tools = new Map(listTools().map((t) => [t.name, t]));
    for (const name of ['ozon_api_call', 'ozon_top_products', 'ozon_ads_stats', 'ozon_AnalyticsAPI_AnalyticsGetData']) {
      assert.deepEqual(tools.get(name).inputSchema.properties.shop.enum, ['alpha', 'beta'], name);
    }
    for (const name of ['ozon_status', 'ozon_api_catalog', 'ozon_api_describe', 'ozon_validate_request', 'ozon_render_report', 'ozon_ads_api_catalog']) {
      assert.equal(tools.get(name).inputSchema.properties?.shop, undefined, name);
    }
  });
  // One shop configured the old way: tool schemas are exactly as before.
  await withEnv({}, async () => {
    assert.ok(listTools().every((t) => t.inputSchema.properties?.shop === undefined));
  });
});

test('shops: each call uses its own shop; market endpoints always use the market shop', async () => {
  await withEnv({ OZON_SHOPS: SHOPS }, async () => {
    const calls = mockOzon({
      '/v1/seller/info': () => ({ company: { name: 'x' } }),
      '/v1/search-queries/top': () => ({ search_queries: [] }),
    });
    const own = parse(await callTool('ozon_api_call', { endpoint: '/v1/seller/info', body: {}, shop: 'beta' }));
    const fallback = parse(await callTool('ozon_api_call', { endpoint: '/v1/seller/info', body: {} }));
    const market = parse(await callTool('ozon_api_call', { endpoint: '/v1/search-queries/top', body: { limit: '5', offset: '0' }, shop: 'beta' }));
    assert.deepEqual(clientIds(calls, '/v1/seller/info'), ['2220002', '1110001']);
    assert.deepEqual(clientIds(calls, '/v1/search-queries/top'), ['1110001']);
    assert.equal(own.shop, 'beta');
    assert.equal(fallback.shop, 'alpha');
    assert.equal(market.shop, 'alpha');
    // The shop argument is ours: it is never sent to Ozon.
    assert.ok(calls.every((c) => !('shop' in (c.body ?? {}))));
  });
});

test('shops: unknown shop or a shop on a local tool is refused before any request', async () => {
  await withEnv({ OZON_SHOPS: SHOPS }, async () => {
    const calls = mockOzon({});
    const unknown = await callTool('ozon_api_call', { endpoint: '/v1/seller/info', body: {}, shop: 'nope' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /没有名为「nope」的店铺；可用：alpha、beta/);
    const local = await callTool('ozon_status', { shop: 'alpha' });
    assert.equal(local.isError, true);
    assert.equal(calls.length, 0);
  });
});

test('shops: rate limits and the read cache are kept per seller account', async () => {
  await withEnv({ OZON_SHOPS: SHOPS }, async () => {
    const calls = mockOzon({ '/v1/analytics/data': () => ({ result: { data: [], totals: [] } }) });
    const body = { date_from: '2026-11-06', date_to: '2026-11-12', metrics: ['revenue'], dimension: ['day'], limit: 10, offset: 0 };
    const a = await callTool('ozon_api_call', { endpoint: '/v1/analytics/data', body, shop: 'alpha' });
    const b = await callTool('ozon_api_call', { endpoint: '/v1/analytics/data', body, shop: 'beta' });
    assert.equal(a.isError, undefined);
    assert.equal(b.isError, undefined);
    // Same body, other shop: not served from alpha's cache.
    assert.equal(parse(b).from_cache, undefined);
    assert.deepEqual(clientIds(calls, '/v1/analytics/data'), ['1110001', '2220002']);
    // Same shop, different body inside the minute: blocked locally.
    const again = await callTool('ozon_api_call', { endpoint: '/v1/analytics/data', body: { ...body, limit: 20 }, shop: 'beta' });
    assert.equal(again.isError, true);
    assert.match(again.content[0].text, /限流保护/);
  });
});

test('shops: status lists every shop without any secret; errors hide every shop\'s key', async () => {
  await withEnv({ OZON_SHOPS: SHOPS }, async () => {
    const status = parse(await callTool('ozon_status', {}));
    assert.equal(status.default_shop, 'alpha');
    assert.equal(status.market_shop, 'alpha');
    assert.deepEqual(status.shops.map((s) => [s.name, s.client_id, s.market, s.ads_configured]),
      [['alpha', '1110001', true, true], ['beta', '2220002', false, true]]);
    const text = JSON.stringify(status);
    for (const secret of SECRETS) assert.ok(!text.includes(secret));

    mockOzon({ '/v1/seller/info': () => json({ message: 'bad key beta-secret-key and alpha-secret-key' }, 403) });
    const failed = await callTool('ozon_api_call', { endpoint: '/v1/seller/info', body: {}, shop: 'beta' });
    assert.equal(failed.isError, true);
    for (const secret of SECRETS) assert.ok(!failed.content[0].text.includes(secret));
  });
});

test('shops: ads use each shop\'s Performance credentials and keep one token per client', async () => {
  await withEnv({ OZON_SHOPS: SHOPS }, async () => {
    let issued = 0;
    const calls = mockOzon({
      [TOKEN]: (body) => ({ access_token: `tok-${body.client_id}-${(issued += 1)}`, expires_in: 1800 }),
      '/api/client/campaign': () => ({ list: [] }),
    });
    for (const shop of ['alpha', 'beta', 'alpha', 'beta']) {
      const out = await callTool('ozon_ads_api_call', { endpoint: '/api/client/campaign', method: 'GET', shop });
      assert.equal(out.isError, undefined, shop);
    }
    assert.deepEqual(calls.filter((c) => c.path === TOKEN).map((c) => c.body.client_id),
      ['p1@advertising.performance.ozon.ru', 'p2@advertising.performance.ozon.ru']);
    const auth = calls.filter((c) => c.path === '/api/client/campaign').map((c) => c.init.headers.Authorization);
    assert.deepEqual(auth, ['Bearer tok-p1@advertising.performance.ozon.ru-1', 'Bearer tok-p2@advertising.performance.ozon.ru-2',
      'Bearer tok-p1@advertising.performance.ozon.ru-1', 'Bearer tok-p2@advertising.performance.ozon.ru-2']);
  });
});

test('shops: a shop without ad credentials gets a clear error naming it', async () => {
  const noAds = JSON.stringify([SHOP_A, { name: 'beta', client_id: '2220002', api_key: 'beta-secret-key' }]);
  await withEnv({ OZON_SHOPS: noAds }, async () => {
    const calls = mockOzon({});
    const out = await callTool('ozon_ads_api_call', { endpoint: '/api/client/campaign', method: 'GET', shop: 'beta' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /店铺「beta」没有配置广告凭证/);
    assert.equal(calls.length, 0);
  });
});

test('shops: with no shop marked market, market endpoints run as the shop the caller chose', async () => {
  const unmarked = JSON.stringify([{ ...SHOP_A, market: false }, SHOP_B]);
  await withEnv({ OZON_SHOPS: unmarked }, async () => {
    const calls = mockOzon({ '/v1/search-queries/top': () => ({ search_queries: [] }) });
    const out = parse(await callTool('ozon_api_call', { endpoint: '/v1/search-queries/top', body: { limit: '5', offset: '0' }, shop: 'beta' }));
    assert.deepEqual(clientIds(calls, '/v1/search-queries/top'), ['2220002']);
    assert.equal(out.shop, 'beta');
    assert.equal(parse(await callTool('ozon_status', {})).market_shop, null);
    assert.ok(!listTools().find((t) => t.name === 'ozon_api_call').inputSchema.properties.shop.description.includes('市场数据'));
  });
});

test('shops: an ads-only shop is allowed; Seller API calls on it name the missing credentials', async () => {
  const adsOnly = JSON.stringify([SHOP_A, { name: 'adsonly', perf_client_id: 'p3@advertising.performance.ozon.ru', perf_client_secret: 'adsonly-perf-secret' }]);
  await withEnv({ OZON_SHOPS: adsOnly }, async () => {
    checkConfiguration();
    const calls = mockOzon({});
    const out = await callTool('ozon_api_call', { endpoint: '/v1/seller/info', body: {}, shop: 'adsonly' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /店铺「adsonly」缺少 client_id 或 api_key/);
    assert.equal(calls.length, 0);
    const status = parse(await callTool('ozon_status', {}));
    assert.deepEqual(status.shops.map((s) => [s.name, s.seller_api_configured, s.ads_configured]), [['alpha', true, true], ['adsonly', false, true]]);
    assert.equal(status.ads.client_id, undefined);
  });
});

test('shops: ads results say which shop they belong to', async () => {
  await withEnv({ OZON_SHOPS: SHOPS }, async () => {
    mockOzon({ [TOKEN]: () => ({ access_token: 'tok', expires_in: 1800 }), '/api/client/campaign': () => ({ list: [] }) });
    const out = parse(await callTool('ozon_ads_api_call', { endpoint: '/api/client/campaign', method: 'GET', shop: 'beta' }));
    assert.equal(out.shop, 'beta');
  });
});

test('shops: an ads token failure names the shop and its config fields, not env variables', async () => {
  await withEnv({ OZON_SHOPS: SHOPS }, async () => {
    mockOzon({ [TOKEN]: () => json({ error: 'invalid_client beta-perf-secret' }, 401) });
    const out = await callTool('ozon_ads_api_call', { endpoint: '/api/client/campaign', method: 'GET', shop: 'beta' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /店铺「beta」的 perf_client_id 和 perf_client_secret/);
    assert.ok(!out.content[0].text.includes('OZON_PERF_CLIENT_ID'));
    assert.ok(!out.content[0].text.includes('beta-perf-secret'));
  });
});
