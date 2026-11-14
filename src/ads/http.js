// Performance API transport: client-credentials token, path/query parameters, JSON or CSV responses.
// Shares the proxy setting and socket pool with the Seller API transport.
import { OzonError, ValidationError } from '../errors.js';
import { currentFetch, describeNetworkError, getDispatcher, parseJson, readCapped, sleep } from '../http.js';
import { redact } from '../privacy.js';
import { enforceMode } from '../schema.js';
import { currentShop, hasAds, shops } from '../shops.js';
import { VERSION } from '../version.js';
import { parseCsv } from './csv.js';
import { SAFE_PATH_VALUE, pathParamNames, validateAdsRequest } from './schema.js';
import { ADS_BASE_URL, findAdsOperation } from './spec.js';

const HOST = new URL(ADS_BASE_URL).host;
const TOKEN_PATH = '/api/client/token';
const USER_AGENT = `Ozon-Seller-MCP/${VERSION}`;
const TOKEN_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 30 * 60_000;
const MAX_BODY = 2_000_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const SAFE_SEGMENT = new RegExp(SAFE_PATH_VALUE);

export const CREDENTIAL_HELP = '在卖家后台 设置 → API 密钥 → Performance API 创建服务账号并添加密钥，'
  + '把 Client ID（以 @advertising.performance.ozon.ru 结尾）和 Client Secret 分别填到 MCP env 的 OZON_PERF_CLIENT_ID、OZON_PERF_CLIENT_SECRET，然后重启 MCP。'
  + '它和 OZON_CLIENT_ID / OZON_API_KEY（Seller API）不是同一组凭证。';

// One token per Performance client: shops alternating in one process must not evict each other's token.
const cachedTokens = new Map();
const pendingTokens = new Map();

export function resetAdsToken() {
  cachedTokens.clear();
  pendingTokens.clear();
}

// True when any shop has Performance API credentials (the ads tools are listed then).
export const adsConfigured = () => shops().some(hasAds);

function adsCredentials() {
  const shop = currentShop();
  if (!hasAds(shop)) {
    throw new OzonError(shop.legacy
      ? `广告数据需要 Performance API 凭证，OZON_PERF_CLIENT_ID / OZON_PERF_CLIENT_SECRET 未配置。${CREDENTIAL_HELP}`
      : `店铺「${shop.name}」没有配置广告凭证（perf_client_id / perf_client_secret）。`);
  }
  if (/[\r\n]/.test(shop.perfClientId + shop.perfSecret)) throw new OzonError('Performance API 凭证包含无效换行，请检查 MCP 环境变量。');
  return { clientId: shop.perfClientId, secret: shop.perfSecret, shop };
}

// Bearer tokens are credentials too: hide the one a request used as well as every cached one.
function hideTokens(text, ...tokens) {
  const cached = [...cachedTokens.values()].map((t) => t.value);
  return [...tokens, ...cached].filter(Boolean).reduce((out, token) => out.replaceAll(token, '[已隐藏令牌]'), String(text));
}

function scrubTokens(data, token) {
  const text = JSON.stringify(data);
  const hidden = hideTokens(text, token);
  return hidden === text ? data : JSON.parse(hidden);
}

async function send(url, init, agent, { write = false } = {}) {
  const sentAt = performance.now();
  try {
    return await currentFetch()(url, { ...init, redirect: 'manual', dispatcher: agent });
  } catch (error) {
    throw new OzonError(describeNetworkError(error, performance.now() - sentAt, HOST)
      + (write ? ' 写入结果未知，请先查询业务状态，不要自动重试。' : ''));
  }
}

async function rejectRedirect(response, path) {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new OzonError(`HTTP ${response.status} ${path}：Ozon 返回重定向，为保护凭证未跟随。`);
  }
}

const errorText = async (response, token) => hideTokens(redact((await response.text().catch(() => '')).slice(0, 2000)), token);

async function requestToken({ clientId, secret, shop }, agent) {
  const response = await send(ADS_BASE_URL + TOKEN_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: clientId, client_secret: secret, grant_type: 'client_credentials' }),
  }, agent);
  await rejectRedirect(response, TOKEN_PATH);
  if (!response.ok) {
    const fields = shop.legacy ? 'OZON_PERF_CLIENT_ID 和 OZON_PERF_CLIENT_SECRET' : `店铺「${shop.name}」的 perf_client_id 和 perf_client_secret`;
    const hint = response.status < 500
      ? `检查 ${fields} 是否完整、密钥是否已被删除。${shop.legacy ? CREDENTIAL_HELP : ''}`
      : 'Ozon 授权服务暂时不可用，稍后再试。';
    throw new OzonError(`Performance API 授权失败（HTTP ${response.status}）：${hint} ${await errorText(response)}`);
  }
  let data;
  try {
    data = parseJson((await readCapped(response)).toString('utf8'));
  } catch {
    throw new OzonError('Performance API 授权服务返回了无法解析的内容。');
  }
  if (typeof data?.access_token !== 'string' || !data.access_token) throw new OzonError('Performance API 授权响应缺少 access_token。');
  const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : DEFAULT_TOKEN_TTL_MS;
  return { clientId, value: data.access_token, expiresAt: Date.now() + Math.max(ttl - TOKEN_MARGIN_MS, ttl / 2) };
}

