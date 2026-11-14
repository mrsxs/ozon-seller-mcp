import assert from 'node:assert/strict';
import test from 'node:test';
import { dropEmpty, fitToBudget } from '../src/compact.js';
import { RateLimitError } from '../src/errors.js';
import { multipart, request, setFetchForTests } from '../src/http.js';
import { admitSend, afterSuccess, beforeRequest } from '../src/ratelimit.js';
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

// beforeRequest serves the cache and checks; admitSend counts the actual send, right before it goes out.
test('rate limiter: blocks inside the window, caches identical reads, enforces the daily cap', async () => {
  await withEnv({}, () => {
    assert.equal(beforeRequest(ANALYTICS, { a: 1 }, 0), null);
    assert.equal(beforeRequest(ANALYTICS, { a: 3 }, 0), null, 'a check alone counts nothing');
    admitSend(ANALYTICS, 0);
    afterSuccess(ANALYTICS, { a: 1 }, { data: 'first' }, 0);
    assert.equal(beforeRequest(ANALYTICS, { a: 1 }, 1000).from_cache, true);
    assert.throws(() => beforeRequest(ANALYTICS, { a: 2 }, 1000), (e) => e instanceof RateLimitError && /1 次\/分钟/.test(e.message));
    let now = 0;
    for (let i = 1; i < 50; i += 1) {
      now += 61_000;
      assert.equal(beforeRequest(ANALYTICS, { i }, now), null);
      admitSend(ANALYTICS, now);
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
  await withEnv({ OZON_TOOLSET: 'minimal,/v3/product/list' }, () => assert.equal(listTools().length, 16));
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

// ---- review fixes (2026-11-14) -----------------------------------------------------------------

test('Retry-After is read as delay-seconds or as an HTTP-date; jitter stays bounded', async () => {
  const { parseRetryAfter, withJitter } = await import('../src/ratelimit.js');
  const now = Date.parse('2026-11-14T10:00:00Z');
  assert.equal(parseRetryAfter('3', now), 3000);
  assert.equal(parseRetryAfter(' 1.5 ', now), 1500);
  assert.equal(parseRetryAfter('Sat, 14 Nov 2026 10:00:30 GMT', now), 30_000, 'an HTTP-date is not "2 seconds"');
  assert.equal(parseRetryAfter('Sat, 14 Nov 2026 09:59:00 GMT', now), 0, 'a date in the past means now');
  for (const bad of [null, undefined, '', 'soon', '-1', '1 2', '2026-11-14']) assert.equal(parseRetryAfter(bad, now), null, String(bad));
  assert.equal(withJitter(1000, () => 0), 1000);
  assert.equal(withJitter(1000, () => 1), 1450);
  assert.equal(withJitter(60_000, () => 1), 61_000, 'jitter is capped at 1 s');
});

const ANALYTICS_BODY = { date_from: '2026-10-01', date_to: '2026-10-02', metrics: ['revenue'], dimension: ['day'], limit: 1 };

test('a retry goes through the local limiter: a 429 on a 1/min endpoint is not resent', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon({ '/v1/analytics/data': () => json({ message: 'slow down' }, 429, { 'retry-after': '0' }) });
    await assert.rejects(request('/v1/analytics/data', ANALYTICS_BODY), /官方限制：1 次\/分钟，50 次\/天/);
    assert.equal(calls.length, 1, 'the retry would be a second call inside the minute');
  });
});

test('a 429 cools the account down for every caller; HTTP-date Retry-After is honoured', async () => {
  await withEnv({}, async () => {
    const retryAt = new Date(Date.now() + 31_000).toUTCString();
    const calls = mockOzon({
      '/v3/product/list': () => json({ message: 'too many' }, 429, { 'retry-after': retryAt }),
      '/v1/seller/info': () => ({ company: {} }),
    });
    await assert.rejects(request('/v3/product/list', { limit: 1 }), (error) => {
      assert.match(error.message, /Retry-After=(30|31) 秒/);
      return true;
    });
    // Another endpoint of the same account waits for the cooldown instead of probing Ozon again.
    await assert.rejects(request('/v1/seller/info', {}), /限流保护：Ozon 刚对该账号返回 429.*约 (30|31) 秒/);
    assert.deepEqual(calls.map((c) => c.path), ['/v3/product/list']);
  });
});

test('a 429 on an endpoint with its own quota cools down that endpoint only', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon({
      '/v1/analytics/data': () => json({}, 429, { 'retry-after': '40' }),
      '/v3/product/list': () => ({ result: { items: [] } }),
    });
    await assert.rejects(request('/v1/analytics/data', ANALYTICS_BODY), /HTTP 429/);
    assert.equal((await request('/v3/product/list', { limit: 1 })).http_status, 200);
    assert.deepEqual(calls.map((c) => c.path), ['/v1/analytics/data', '/v3/product/list']);
  });
});

