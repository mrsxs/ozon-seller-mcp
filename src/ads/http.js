// Performance API transport: client-credentials token, path/query parameters, JSON or CSV responses.
// Shares the proxy setting and socket pool with the Seller API transport.
import { OzonError, ValidationError } from '../errors.js';
import {
  RETRY_STATUSES, WRITE_UNKNOWN, currentFetch, describeNetworkError, discardBody, getDispatcher, parseJson, readErrorText, readResponse,
  sleep,
} from '../http.js';
import { forgetTokens, holdToken, redact, rememberToken } from '../privacy.js';
import {
  DEFAULT_RETRY_MS, MAX_RETRY_WAIT_MS, admitRetry, admitSend, awaitCooldown, checkAdmission, noteRateLimited, parseRetryAfter,
  withJitter,
} from '../ratelimit.js';
import { enforceMode } from '../schema.js';
import { currentShop, hasAds, shops } from '../shops.js';
import { VERSION } from '../version.js';
import { parseCsv } from './csv.js';
import { SAFE_PATH_VALUE, pathParamNames, validateAdsRequest } from './schema.js';
import { ADS_BASE_URL, findAdsOperation, isReportSubmit } from './spec.js';

const HOST = new URL(ADS_BASE_URL).host;
const TOKEN_PATH = '/api/client/token';
const TOKEN_OP = Object.freeze({ path: TOKEN_PATH });
const USER_AGENT = `Ozon-Seller-MCP/${VERSION}`;
const TOKEN_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 30 * 60_000;
const MAX_BODY = 2_000_000;
// A token request serves every caller of the account, so no single caller's budget cancels it;
// it has its own limit instead.
const TOKEN_TIMEOUT_MS = 30_000;
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
  forgetTokens();
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

// Rate-limit scope of a Performance account: its 429 cooldown and retry budget are its own,
// separate from the Seller account of the same shop.
const accountScope = (clientId) => `perf:${clientId}`;

// The Performance client of the shop this call runs as. Not a secret (ozon_status shows it).
export const adsAccount = () => adsCredentials().clientId;

// A time limit for one call: `signal` aborts after `ms`. The timer never keeps the process alive
// on its own (unref) and done() clears it once the work has settled.
export function timeLimit(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return { signal: controller.signal, deadline: Date.now() + ms, done: () => clearTimeout(timer) };
}

const NOT_SENT = '已超过本次调用的时间预算，请求未发送。';
const notSent = () => new OzonError(NOT_SENT);

// Marks a failure of a request's own exchange, after it went out, without a definite answer from
// Ozon: a network error or cancellation during the fetch, an unreadable success body, or a 5xx. Such
// a request may have been carried out (e.g. a report may be being built). Failures before it was
// sent (budget, cooldown, the token phase) and definite refusals (3xx, 4xx) carry no mark.
const outcomeUnknown = (error) => Object.assign(error, { outcomeUnknown: true });
// send() tags failures of the fetch itself; only execute() turns that into outcomeUnknown, for the
// request it was asked to make. A token request's network error never marks a report submission.
const fetchFailed = (error) => Object.assign(error, { fetchFailed: true });

