import assert from 'node:assert/strict';
import test from 'node:test';
import { dropEmpty, fitToBudget } from '../src/compact.js';
import { RateLimitError } from '../src/errors.js';
import { multipart, request } from '../src/http.js';
import { afterSuccess, beforeRequest } from '../src/ratelimit.js';
import { callTool, listTools } from '../src/tools.js';
import { json, mockOzon, parse, withEnv } from './helpers.js';

const ANALYTICS = { method: 'POST', path: '/v1/analytics/data', read_only: true };

test('dropEmpty keeps 0 and false, drops null/""/[]/{}', () => {
  assert.deepEqual(dropEmpty({ a: 0, b: false, c: null, d: '', e: [], f: {}, g: { h: [null, { i: '' }] }, j: [1, null] }),
    { a: 0, b: false, j: [1] });
});

test('fitToBudget cuts the largest array and reports it', () => {
  const value = { meta: 'x', items: Array.from({ length: 200 }, (_, i) => ({ id: i, text: 'y'.repeat(50) })), small: [1, 2] };
  const { value: out, truncated } = fitToBudget(value, 4000);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 4000);
  assert.equal(truncated[0].path, '$.items');
  assert.equal(truncated[0].total, 200);
  assert.ok(truncated[0].kept > 10 && truncated[0].kept < 200);
  assert.equal(value.items.length, 200, 'input must not be mutated');
});

test('rate limiter: blocks inside the window, caches identical reads, enforces the daily cap', async () => {
  await withEnv({}, () => {
    assert.equal(beforeRequest(ANALYTICS, { a: 1 }, 0), null);
    afterSuccess(ANALYTICS, { a: 1 }, { data: 'first' }, 0);
    assert.equal(beforeRequest(ANALYTICS, { a: 1 }, 1000).from_cache, true);
    assert.throws(() => beforeRequest(ANALYTICS, { a: 2 }, 1000), (e) => e instanceof RateLimitError && /1 次\/分钟/.test(e.message));
    let now = 0;
    for (let i = 1; i < 50; i += 1) {
      now += 61_000;
      assert.equal(beforeRequest(ANALYTICS, { i }, now), null);
    }
    assert.throws(() => beforeRequest(ANALYTICS, { i: 'over' }, now + 61_000), /小时/);
  });
});

test('429 errors carry the official limit; reads retry once, writes never retry', async () => {
  await withEnv({ OZON_READ_ONLY: 'false' }, async () => {
    const calls = mockOzon({
      '/v1/analytics/data': () => json({ message: 'slow down' }, 429, { 'retry-after': '30' }),
      '/v3/product/list': (_, n) => (n === 1 ? json({}, 503, { 'retry-after': '0' }) : { result: { items: [] } }),
      '/v2/products/stocks': () => json({}, 503, { 'retry-after': '0' }),
    });
    const body = { date_from: '2026-10-01', date_to: '2026-10-02', metrics: ['revenue'], dimension: ['day'], limit: 1 };
    await assert.rejects(request('/v1/analytics/data', body), /官方限制：1 次\/分钟，50 次\/天/);
    assert.equal((await request('/v3/product/list', { limit: 1 })).http_status, 200);
    await assert.rejects(request('/v2/products/stocks', { stocks: [{ offer_id: 'a', product_id: 1, quant_size: 1, stock: 1, warehouse_id: 1 }] }));
    const count = (p) => calls.filter((c) => c.path === p).length;
    assert.deepEqual([count('/v1/analytics/data'), count('/v3/product/list'), count('/v2/products/stocks')], [1, 2, 1]);
  });
});

function topProductRoutes() {
  return {
    '/v1/analytics/data': () => ({ result: { data: [
      { dimensions: [{ id: '111', name: 'A' }], metrics: [5, 50] },
      { dimensions: [{ id: '222', name: 'B' }], metrics: [9, 20] },
      { dimensions: [{ id: '333', name: 'C' }], metrics: [1, 99] },
    ], totals: [15, 169] } }),
    '/v3/product/info/list': () => ({ items: [
      { id: 1, offer_id: 'a', name: 'Prod A', sources: [{ sku: 111 }], price: '10.00', currency_code: 'CNY', stocks: { stocks: [{ source: 'fbs', present: 3, reserved: 1 }] } },
      { id: 2, offer_id: 'b', name: 'Prod B', sources: [{ sku: 222 }], price: '12.50', currency_code: 'CNY' },
      { id: 3, offer_id: 'c', name: 'Prod C', sources: [{ sku: 333 }], price: '7', currency_code: 'CNY' },
    ] }),
    '/v4/product/info/attributes': () => ({ result: [{ id: 1, sku: 111, description_category_id: 7, type_id: 8, depth: 1, width: 2, height: 3, dimension_unit: 'mm',
      attributes: [{ id: 85, values: [{ value: 'Brand<br/>X' }] }, { id: 11254, values: [{ value: '{"huge":true}' }] }] }] }),
    '/v1/description-category/attribute': () => ({ result: [{ id: 85, name: '品牌' }, { id: 11254, name: 'JSON富内容' }] }),
  };
}