test('the cooldown is per seller account: another shop is not held back', async () => {
  const shops = JSON.stringify([{ name: 'a', client_id: '1', api_key: 'ka' }, { name: 'b', client_id: '2', api_key: 'kb' }]);
  await withEnv({ OZON_SHOPS: shops }, async () => {
    const calls = mockOzon({ '/v1/seller/info': () => (calls.at(-1).init.headers['Client-Id'] === '1' ? json({}, 429, { 'retry-after': '20' }) : { company: {} }) });
    assert.equal((await callTool('ozon_api_call', { endpoint: '/v1/seller/info', body: {}, shop: 'a' })).isError, true);
    assert.equal((await callTool('ozon_api_call', { endpoint: '/v1/seller/info', body: {}, shop: 'b' })).isError, undefined);
    assert.match((await callTool('ozon_api_call', { endpoint: '/v1/seller/info', body: {}, shop: 'a' })).content[0].text, /限流保护/);
    assert.deepEqual(calls.map((c) => c.init.headers['Client-Id']), ['1', '2']);
  });
});

test('concurrent 429s do not double the traffic: retries draw from a per-account budget', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon({ '/v3/product/list': () => json({}, 429, { 'retry-after': '0' }) });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => request('/v3/product/list', { limit: i + 1 })));
    assert.ok(results.every((r) => r.status === 'rejected'));
    assert.equal(calls.length, 14, '10 sends + 4 budgeted retries, not 20');
  });
});

// A response whose body breaks off after the first chunk.
function brokenBody(contentType = 'application/json', status = 200) {
  let sent = false;
  const body = new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.error(new TypeError('terminated', { cause: Object.assign(new Error('socket reset while reading response'), { code: 'ECONNRESET' }) }));
      } else {
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"result":['));
      }
    },
  });
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

test('a write whose response body fails to arrive or parse reports an unknown outcome', async () => {
  const STOCKS = { stocks: [{ offer_id: 'a', product_id: 1, stock: 1, warehouse_id: 1 }] };
  await withEnv({ OZON_READ_ONLY: 'false' }, async () => {
    const calls = mockOzon({ '/v2/products/stocks': () => brokenBody(), '/v3/product/list': () => brokenBody() });
    await assert.rejects(request('/v2/products/stocks', STOCKS), (error) => {
      assert.match(error.message, /读取 Ozon 响应时连接中断.*socket reset while reading response/);
      assert.match(error.message, /写入结果未知，请先查询业务状态，不要自动重试/);
      return true;
    });
    // A read that breaks off says what happened, without the write warning.
    await assert.rejects(request('/v3/product/list', { limit: 1 }), (error) => {
      assert.match(error.message, /读取 Ozon 响应时连接中断/);
      assert.doesNotMatch(error.message, /写入结果未知/);
      return true;
    });
    assert.equal(calls.filter((c) => c.path === '/v2/products/stocks').length, 1, 'never retried');

    mockOzon({ '/v2/products/stocks': () => new Response('{"result":[', { headers: { 'content-type': 'application/json' } }) });
    await assert.rejects(request('/v2/products/stocks', STOCKS), /无法解析的 JSON.*写入结果未知/);
  });
});

test('the Node 20 big-integer fallback leaves decimals and exponents intact', async () => {
  const { quoteBigIntegers } = await import('../src/http.js');
  const text = '{"a":0.123456789012345678,"b":-0.123456789012345678,"c":1.5e+20,"d":12345678901234567890e-2,'
    + '"e":[1020005028488300123,0.5,-1020005028488300123],"f":123456789012345678.9,"g":"0.123456789012345678"}';
  const out = JSON.parse(quoteBigIntegers(text));
  assert.equal(out.a, 0.123456789012345678);
  assert.equal(out.b, -0.123456789012345678);
  assert.equal(out.c, 1.5e20);
  assert.equal(typeof out.d, 'number', 'an exponent makes it not an integer token');
  assert.deepEqual(out.e, ['1020005028488300123', 0.5, '-1020005028488300123']);
  assert.equal(typeof out.f, 'number');
  assert.equal(out.g, '0.123456789012345678');
});

