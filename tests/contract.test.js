// Ported from the Python contract suite; behaviour must stay identical.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { readOnlyMode } from '../src/config.js';
import { OzonError, ReadOnlyError, ValidationError } from '../src/errors.js';
import { request, setFetchForTests } from '../src/http.js';
import { hidePersonal } from '../src/privacy.js';
import { renderReport } from '../src/reports.js';
import { compileSchema, inputSchema, validate } from '../src/schema.js';
import { OPERATIONS, SPEC, endpointKeys, findOperation } from '../src/spec.js';
import { callTool, listTools } from '../src/tools.js';
import { json, mockOzon, withEnv } from './helpers.js';

const op = (p, method = 'POST') => findOperation(p, method);

test('complete official coverage and valid schemas', () => {
  const expected = new Set();
  for (const [p, methods] of Object.entries(SPEC.paths)) {
    for (const m of Object.keys(methods)) if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) expected.add(`${m.toUpperCase()} ${p}`);
  }
  assert.deepEqual(new Set(endpointKeys()), expected);
  assert.equal(OPERATIONS.size, 482);
  const meta = new Ajv2020({ strict: false });
  for (const name of OPERATIONS.keys()) {
    assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(meta.validateSchema(inputSchema(name)), name);
    compileSchema('op:' + name, inputSchema(name));
  }
});

test('strict parameter constraints', () => {
  const name = op('/v4/posting/fbs/list').tool_name;
  for (const body of [{}, { filter: {}, limit: 101 }, { filter: {}, limit: '1' }, { filter: { invented_field: 1 }, limit: 1 }]) {
    assert.throws(() => validate(name, body), ValidationError, JSON.stringify(body));
  }
  validate(name, { filter: { since: '2026-10-19T00:00:00Z', to: '2026-10-26T00:00:00Z' }, limit: 1, sort_dir: 'ASC' });
  assert.throws(() => validate(name, { filter: {}, limit: 1, sort_dir: 'asc' }), ValidationError);
});

test('all non-read operations block before any I/O in read-only mode', async () => {
  await withEnv({ OZON_READ_ONLY: 'true' }, async () => {
    let network = 0;
    setFetchForTests(async () => {
      network += 1;
      return json({});
    });
    for (const item of OPERATIONS.values()) {
      if (!item.read_only) await assert.rejects(request(item.path, {}, item.method), ReadOnlyError, item.path);
    }
    assert.equal(network, 0);
  });
});

test('read-only flag fails closed', async () => {
  await withEnv({ OZON_READ_ONLY: undefined }, () => assert.equal(readOnlyMode(), true));
  for (const value of ['0', 'off', 'yes', 'typo', '']) {
    await withEnv({ OZON_READ_ONLY: value }, () => assert.throws(() => readOnlyMode()));
  }
  await withEnv({ OZON_READ_ONLY: 'false' }, () => assert.equal(readOnlyMode(), false));
});