// `rejected` is the token that just got a 401: a newer cached token is reused, otherwise a new one is fetched.
async function getToken(credentials, agent, rejected) {
  const { clientId } = credentials;
  const cached = cachedTokens.get(clientId);
  if (cached && cached.value !== rejected && Date.now() < cached.expiresAt) return cached.value;
  if (!pendingTokens.has(clientId)) {
    const promise = requestToken(credentials, agent)
      .then((token) => {
        cachedTokens.set(clientId, token);
        return token.value;
      })
      .finally(() => {
        if (pendingTokens.get(clientId) === promise) pendingTokens.delete(clientId);
      });
    pendingTokens.set(clientId, promise);
  }
  return pendingTokens.get(clientId);
}

function buildUrl(op, params) {
  const pathNames = pathParamNames(op);
  let path = op.path;
  for (const name of pathNames) {
    const value = String(params[name]);
    if (!SAFE_SEGMENT.test(value)) throw new ValidationError(`路径参数 ${name} 只能包含字母、数字、- 和 _；未发送请求。`);
    path = path.replaceAll(`{${name}}`, encodeURIComponent(value));
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (pathNames.includes(key) || value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && typeof item === 'object') throw new ValidationError(`查询参数 ${key} 不能是对象；未发送请求。`);
      query.append(key, String(item));
    }
  }
  const search = query.toString();
  return ADS_BASE_URL + path + (search ? `?${search}` : '');
}

const ZIP_NOTE = '这是多个活动打包的 ZIP 报告，本服务不解压。请每次只传一个活动重新生成，或改用对应的 /json 接口。';

async function readBody(response) {
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  const raw = await readCapped(response);
  if (type.includes('json')) {
    if (!raw.length) return {};
    try {
      return parseJson(raw.toString('utf8'));
    } catch {
      throw new OzonError('Ozon 返回了无法解析的 JSON。');
    }
  }
  if (type.includes('csv') || type.startsWith('text/')) return parseCsv(raw.toString('utf8'));
  return { content_type: type || null, bytes: raw.length, note: type.includes('zip') ? ZIP_NOTE : '非文本内容，未返回原始字节。' };
}

function failureHint(status, retryAfter) {
  if (status === 401) return `授权被拒绝。${CREDENTIAL_HELP}`;
  if (status === 403) return '服务账号没有该方法或该活动的权限：在卖家后台给 Performance API 服务账号分配对应权限。';
  if (status === 404) return '对象不存在，或报告尚未生成完毕（先查报告状态）。';
  if (status === 429) {
    return 'Performance API 限流（每天总计 100 000 次；统计报表同一账号同时只能生成 1 个、一次最多 10 个活动、最长 62 天）。'
      + `Retry-After=${retryAfter} 秒，请告知用户稍后再查，不要重复重试。`;
  }
  return '检查参数是否符合官方说明（ozon_ads_api_catalog 传 endpoint 可查看）。';
}

async function execute(op, url, payload, credentials, agent) {
  const start = performance.now();
  const headers = { Accept: 'application/json, text/csv', 'User-Agent': USER_AGENT };
  let body;
  if (payload !== undefined && op.method !== 'GET') {
    body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_BODY) throw new OzonError('请求体过大，请缩小查询范围。');
    headers['Content-Type'] = 'application/json';
  }
  let token = await getToken(credentials, agent);
  let refreshed = false;
  let retried = false;
  // At most one token refresh (a 401 means nothing was executed) and one retry for reads.
  for (;;) {
    const response = await send(url, { method: op.method, headers: { ...headers, Authorization: `Bearer ${token}` }, body }, agent,
      { write: !op.read_only });
    await rejectRedirect(response, op.path);
    if (response.status === 401 && !refreshed) {
      await response.body?.cancel().catch(() => {});
      refreshed = true;
      token = await getToken(credentials, agent, token);
      continue;
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after') ?? '2';
      const delay = Number.isFinite(Number(retryAfter)) ? Math.max(0, Number(retryAfter)) : 2;
      if (op.read_only && !retried && RETRY_STATUSES.has(response.status) && delay <= 5) {
        await response.body?.cancel().catch(() => {});
        retried = true;
        await sleep(delay * 1000);
        continue;
      }
      throw new OzonError(`HTTP ${response.status} ${op.method} ${op.path}：${failureHint(response.status, retryAfter)} ${await errorText(response, token)}`);
    }
    const data = await readBody(response);
    return {
      endpoint: op.path,
      method: op.method,
      http_status: response.status,
      queried_at_utc: new Date().toISOString(),
      elapsed_ms: Math.round(performance.now() - start),
      data: scrubTokens(redact(data), token),
    };
  }
}

export async function adsRequest(endpoint, { method = 'GET', params = {}, body } = {}) {
  const op = findAdsOperation(endpoint, method);
  if (!op) {
    throw new OzonError('广告接口路径或 HTTP 方法未在 Performance API 官方规范中登记，未发送请求；先用 ozon_ads_api_catalog 搜索。');
  }
  // This gate runs before validation, credential access, and network I/O.
  enforceMode(op);
  const query = params ?? {};
  const payload = validateAdsRequest(op, query, body);
  const url = buildUrl(op, query);
  const credentials = adsCredentials();
  return execute(op, url, payload, credentials, getDispatcher());
}