test('revenue is labelled RUB everywhere; product prices carry price_currency', async () => {
  await withEnv({}, async () => {
    mockOzon(topProductRoutes());
    const top = parse(await callTool('ozon_top_products', { limit: 2 }));
    assert.equal(top.revenue_currency, 'RUB');
    assert.equal(top.period_totals_all_skus.revenue_currency, 'RUB');
    for (const item of top.items) {
      assert.equal(item.revenue_currency, 'RUB');
      assert.equal(item.price_currency, 'CNY');
      assert.equal(item.currency, 'CNY', 'the old field stays for existing readers');
    }
    assert.ok(top.notes.some((n) => /卢布/.test(n) && /price_currency/.test(n)), JSON.stringify(top.notes));
    const tools = new Map(listTools().map((t) => [t.name, t]));
    assert.match(tools.get('ozon_top_products').description, /revenue 单位卢布/);
    assert.match(tools.get('ozon_sales_overview').description, /revenue 单位卢布/);
  });
  await withEnv({}, async () => {
    const calls = mockOzon({
      '/v1/analytics/data': () => ({ result: { data: [{ dimensions: [{ id: '2026-10-01' }], metrics: [3, 450.5] }], totals: [3, 450.5] } }),
      // Typed date-time in the spec but documented (and accepted) as YYYY-MM-DD.
      '/v1/finance/balance': () => ({ total: { opening_balance: { value: 1, currency_code: 'CNY' } } }),
    });
    const sales = parse(await callTool('ozon_sales_overview', { date_from: '2026-10-01', date_to: '2026-10-01' }));
    assert.equal(sales.revenue_currency, 'RUB');
    assert.equal(sales.totals.revenue_currency, 'RUB');
    assert.equal(sales.series[0].revenue, 450.5);
    assert.ok(sales.finance, JSON.stringify(sales.notes));
    assert.deepEqual(calls.find((c) => c.path === '/v1/finance/balance').body, { date_from: '2026-10-01', date_to: '2026-10-01' });
  });
});

test('error output and crash logs hide configured keys and runtime ad tokens', async () => {
  const { rememberToken, redactText } = await import('../src/privacy.js');
  await withEnv({ OZON_API_KEY: 'cfg-secret-123' }, () => {
    rememberToken('runtime-token-abc', Date.now() + 60_000);
    const error = new Error('boom: Api-Key cfg-secret-123, Authorization: Bearer runtime-token-abc');
    const line = redactText(error);
    assert.match(line, /\[已隐藏密钥\].*\[已隐藏令牌\]/);
    assert.match(line, /\n\s+at /, 'the stack is kept');
    assert.ok(!line.includes('cfg-secret-123') && !line.includes('runtime-token-abc'));
    assert.equal(redactText({ toString() { throw new Error('x'); } }), '（无法转换为文本的错误）');
  });
});

