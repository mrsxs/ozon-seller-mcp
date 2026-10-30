// Ozon transport: official-schema validation, fail-closed read-only gate,
// keep-alive connection reuse, local rate-limit protection.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Agent, EnvHttpProxyAgent, FormData, fetch as undiciFetch } from 'undici';
import { OzonError } from './errors.js';
import { redact } from './privacy.js';
import { afterSuccess, beforeRequest, rateLimitText, shareInflight } from './ratelimit.js';
import { enforceMode, validate } from './schema.js';
import { findOperation, mediaSource } from './spec.js';

export const BASE_URL = 'https://api-seller.ozon.ru';
const USER_AGENT = 'Ozon-Seller-MCP/2.0';
const OAUTH_TAGS = new Set(['DeliveryAPI', 'OrderAPI', 'FboPostingAPI', 'CancelReasonAPI']);
const MAX_RESPONSE = 20_000_000;

const HOST = new URL(BASE_URL).host;
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks5:']);

function firstDefined(...keys) {
  const key = keys.find((k) => process.env[k] !== undefined);
  return key ? [key, process.env[key]] : null;
}

// Mirrors undici's EnvHttpProxyAgent for an https:// target: `https_proxy ?? HTTPS_PROXY`,
// falling back to `http_proxy ?? HTTP_PROXY` when that is empty. An empty string stops a chain.
function proxyEnv() {
  const https = firstDefined('https_proxy', 'HTTPS_PROXY');
  const http = firstDefined('http_proxy', 'HTTP_PROXY');
  const set = [https, http].filter((entry) => entry?.[1]);
  return { set, active: set[0] ?? null, noProxy: (firstDefined('no_proxy', 'NO_PROXY')?.[1] ?? '').trim() };
}

// scheme://host:port only; credentials in a proxy URL never reach a result.
function describeProxy([key, raw]) {
  try {
    const url = new URL(raw.trim());
    if (PROXY_SCHEMES.has(url.protocol) && url.host) return { valid: true, text: `${key}=${url.protocol}//${url.host}` };
  } catch {
    // reported as invalid below
  }
  return { valid: false, text: `${key}=（格式无效，应为 http://主机:端口）` };
}

export function proxySummary() {
  const { active, noProxy } = proxyEnv();
  if (!active) return null;
  const text = describeProxy(active).text;
  return noProxy ? `${text}（NO_PROXY=${noProxy.slice(0, 100)}）` : text;
}

let dispatcher;
let dispatcherKey;
function getDispatcher() {
  const env = proxyEnv();
  const key = JSON.stringify(env);
  if (dispatcher && key === dispatcherKey) return dispatcher;
  // undici builds an agent for every proxy variable that is set, so each one must parse.
  const invalid = env.set.map(describeProxy).filter((p) => !p.valid);
  if (invalid.length) {
    throw new OzonError(`代理配置无效（${invalid.map((p) => p.text).join('；')}）。请改为 http://127.0.0.1:端口 这种格式，或删除该环境变量后重启 MCP。`);
  }
  // A TLS handshake to Ozon costs 1.5-2 s from China; keep sockets for reuse between tool calls.
  const options = { keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, headersTimeout: 60_000, bodyTimeout: 60_000, connections: 8 };
  let next;
  try {
    next = env.set.length ? new EnvHttpProxyAgent(options) : new Agent(options);
  } catch (error) {
    throw new OzonError(`代理配置无效（${env.set.map((p) => describeProxy(p).text).join('；')}）：${error.message}`);
  }
  dispatcher?.close().catch(() => {});
  dispatcher = next;
  dispatcherKey = key;
  return dispatcher;
}

const CERT_CODE = /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_TLS|ERR_SSL|DEPTH_ZERO/;
const CONNECT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH',
  'EHOSTUNREACH', 'UND_ERR_SOCKET', 'EPIPE']);