// Settles like `promise`, or rejects once `signal` aborts, whichever comes first: a request, a body
// or a wait that hangs cannot outlive its caller's time budget, whatever the fetch implementation
// does. A rejection of `promise` after the race was lost is handled here, never left unhandled.
export function untilAborted(promise, signal, message = NOT_SENT) {
  const raced = Promise.resolve(promise);
  if (!signal) return raced;
  raced.catch(() => {});
  if (signal.aborted) return Promise.reject(new OzonError(message));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new OzonError(message));
    signal.addEventListener('abort', abort, { once: true });
    raced.then((value) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
      else resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

// Every send waits out the account's shared 429 cooldown, then, right before it goes out, is
// dropped if the caller's budget is used up, or checked and counted by the limiter. Bearer tokens
// in a failure message are hidden by redact(), which knows every token issued in this process.
async function send(url, init, agent, { write = false, scope, op, signal } = {}) {
  try {
    await awaitCooldown(op, scope, signal);
  } catch (error) {
    throw signal?.aborted ? notSent() : error;
  }
  if (signal?.aborted) throw notSent();
  admitSend(op, Date.now(), scope);
  const sentAt = performance.now();
  try {
    return await untilAborted(currentFetch()(url, { ...init, redirect: 'manual', dispatcher: agent, signal }), signal);
  } catch (error) {
    if (signal?.aborted) throw fetchFailed(new OzonError(`等待 Ozon 响应超时，已取消请求。${write ? WRITE_UNKNOWN : ''}`));
    throw fetchFailed(new OzonError(describeNetworkError(error, performance.now() - sentAt, HOST) + (write ? WRITE_UNKNOWN : '')));
  }
}

function rejectRedirect(response, path) {
  if (response.status >= 300 && response.status < 400) {
    discardBody(response);
    throw new OzonError(`HTTP ${response.status} ${path}：Ozon 返回重定向，为保护凭证未跟随。`);
  }
}

const errorText = (response, write = false) => readErrorText(response, write, 2000);

async function requestToken(credentials, agent) {
  const limit = timeLimit(TOKEN_TIMEOUT_MS);
  try {
    return await untilAborted(fetchToken(credentials, agent, limit.signal), limit.signal, 'Performance API 授权请求超时，已取消。');
  } finally {
    limit.done();
  }
}

async function fetchToken({ clientId, secret, shop }, agent, signal) {
  const scope = accountScope(clientId);
  const response = await send(ADS_BASE_URL + TOKEN_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: clientId, client_secret: secret, grant_type: 'client_credentials' }),
  }, agent, { scope, op: TOKEN_OP, signal });
  await rejectRedirect(response, TOKEN_PATH);
  if (response.status === 429) {
    // The token endpoint shares the account's cooldown: every caller waits instead of asking again.
    const delay = parseRetryAfter(response.headers.get('retry-after')) ?? DEFAULT_RETRY_MS;
    noteRateLimited(TOKEN_OP, scope, delay);
    throw new OzonError(`Performance API 授权接口限流（HTTP 429）：Retry-After=${Math.ceil(delay / 1000)} 秒，请告知用户稍后再查，不要重复重试。 `
      + await errorText(response));
  }
  if (!response.ok) {
    const fields = shop.legacy ? 'OZON_PERF_CLIENT_ID 和 OZON_PERF_CLIENT_SECRET' : `店铺「${shop.name}」的 perf_client_id 和 perf_client_secret`;
    const hint = response.status < 500
      ? `检查 ${fields} 是否完整、密钥是否已被删除。${shop.legacy ? CREDENTIAL_HELP : ''}`
      : 'Ozon 授权服务暂时不可用，稍后再试。';
    throw new OzonError(`Performance API 授权失败（HTTP ${response.status}）：${hint} ${await errorText(response)}`);
  }
  const data = await readResponse(response, false, (raw) => {
    try {
      return parseJson(raw.toString('utf8'));
    } catch {
      throw new OzonError('Performance API 授权服务返回了无法解析的内容。');
    }
  });
  if (typeof data?.access_token !== 'string' || !data.access_token) throw new OzonError('Performance API 授权响应缺少 access_token。');
  const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : DEFAULT_TOKEN_TTL_MS;
  // Registered before first use, so no output or log line can carry it unredacted.
  rememberToken(data.access_token, Date.now() + ttl);
  return { clientId, value: data.access_token, expiresAt: Date.now() + Math.max(ttl - TOKEN_MARGIN_MS, ttl / 2) };
}