test('the entry point redacts uncaught errors and rejections it logs to stderr', async () => {
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const token = 'leaky-bearer-token-0123456789';
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests', 'fixtures', 'crash-with-token.mjs')).href,
    path.join(root, 'bin', 'ozon-seller-mcp.js')], {
    env: { ...process.env, OZON_SHOPS: '', OZON_CLIENT_ID: '', OZON_API_KEY: 'cfg-secret-456', OZON_PERF_CLIENT_ID: '', OZON_PERF_CLIENT_SECRET: '',
      TEST_LEAK_TOKEN: token },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no crash log within 10 s: ${stderr}`)), 10_000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.includes('uncaughtException') && stderr.includes('unhandledRejection')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`server exited (${code}): ${stderr}`)));
    });
  } finally {
    child.kill();
  }
  assert.ok(!stderr.includes(token), stderr);
  assert.ok(!stderr.includes('cfg-secret-456'), stderr);
  assert.match(stderr, /uncaughtException: Error: boom Authorization: Bearer \[已隐藏令牌\] Api-Key \[已隐藏密钥\]/);
  assert.match(stderr, /unhandledRejection: Error: rejected \[已隐藏令牌\]/);
});

// ---- second review round (2026-11-14) ----------------------------------------------------------

test('runtime tokens still valid or in use are never dropped; only expired history is capped', async () => {
  const { rememberToken, holdToken, redact } = await import('../src/privacy.js');
  await withEnv({}, () => {
    const name = (kind, i) => `${kind}-${String(i).padStart(3, '0')}-tok`;
    rememberToken('valid-first-tok', Date.now() + 60_000);
    rememberToken('expired-in-flight-tok', Date.now() - 1);
    const release = holdToken('expired-in-flight-tok');
    for (let i = 0; i < 200; i += 1) rememberToken(name('valid', i), Date.now() + 60_000);
    for (let i = 0; i < 200; i += 1) rememberToken(name('history', i), Date.now() - 1);
    assert.equal(redact('valid-first-tok expired-in-flight-tok'), '[已隐藏令牌] [已隐藏令牌]');
    assert.equal(redact(name('valid', 0)), '[已隐藏令牌]', 'more than 64 valid tokens are all kept');
    assert.equal(redact(name('history', 199)), '[已隐藏令牌]', 'recent history is kept');
    assert.equal(redact(name('history', 0)), name('history', 0), 'only old expired history is dropped');
    release();
    for (let i = 0; i < 100; i += 1) rememberToken(name('later', i), Date.now() - 1);
    assert.equal(redact('expired-in-flight-tok'), 'expired-in-flight-tok', 'once released it is ordinary history');
  });
});

const PLACEMENT = '/v1/product/placement-zone/info'; // official 10 requests/second

test('the limiter counts each send right before it goes out, after any cooldown wait', async () => {
  const { noteRateLimited } = await import('../src/ratelimit.js');
  await withEnv({}, async () => {
    const sentAt = [];
    mockOzon({ [PLACEMENT]: () => {
      sentAt.push(Date.now());
      return { items: [] };
    } });
    // The account (Client-Id 1) cools down for 1.2 s; a second batch arrives once the first one's
    // checks are more than a second old. Counted before the wait, both batches went out together.
    noteRateLimited({ path: '/v1/seller/info' }, '1', 1200);
    const call = (i) => request(PLACEMENT, { skus: [String(1000 + i)] });
    const first = Array.from({ length: 10 }, (_, i) => call(i));
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const second = Array.from({ length: 10 }, (_, i) => call(100 + i));
    const results = await Promise.allSettled([...first, ...second]);
    assert.equal(sentAt.length, 10, 'at most 10 sends within one second');
    const refused = results.filter((r) => r.status === 'rejected');
    assert.equal(refused.length, 10);
    for (const r of refused) assert.match(r.reason.message, /限流保护：\/v1\/product\/placement-zone\/info 官方限制 10 次\/秒/);
  });
});

test('a retry is counted when it is sent: a window filled during its delay refuses it', async () => {
  await withEnv({}, async () => {
    let calls = 0;
    mockOzon({ [PLACEMENT]: (body) => {
      calls += 1;
      return body.skus[0] === '1' && calls === 1 ? json({}, 503, { 'retry-after': '1.1' }) : { items: [] };
    } });
    const retried = request(PLACEMENT, { skus: ['1'] });
    // While the retry waits, the first send drops out of the window and ten others fill it.
    await new Promise((resolve) => setTimeout(resolve, 1020));
    const others = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => request(PLACEMENT, { skus: [String(100 + i)] })));
    assert.ok(others.every((r) => r.status === 'fulfilled'));
    await assert.rejects(retried, /HTTP 503 \/v1\/product\/placement-zone\/info，未重试：限流保护.*10 次\/秒/);
    assert.equal(calls, 11, 'the first attempt and ten others; the retry did not go out');
  });
});

test('a write whose error response breaks off says the outcome is unknown', async () => {
  const STOCKS = { stocks: [{ offer_id: 'a', product_id: 1, stock: 1, warehouse_id: 1 }] };
  await withEnv({ OZON_READ_ONLY: 'false' }, async () => {
    mockOzon({ '/v2/products/stocks': () => brokenBody('application/json', 502), '/v3/product/list': () => brokenBody('application/json', 400) });
    await assert.rejects(request('/v2/products/stocks', STOCKS), (error) => {
      assert.match(error.message, /^HTTP 502 \/v2\/products\/stocks：.*读取 Ozon 响应时连接中断.*socket reset/);
      assert.match(error.message, /写入结果未知，请先查询业务状态，不要自动重试/);
      return true;
    });
    await assert.rejects(request('/v3/product/list', { limit: 1 }), (error) => {
      assert.match(error.message, /^HTTP 400 .*读取 Ozon 响应时连接中断/);
      assert.doesNotMatch(error.message, /写入结果未知/);
      return true;
    });
  });
});

test('a body cancel that never settles does not hold a Seller retry or redirect', async () => {
  const stuck = (status, headers = {}) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{}'));
    },
    cancel() {
      return new Promise(() => {});
    },
  }), { status, headers: { 'content-type': 'application/json', ...headers } });
  const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms).unref();
  })]);
  await withEnv({}, async () => {
    mockOzon({
      '/v3/product/list': (_, n) => (n === 1 ? stuck(503, { 'retry-after': '0' }) : { result: { items: [] } }),
      '/v1/seller/info': () => stuck(302, { location: 'https://example.com/' }),
    });
    assert.equal((await within(request('/v3/product/list', { limit: 1 }), 2000)).http_status, 200);
    await within(assert.rejects(request('/v1/seller/info', {}), /重定向/), 2000);
  });
});

test('a response over the size cap is cut off even when its stream cancel never settles', async () => {
  const chunk = new Uint8Array(1_000_000).fill(32);
  const oversized = () => new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk); // never ends: 21 MB pass the 20 MB cap
    },
    cancel() {
      return new Promise(() => {});
    },
  }), { headers: { 'content-type': 'application/json' } });
  const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms).unref();
  })]);
  await withEnv({}, async () => {
    mockOzon({ '/v3/product/list': oversized });
    await within(assert.rejects(request('/v3/product/list', { limit: 1 }), /响应过大/), 5000);
  });
});