test('mode-dependent tool lists and generic call gate', async () => {
  const stocks = op('/v2/products/stocks').tool_name;
  await withEnv({ OZON_READ_ONLY: 'true', OZON_TOOLSET: 'core' }, async () => {
    const names = new Set(listTools().map((t) => t.name));
    assert.ok(!names.has(stocks));
    assert.equal(names.size, 28);
    for (const name of ['ozon_ads_stats', 'ozon_ads_api_catalog', 'ozon_ads_api_call']) assert.ok(names.has(name), name);
    const blocked = await callTool('ozon_api_call', { endpoint: '/v2/products/stocks', body: { stocks: [] } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /OZON_READ_ONLY=true/);
  });
  await withEnv({ OZON_READ_ONLY: 'true', OZON_TOOLSET: 'all' }, () => assert.equal(listTools().length, 6 + 6 + 3 + 268));
  await withEnv({ OZON_READ_ONLY: 'false', OZON_TOOLSET: 'all' }, async () => {
    assert.equal(listTools().length, 6 + 6 + 3 + 482);
    const calls = mockOzon({ '/v2/products/stocks': () => ({ result: [{ updated: true }] }) });
    const result = await callTool(stocks, { stocks: [{ offer_id: 'a', product_id: 1, quant_size: 1, stock: 1, warehouse_id: 1 }] });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(calls.length, 1);
  });
});

test('unknown endpoints never reach the network; redirects are not followed', async () => {
  await withEnv({}, async () => {
    const calls = mockOzon({ '/v3/product/list': () => new Response(null, { status: 302, headers: { location: 'https://example.com' } }) });
    await assert.rejects(request('https://example.com/steal', {}), OzonError);
    assert.equal(calls.length, 0);
    await assert.rejects(request('/v3/product/list', { limit: 1 }), /重定向/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual');
  });
});

test('fields with undefined official type are blocked, not guessed', () => {
  const name = op('/v1/question/answer/list').tool_name;
  assert.throws(() => validate(name, { question_id: 'q', sku: 1, last_id: 'unknown-type' }), ValidationError);
});

test('report output: escaped, no key, no path traversal', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ozon-report-'));
  await withEnv({ OZON_OUTPUT_DIR: directory, OZON_API_KEY: 'test-secret-value' }, () => {
    const report = {
      title: '<script>alert(1)</script>', scope: '仅样本', metrics: [{ label: '样本', value: 0 }],
      sections: [{ title: '<img onerror=alert(1)>', columns: [{ key: 'x', label: '值' }],
        rows: [{ x: '</script><script>alert(1)</script>test-secret-value' }, { x: null }, { x: 0 }] }],
    };
    const result = renderReport(report, 'test.html');
    const doc = readFileSync(result.path, 'utf8');
    assert.ok(!doc.includes('test-secret-value'));
    assert.ok(!doc.includes('</script><script>alert(1)'));
    assert.ok(doc.includes('&lt;script&gt;'));
    assert.ok(doc.includes('\\u003c/script'));
    assert.equal(result.row_count, 3);
    const second = renderReport(report, 'test.html');
    assert.notEqual(result.path, second.path);
    assert.notEqual(renderReport(report, 'test.html').path, second.path);
    assert.throws(() => renderReport(report, '../escape.html'));
  });
});

test('customer contact data is removed', () => {
  const value = { postings: [{ posting_number: '1', customer: { phone: 'secret' }, addressee: { name: 'secret' } }] };
  assert.deepEqual(hidePersonal(value), { postings: [{ posting_number: '1' }] });
});

test('required names without a definition are passable (e.g. quant_size), typed fields stay strict', () => {
  const name = op('/v2/products/stocks').tool_name;
  validate(name, { stocks: [{ product_id: 1, quant_size: 1, stock: 1, warehouse_id: 1 }] });
  validate(name, { stocks: [{ product_id: 1, stock: 1, warehouse_id: 1 }] });
  assert.throws(() => validate(name, { stocks: [{ product_id: 1, stock: 1 }] }), /缺少必填字段 warehouse_id/);
  assert.throws(() => validate(name, { stocks: [{ product_id: 1, stock: 1, warehouse_id: 1, invented: 1 }] }), /invented/);
});

test('integers beyond 2^53 are refused with a clear message instead of being sent rounded', async () => {
  const stocks = op('/v2/products/stocks').tool_name;
  // What a client's JSON parser makes of the ID 9007199254740993.
  const rounded = JSON.parse('{"stocks":[{"product_id":9007199254740993,"stock":1,"warehouse_id":1}]}');
  assert.equal(rounded.stocks[0].product_id, 9007199254740992);
  assert.throws(() => validate(stocks, rounded), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.match(error.message, /\$\.stocks\[0\]\.product_id 整数超出安全范围.*未发送请求/);
    assert.doesNotMatch(error.message, /9007199254740992/, 'values are never echoed');
    return true;
  });
  validate(stocks, { stocks: [{ product_id: Number.MAX_SAFE_INTEGER, stock: 1, warehouse_id: 1 }] });
  await withEnv({ OZON_READ_ONLY: 'false' }, async () => {
    const calls = mockOzon({});
    const out = await callTool(stocks, rounded);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /安全范围/);
    // Plain `integer` fields without an int64 format, in hand-written and ads schemas alike.
    assert.match((await callTool('ozon_stock_overview', { low_stock_threshold: 2 ** 53 })).content[0].text, /安全范围/);
    assert.match((await callTool('ozon_ads_api_call', { endpoint: '/api/client/campaign/{campaignId}/v2/products', method: 'GET',
      params: { campaignId: '1', pageSize: 2 ** 60 } })).content[0].text, /安全范围/);
    assert.equal(calls.length, 0);
  });
});

test('date-time fields are checked: calendar date, time of day and offset', async () => {
  const fbo = op('/v3/posting/fbo/list').tool_name;
  const body = (since, to = '2026-10-02T00:00:00Z') => ({ filter: { since, to }, limit: 10 });
  for (const since of ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00.106Z', '2026-10-01T03:00:00+03:00', '2024-02-29T23:59:59-05:30']) {
    validate(fbo, body(since));
  }
  for (const since of ['not-a-date', '2026-10-01', '2026-10-01T00:00:00', '2026-13-01T00:00:00Z', '2026-02-29T00:00:00Z',
    '2026-10-01T24:00:00Z', '2026-10-01T10:60:00Z', '2026-10-01T00:00:00+24:00', '2026-10-01 00:00:00Z']) {
    assert.throws(() => validate(fbo, body(since)), /\$\.filter\.since 不符合 format 约束（规则："date-time"）/, since);
  }
  assert.throws(() => validate(fbo, body('2026-10-01T00:00:00Z', 'also-not-a-date')), /\$\.filter\.to/);
  // Typed date-time but documented and exemplified as `YYYY-MM-DD`: both forms pass, nonsense does not.
  const balance = op('/v1/finance/balance').tool_name;
  validate(balance, { date_from: '2026-10-01', date_to: '2026-10-30' });
  validate(balance, { date_from: '2026-10-01T00:00:00Z', date_to: '2026-10-30T00:00:00Z' });
  assert.throws(() => validate(balance, { date_from: 'not-a-date', date_to: '2026-10-30' }), /date_from/);
  await withEnv({}, async () => {
    const calls = mockOzon({});
    const out = await callTool('ozon_api_call', { endpoint: '/v3/posting/fbo/list', body: body('not-a-date', 'also-not-a-date') });
    assert.equal(out.isError, true);
    assert.equal(calls.length, 0);
  });
});

test('date-time accepts the RFC 3339 leap second, only at 23:59:60 UTC', async () => {
  const { isDateTime } = await import('../src/schema.js');
  for (const ok of ['2016-12-31T23:59:60Z', '2016-12-31T15:59:60-08:00', '2017-01-01T02:59:60+03:00', '2016-12-31T23:59:60.5Z']) {
    assert.equal(isDateTime(ok), true, ok);
  }
  for (const bad of ['2026-10-01T12:00:60Z', '2016-12-31T23:59:61Z', '2016-12-31T23:59:60+01:00']) assert.equal(isDateTime(bad), false, bad);
  validate(op('/v3/posting/fbo/list').tool_name, { filter: { since: '2016-12-31T23:59:60Z', to: '2017-01-01T00:00:00Z' }, limit: 10 });
});