// fetch() only says "fetch failed"; the cause is what tells a seller what to fix on their machine.
export function describeNetworkError(error, elapsedMs) {
  const cause = error?.cause?.code || error?.cause?.message || error?.cause?.errors ? error.cause : error;
  const code = String(cause?.code ?? cause?.name ?? 'UNKNOWN');
  // Happy Eyeballs failures arrive as an AggregateError with an empty message; the per-address errors carry the detail.
  const parts = [cause?.message, ...(Array.isArray(cause?.errors) ? cause.errors.map((e) => e?.message) : [])].filter(Boolean);
  const detail = redact(parts.join('; ') || String(error)).replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 300);
  const proxy = proxySummary();
  let hint = '';
  if (CERT_CODE.test(code) || /certificate/i.test(detail)) {
    hint = 'HTTPS 证书校验失败，通常是杀毒/安全软件、软路由 HTTPS 过滤或公司网关在做 HTTPS 扫描。关闭该功能，'
      + '或在 MCP env 加 "NODE_OPTIONS": "--use-system-ca"（Node ≥ 22.15）后重启 MCP。';
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    hint = `本机解析不到 ${HOST}，检查 DNS 或代理软件的规则。`;
  } else if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    hint = 'Ozon 60 秒内未返回数据，稍后再试或缩小查询范围。';
  } else if (CONNECT_CODES.has(code) || /proxy/i.test(detail)) {
    hint = proxy
      ? `经代理 ${proxy} 连接失败：确认代理软件正在运行、端口正确；不需要代理时从 MCP env 和系统环境变量删除它。`
      : `无法直连 ${HOST}；如果本机要开代理才能访问，在 MCP env 加 "HTTPS_PROXY": "http://127.0.0.1:代理端口"。`;
  }
  return `连接 Ozon 失败（${code}，${Math.round(elapsedMs)} ms，代理：${proxy ?? '未设置，直连'}）。${hint} 原始错误：${detail}`;
}

let fetchImpl = undiciFetch;
export function setFetchForTests(fn) {
  fetchImpl = fn ?? undiciFetch;
}

function credentials() {
  const clientId = (process.env.OZON_CLIENT_ID ?? '').trim();
  const apiKey = (process.env.OZON_API_KEY ?? '').trim();
  if (!clientId || !apiKey) throw new OzonError('请在 MCP 配置 env 中填写 OZON_CLIENT_ID 和 OZON_API_KEY，然后重启 MCP 服务。');
  if (/[\r\n]/.test(clientId + apiKey)) throw new OzonError('凭证包含无效换行，请检查 MCP 环境变量。');
  return [clientId, apiKey];
}

const MIME = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.xml': 'application/xml',
  '.zip': 'application/zip', '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function multipart(body) {
  const form = new FormData();
  let total = 0;
  for (const [key, value] of Object.entries(body)) {
    if (/[\r\n"]/.test(key)) throw new OzonError('无效的 multipart 字段名。');
    for (const item of Array.isArray(value) ? value : [value]) {
      if (key === 'file' || key === 'files') {
        const file = String(item);
        let stat;
        try {
          stat = path.isAbsolute(file) ? statSync(file) : null;
        } catch {
          stat = null;
        }
        if (!stat?.isFile()) throw new OzonError('上传字段必须为存在的本机文件绝对路径。');
        // Only document/image types: a manipulated prompt must not ship key files or configs to Ozon.
        if (!(path.extname(file).toLowerCase() in MIME)) {
          throw new OzonError(`只允许上传以下类型的文件：${Object.keys(MIME).join(' ')}`);
        }
        if (stat.size > 20_000_000) throw new OzonError('单个上传文件超过本服务 20 MB 限制。');
        total += stat.size;
        const name = path.basename(file).replace(/["\r\n]/g, '_');
        const type = MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
        form.append(key, new Blob([readFileSync(file)], { type }), name);
      } else if (key === 'content') {
        if (typeof item !== 'string' || !BASE64.test(item)) throw new OzonError('content 必须为有效的 Base64 文件内容。');
        const bytes = Buffer.from(item, 'base64');
        total += bytes.length;
        form.append('content', new Blob([bytes], { type: 'application/octet-stream' }), 'receipt.bin');
      } else {
        const text = String(item);
        total += Buffer.byteLength(text);
        form.append(key, text);
      }
    }
  }
  if (total > 40_000_000) throw new OzonError('总上传内容超过本服务 40 MB 限制。');
  return form;
}

// int64 IDs beyond 2^53 must survive as exact strings, never as rounded numbers.
let reviverHasSource = false;
JSON.parse('1', (key, value, context) => {
  reviverHasSource = typeof context?.source === 'string';
  return value;
});

// Fallback for runtimes without reviver `context.source` (Node 20): quote unsafe integer
// literals outside strings before parsing.
export function quoteBigIntegers(text) {
  let out = '';
  let last = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + (c === '-' ? 1 : 0);
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j += 1;
      const next = text[j];
      const literal = text.slice(i, j);
      if (next !== '.' && next !== 'e' && next !== 'E' && literal.replace('-', '').length >= 16
          && !Number.isSafeInteger(Number(literal))) {
        out += text.slice(last, i) + '"' + literal + '"';
        last = j;
      }
      i = j - 1;
    }
  }
  return last ? out + text.slice(last) : text;
}

export function parseJson(text) {
  if (!reviverHasSource) return JSON.parse(quoteBigIntegers(text));
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
        && typeof context?.source === 'string' && /^-?[0-9]+$/.test(context.source)) {
      return context.source;
    }
    return value;
  });
}

