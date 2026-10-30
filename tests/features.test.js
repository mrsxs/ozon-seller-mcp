import assert from 'node:assert/strict';
import test from 'node:test';
import { dropEmpty, fitToBudget } from '../src/compact.js';
import { RateLimitError } from '../src/errors.js';
import { multipart, request, setFetchForTests } from '../src/http.js';
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

test('big int64 values survive as exact strings, also on the Node 20 fallback path', async () => {
  const { quoteBigIntegers, parseJson } = await import('../src/http.js');
  const text = '{"id":1020005028488300123,"s":"x 1020005028488300123 \\" 99999999999999999","small":42,"f":12345678901234567.5,"n":-9223372036854775807}';
  const direct = JSON.parse(quoteBigIntegers(text));
  assert.equal(direct.id, '1020005028488300123');
  assert.equal(direct.s, 'x 1020005028488300123 " 99999999999999999');
  assert.equal(direct.small, 42);
  assert.equal(typeof direct.f, 'number');
  assert.equal(direct.n, '-9223372036854775807');
  assert.equal(parseJson(text).id, '1020005028488300123');
});

test('redact also hides a key that was configured with stray whitespace', async () => {
  const { redact } = await import('../src/privacy.js');
  await withEnv({ OZON_API_KEY: '  secret-key-123 \n' }, () => {
    assert.equal(redact('upstream echoed secret-key-123'), 'upstream echoed [已隐藏密钥]');
  });
});

test('uploads are limited to document and image types', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ozon-up-'));
  const key = path.join(dir, 'id_rsa');
  const pdf = path.join(dir, 'cert.pdf');
  writeFileSync(key, 'private');
  writeFileSync(pdf, '%PDF');
  assert.throws(() => multipart({ files: [key] }), /只允许上传/);
  assert.ok(multipart({ files: [pdf] }));
});

test('identical concurrent reads of a rate-limited endpoint share one request', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon({ '/v1/analytics/data': async () => ({ result: { data: [] } }) });
    const body = { date_from: '2026-10-01', date_to: '2026-10-02', metrics: ['revenue'], dimension: ['day'], limit: 1 };
    const [a, b] = await Promise.all([request('/v1/analytics/data', body), request('/v1/analytics/data', body)]);
    assert.equal(calls.length, 1);
    assert.deepEqual(a.data, b.data);
  });
});

test('capped orders overview keeps the newest postings', async () => {
  await withEnv({}, async () => {
    mockOzon({
      '/v4/posting/fbs/list': (body) => ({ postings: [{ posting_number: body.filter.since, status: 'delivering',
        in_process_at: body.filter.since, products: [] }], has_next: false }),
    });
    const out = parse(await callTool('ozon_orders_overview', { date_from: '2026-10-01', date_to: '2026-10-05', schemes: ['fbs'], max_postings: 2 }));
    assert.equal(out.fbs.complete, false);
    assert.deepEqual(out.recent_postings.map((p) => p.posting_number.slice(0, 10)), ['2026-10-05', '2026-10-04']);
  });
});

const failWith = (code, message) => setFetchForTests(async () => {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
});

test('connection failures report the underlying cause and a fix', async () => {
  await withEnv({}, async () => {
    failWith('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain');
    await assert.rejects(request('/v1/seller/info', {}), /SELF_SIGNED_CERT_IN_CHAIN.*直连.*--use-system-ca/s);
  });
  await withEnv({ HTTPS_PROXY: 'http://user:secret@127.0.0.1:7899' }, async () => {
    failWith('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:7899');
    await assert.rejects(request('/v1/seller/info', {}), (error) => {
      assert.match(error.message, /ECONNREFUSED.*HTTPS_PROXY=http:\/\/127\.0\.0\.1:7899.*代理软件正在运行/s);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  });
  await withEnv({ OZON_API_KEY: 'k-123' }, async () => {
    failWith('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error k-123');
    await assert.rejects(request('/v1/seller/info', {}), (error) => {
      assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT.*OZON_PROXY/s);
      assert.doesNotMatch(error.message, /k-123/);
      return true;
    });
  });
});

test('a malformed proxy variable is named instead of a generic timeout', async () => {
  await withEnv({ HTTPS_PROXY: '127.0.0.1:7890' }, async () => {
    let network = 0;
    setFetchForTests(async () => { network += 1; return json({}); });
    await assert.rejects(request('/v1/seller/info', {}), /代理配置无效（HTTPS_PROXY=（格式无效/);
    assert.equal(network, 0);
    const status = parse(await callTool('ozon_status', {}));
    assert.match(status.proxy, /格式无效/);
    assert.equal(status.node, process.version);
  });
});

test('reported proxy follows undici precedence and never hides the real cause', async () => {
  const status = async () => parse(await callTool('ozon_status', {})).proxy;
  // An empty https_proxy stops the HTTPS chain, so undici falls back to http_proxy.
  // Windows env names are case-insensitive, so the two spellings cannot differ there.
  if (process.platform !== 'win32') {
    await withEnv({ https_proxy: '', HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:2' },
      async () => assert.equal(await status(), 'HTTP_PROXY=http://127.0.0.1:2'));
  }
  await withEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:1080', NO_PROXY: '.ozon.ru' },
    async () => assert.equal(await status(), 'HTTPS_PROXY=socks5://127.0.0.1:1080（NO_PROXY=.ozon.ru）'));
  await withEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'localhost:7890' }, async () => {
    await assert.rejects(request('/v1/seller/info', {}), /代理配置无效（HTTP_PROXY=（格式无效/);
  });
  await withEnv({}, async () => {
    setFetchForTests(async () => {
      const errors = [Object.assign(new Error('connect ETIMEDOUT 185.73.194.107:443'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('connect ETIMEDOUT 185.73.193.82:443'), { code: 'ETIMEDOUT' })];
      throw new TypeError('fetch failed', { cause: Object.assign(new AggregateError(errors, ''), { code: 'ETIMEDOUT' }) });
    });
    await assert.rejects(request('/v1/seller/info', {}), /ETIMEDOUT.*185\.73\.194\.107:443; connect ETIMEDOUT 185\.73\.193\.82/s);
  });
});