// `rejected` is the token that just got a 401: a newer cached token is reused, otherwise a new one is
// fetched. The caller waits within its own budget (`signal`); the shared request is not cancelled.
async function getToken(credentials, agent, rejected, signal) {
  const { clientId } = credentials;
  const cached = cachedTokens.get(clientId);
  if (cached && cached.value !== rejected && Date.now() < cached.expiresAt) return cached.value;
  if (signal?.aborted) throw notSent();
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
  return untilAborted(pendingTokens.get(clientId), signal);
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

function readBody(response, write) {
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  return readResponse(response, write, (raw) => decodeBody(type, raw));
}

function decodeBody(type, raw) {
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

async function execute(op, url, payload, credentials, agent, signal) {
  const start = performance.now();
  const headers = { Accept: 'application/json, text/csv', 'User-Agent': USER_AGENT };
  let body;
  if (payload !== undefined && op.method !== 'GET') {
    body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_BODY) throw new OzonError('请求体过大，请缩小查询范围。');
    headers['Content-Type'] = 'application/json';
  }
  const scope = accountScope(credentials.clientId);
  // A report submission is classified read-only, but repeating it could start a second report:
  // like a write, it is never retried automatically.
  const retryable = op.read_only && !isReportSubmit(op);
  const bodyTimedOut = `读取 Ozon 响应超过本次调用的时间预算，已取消。${op.read_only ? '' : WRITE_UNKNOWN}`;
  if (signal?.aborted) throw notSent();
  // Fails before fetching a token when a long cooldown is on; the send itself is counted in send().
  checkAdmission(op, Date.now(), scope);
  let token = await getToken(credentials, agent, undefined, signal);
  // The token stays listed for redaction while this request uses it, even if it is replaced meanwhile.
  let release = holdToken(token);
  let refreshed = false;
  let retried = false;
  try {
    // At most one token refresh (a 401 means nothing was executed) and one retry for reads, within
    // the account's retry budget. Every send waits out the account's shared 429 cooldown.
    for (;;) {
      let response;
      try {
        response = await send(url, { method: op.method, headers: { ...headers, Authorization: `Bearer ${token}` }, body }, agent,
          { write: !op.read_only, scope, op, signal });
      } catch (error) {
        throw error.fetchFailed ? outcomeUnknown(error) : error;
      }
      rejectRedirect(response, op.path);
      if (response.status === 401 && !refreshed) {
        discardBody(response);
        refreshed = true;
        release();
        token = await getToken(credentials, agent, token, signal);
        release = holdToken(token);
        continue;
      }
      if (!response.ok) {
        const delay = parseRetryAfter(response.headers.get('retry-after')) ?? DEFAULT_RETRY_MS;
        if (response.status === 429) noteRateLimited(op, scope, delay);
        if (retryable && !retried && RETRY_STATUSES.has(response.status) && delay <= MAX_RETRY_WAIT_MS && admitRetry(op, scope)) {
          discardBody(response);
          retried = true;
          try {
            await sleep(withJitter(delay), signal);
          } catch (error) {
            throw signal?.aborted ? notSent() : error;
          }
          continue;
        }
        const failure = new OzonError(`HTTP ${response.status} ${op.method} ${op.path}：${failureHint(response.status, Math.ceil(delay / 1000))} `
          + await untilAborted(errorText(response, !op.read_only), signal, bodyTimedOut).catch((error) => error.message));
        throw response.status >= 500 ? outcomeUnknown(failure) : failure;
      }
      // Reading the body is part of the request: the budget covers it too.
      let data;
      try {
        data = await untilAborted(readBody(response, !op.read_only), signal, bodyTimedOut);
      } catch (error) {
        throw outcomeUnknown(error);
      }
      return {
        endpoint: op.path,
        method: op.method,
        http_status: response.status,
        queried_at_utc: new Date().toISOString(),
        elapsed_ms: Math.round(performance.now() - start),
        data: redact(data),
      };
    }
  } finally {
    release();
  }
}

// Checks everything that needs no network (mode, registry, parameters, credentials, proxy) and
// returns the request ready to send. `signal` cancels it, waits included.
export function prepareAdsRequest(endpoint, { method = 'GET', params = {}, body, signal } = {}) {
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
  const agent = getDispatcher();
  return (sendSignal = signal) => execute(op, url, payload, credentials, agent, sendSignal);
}

export async function adsRequest(endpoint, options = {}) {
  return prepareAdsRequest(endpoint, options)();
}