async function readCapped(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_RESPONSE) {
      await response.body.cancel().catch(() => {});
      throw new OzonError('响应过大，请缩小分页大小。');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function request(endpoint, body = {}, method = 'POST') {
  const op = findOperation(endpoint, method);
  if (!op) throw new OzonError('接口路径或 HTTP 方法未在官方规范中登记，未发送请求。');
  // This gate runs before validation, file reads, credential access, and network I/O.
  enforceMode(op);
  if (body !== null && (typeof body !== 'object' || Array.isArray(body))) throw new OzonError('请求体必须为 JSON 对象。');
  body ??= {};
  validate(op.tool_name, body);
  const [clientId, apiKey] = credentials();
  // A broken proxy setting fails here, before a local rate-limit slot is taken.
  const agent = getDispatcher();
  // Identical concurrent reads of a rate-limited endpoint share one request.
  return shareInflight(op, body, () => beforeRequest(op, body) ?? send(op, body, clientId, apiKey, agent));
}

async function send(op, body, clientId, apiKey, agent) {
  const endpoint = op.path;
  const headers = { 'Client-Id': clientId, 'Api-Key': apiKey, Accept: 'application/json', 'User-Agent': USER_AGENT };
  let payload;
  const [mediaType] = mediaSource(op);
  if (mediaType === 'multipart/form-data') {
    payload = multipart(body);
  } else {
    payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > 2_000_000) throw new OzonError('请求体过大，请缩小查询范围。');
    headers['Content-Type'] = 'application/json';
  }
  if (op.method === 'GET') payload = undefined;
  if (op.tags.some((t) => OAUTH_TAGS.has(t))) {
    const token = (process.env.OZON_ACCESS_TOKEN ?? '').trim();
    if (!token) throw new OzonError('Ozon Delivery 接口需要 OAuth；请在 MCP env 中配置 OZON_ACCESS_TOKEN。');
    if (/[\r\n]/.test(token)) throw new OzonError('OZON_ACCESS_TOKEN 包含无效换行。');
    headers.Authorization = 'Bearer ' + token;
  }

  const start = performance.now();
  // Writes are never automatically retried after an ambiguous outcome.
  for (let attempt = 0; attempt < (op.read_only ? 2 : 1); attempt += 1) {
    let response;
    const sentAt = performance.now();
    try {
      response = await fetchImpl(BASE_URL + endpoint, {
        method: op.method, headers, body: payload, redirect: 'manual', dispatcher: agent,
      });
    } catch (error) {
      throw new OzonError(describeNetworkError(error, performance.now() - sentAt)
        + (op.read_only ? '' : ' 写入结果未知，请先查询业务状态，不要自动重试。'));
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      // Never forward credential headers to a redirected host.
      throw new OzonError(`HTTP ${response.status} ${endpoint}：Ozon 返回重定向，为保护凭证未跟随。`);
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after') ?? '2';
      const delay = Number.isFinite(Number(retryAfter)) ? Math.max(0, Number(retryAfter)) : 2;
      if (op.read_only && attempt === 0 && [429, 502, 503, 504].includes(response.status) && delay <= 5) {
        await response.body?.cancel().catch(() => {});
        await sleep(delay * 1000);
        continue;
      }
      const text = redact((await response.text().catch(() => '')).slice(0, 4096));
      let hint = '检查查询参数与官方接口版本。';
      if (response.status === 401 || response.status === 403) hint = '检查密钥有效期、角色权限、允许网络和店铺要约状态。';
      if (response.status === 429) {
        const rule = rateLimitText(op.path);
        hint = `已触发 Ozon 限流${rule ? `（官方限制：${rule}）` : ''}；Retry-After=${retryAfter} 秒，请告知用户稍后再查。`;
      }
      throw new OzonError(`HTTP ${response.status} ${endpoint}：${hint} ${text}`);
    }
    const raw = await readCapped(response);
    let data;
    if ((response.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
      try {
        data = parseJson(raw.toString('utf8'));
      } catch {
        throw new OzonError('Ozon 返回了无法解析的 JSON。');
      }
    } else {
      data = { content_type: response.headers.get('content-type'), base64: raw.toString('base64') };
    }
    const result = {
      endpoint,
      http_status: response.status,
      queried_at_utc: new Date().toISOString(),
      elapsed_ms: Math.round(performance.now() - start),
      rate_limit_remaining: response.headers.get('ratelimit-remaining'),
      data: redact(data),
    };
    afterSuccess(op, body, result);
    return result;
  }
  throw new OzonError('查询未完成。');
}