test('ozon_top_products: no sort sent, local ranking, named attributes, cache reuse', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon(topProductRoutes());
    const out = parse(await callTool('ozon_top_products', { limit: 2 }));
    const analytics = calls.find((c) => c.path === '/v1/analytics/data').body;
    assert.equal(analytics.sort, undefined);
    assert.equal(analytics.limit, 1000);
    assert.deepEqual(out.items.map((i) => i.sku), ['222', '111']);
    assert.equal(out.items[1].attributes['品牌'], 'Brand X');
    assert.match(out.items[1].attributes['JSON富内容'], /已省略/);
    assert.equal(out.items[1].size, '1×2×3 mm');
    assert.deepEqual(out.items[1].stocks, { fbs: { present: 3, reserved: 1 } });
    assert.ok(out.notes.some((n) => n.includes('1 次/分钟')));

    const byRevenue = parse(await callTool('ozon_top_products', { limit: 2, metric: 'revenue' }));
    assert.deepEqual(byRevenue.items.map((i) => i.sku), ['333', '111']);
    assert.equal(calls.filter((c) => c.path === '/v1/analytics/data').length, 1, 'second ranking must come from cache');
  });
});

test('ozon_orders_overview: parallel windows, dedupe, status summary', async () => {
  await withEnv({}, async () => {
    const posting = (n, status) => ({ posting_number: n, status, in_process_at: '2026-10-01T10:00:00Z',
      products: [{ sku: 9, offer_id: 'x', name: 'X', quantity: 2, price: { amount: '5', currency: 'CNY' } }] });
    const calls = mockOzon({
      '/v4/posting/fbs/list': (body) => (body.cursor
        ? { postings: [posting('B', 'cancelled')], has_next: false }
        : { postings: [posting('A', 'delivering')], has_next: true, cursor: 'next' }),
    });
    const out = parse(await callTool('ozon_orders_overview', { date_from: '2026-10-01', date_to: '2026-10-02', schemes: ['fbs'] }));
    assert.equal(calls.length, 4, 'two daily windows × two pages');
    assert.equal(out.fbs.postings, 2, 'same postings across windows are counted once');
    assert.equal(out.fbs.complete, true);
    assert.equal(out.fbs.units_excluding_cancelled, 2);
    assert.deepEqual(out.fbs.amount_excluding_cancelled, { CNY: 10 });
    assert.equal(out.top_products[0].units, 2);
  });
});

test('composite arguments are validated before any request', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon({});
    for (const args of [{ limit: 0 }, { metric: 'profit' }, { date_from: '2026-02-30' }, { unknown: 1 }]) {
      const result = await callTool('ozon_top_products', args);
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, 0);
  });
});

test('oversized API results are truncated with a hint', async () => {
  await withEnv({ OZON_MAX_RESULT_KB: '8' }, async () => {
    mockOzon({ '/v3/product/list': () => ({ result: { items: Array.from({ length: 500 }, (_, i) => ({ product_id: i, offer_id: 'o'.repeat(40) })), total: 500 } }) });
    const out = parse(await callTool('ozon_api_call', { endpoint: '/v3/product/list', body: { limit: 500 } }));
    assert.ok(out.truncated[0].path.endsWith('.items'));
    assert.match(out.truncation_hint, /分页/);
  });
});

test('rate-limited tools say so in their description', async () => {
  await withEnv({ OZON_TOOLSET: 'core' }, () => {
    const tools = new Map(listTools().map((t) => [t.name, t]));
    assert.match(tools.get('ozon_AnalyticsAPI_AnalyticsGetData').description, /⚠ 限流：1 次\/分钟，50 次\/天/);
    assert.match(tools.get('ozon_top_products').description, /限流/);
    assert.match(tools.get('ozon_sales_overview').description, /限流/);
  });
});

test('OZON_TOOLSET accepts paths and rejects typos', async () => {
  await withEnv({ OZON_TOOLSET: 'minimal,/v3/product/list' }, () => assert.equal(listTools().length, 13));
  await withEnv({ OZON_TOOLSET: 'cor' }, () => assert.throws(() => listTools(), /无法识别/));
});

test('multipart: strict base64 and absolute existing files only', () => {
  assert.throws(() => multipart({ content: 'not base64!' }), /Base64/);
  assert.throws(() => multipart({ files: ['relative.pdf'] }), /绝对路径/);
  assert.ok(multipart({ content: Buffer.from('hi').toString('base64'), note: 'x' }));
});
