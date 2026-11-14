// Official per-endpoint limits, transcribed from the pinned spec descriptions.
// Local counting is per MCP process and per seller account (`scope` = Client-Id: Ozon counts each
// account separately); Ozon's server-side counter is authoritative.
import { setTimeout as delay } from 'node:timers/promises';
import { RateLimitError } from './errors.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const supplyDraft = { windows: [[MIN, 2], [HOUR, 50]], text: '2 次/分钟，50 次/小时' };
const itemOps = { text: '按“商品操作数”有每分钟与每天限额，剩余额度用 /v4/product/info/limit 查询' };

export const RATE_LIMITS = {
  '/v1/analytics/data': { windows: [[MIN, 1], [DAY, 50]], text: '1 次/分钟，50 次/天' },
  '/v1/analytics/turnover/stocks': { windows: [[MIN, 1]], text: '1 次/分钟（按 Client-Id 计）' },
  '/v1/warehouse/list': { windows: [[MIN, 1]], text: '1 次/分钟' },
  '/v1/product/placement-zone/info': { windows: [[1000, 10]], text: '10 次/秒' },
  '/v2/draft/create/info': supplyDraft,
  '/v1/draft/crossdock/create': supplyDraft,
  '/v1/draft/direct/create': supplyDraft,
  '/v1/draft/multi-cluster/create': supplyDraft,
  '/v2/draft/supply/create': supplyDraft,
  '/v2/products/stocks': { windows: [[MIN, 80]], text: '80 次/分钟' },
  '/v1/barcode/add': { windows: [[MIN, 20]], text: '20 次/分钟' },
  '/v1/barcode/generate': { windows: [[MIN, 20]], text: '20 次/分钟' },
  '/v1/report/discounted/create': { windows: [[MIN, 1]], text: '1 次/分钟' },
  '/v1/report/placement/by-products/create': { windows: [[DAY, 5]], text: '5 次/天' },
  '/v1/report/placement/by-supplies/create': { windows: [[DAY, 5]], text: '5 次/天' },
  '/v1/product/import/prices': { text: '每个商品的价格 10 次/小时' },
  '/v3/product/import': itemOps,
  '/v1/product/import-by-sku': itemOps,
  '/v1/product/attributes/update': itemOps,
  '/v1/product/pictures/import': itemOps,
  '/v2/product/pictures/import': itemOps,
  '/v1/product/update/offer-id': itemOps,
  '/v1/product/unarchive': itemOps,
  '/v1/posting/fbs/timeslot/set': { text: '每个货件最多修改 2 次配送日期' },
};

const CACHE_TTL = 5 * MIN;
const history = new Map();
const cache = new Map();

export const rateLimitText = (path) => RATE_LIMITS[path]?.text;

function waitText(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 120) return `${s} 秒`;
  if (s < 7200) return `${Math.ceil(s / 60)} 分钟`;
  return `${Math.ceil(s / 3600)} 小时`;
}

const cacheKey = (op, body, scope) => `${scope}|${op.method} ${op.path} ${JSON.stringify(body ?? {})}`;

// Returns a cached result for an identical read. Otherwise only checks, without counting: a request
// the windows or a long cooldown would refuse fails before it waits for anything. The send itself
// is counted by admitSend, right before it goes out.
export function beforeRequest(op, body, now = Date.now(), scope = '') {
  const rule = RATE_LIMITS[op.path];
  if (op.read_only && rule?.windows) {
    const hit = cache.get(cacheKey(op, body, scope));
    if (hit && now - hit.at < CACHE_TTL) {
      return { ...hit.result, from_cache: true, cached_at_utc: new Date(hit.at).toISOString() };
    }
  }
  checkAdmission(op, now, scope);
  return null;
}

function windowStamps(op, now, scope) {
  const historyKey = `${scope}|${op.path}`;
  const stamps = (history.get(historyKey) ?? []).filter((t) => now - t < DAY);
  history.set(historyKey, stamps);
  return stamps;
}

// Throws when a send now would break a long cooldown or an official window; counts nothing.
export function checkAdmission(op, now = Date.now(), scope = '') {
  checkCooldown(op, scope, now);
  const rule = RATE_LIMITS[op.path];
  if (!rule?.windows) return;
  const stamps = windowStamps(op, now, scope);
  for (const [window, max] of rule.windows) {
    const used = stamps.filter((t) => now - t < window);
    if (used.length >= max) {
      const wait = Math.min(...used) + window - now;
      throw new RateLimitError(`限流保护：${op.path} 官方限制 ${rule.text}，本进程在限额窗口内已调用过（含被 Ozon 拒绝的调用），约 ${waitText(wait)}后才能再次调用。`
        + '请把等待时间告诉用户；不要重复重试，可合并查询（一次请求多个指标或更长日期范围）。');
    }
  }
}

// Every request actually sent passes here, retries included, synchronously right before the fetch
// and after any wait: checked and counted in one step, so concurrent waiters cannot all slip
// through a window at the moment a cooldown ends.
export function admitSend(op, now = Date.now(), scope = '') {
  checkAdmission(op, now, scope);
  if (RATE_LIMITS[op.path]?.windows) windowStamps(op, now, scope).push(now);
}

// ---- 429 cooldown and retry budget, per account ----------------------------------------------
// `scope` is the account: the Seller Client-Id, or `perf:<client id>` for the Performance API.
// After a 429 every request of that account waits out Retry-After instead of each caller probing
// again. An endpoint with its own official quota (RATE_LIMITS windows, e.g. /v1/analytics/data at
// 1/min) cools down on its own, so its 429 does not stall the account's other endpoints.
// Automatic retries also draw from a small per-account budget, so a burst of concurrent failures
// cannot double the traffic.

export const DEFAULT_RETRY_MS = 2000; // when Ozon sends no usable Retry-After
export const MAX_RETRY_WAIT_MS = 5000; // longer waits fail fast instead of holding a tool call
const MAX_COOLDOWN_MS = MIN; // a longer Retry-After is still reported, but blocks the account at most this long
const RETRY_BUDGET = { capacity: 4, refillMs: 5000 };
const cooldowns = new Map();
const budgets = new Map();


// Retry-After is either delay-seconds or an HTTP-date (RFC 9110 §10.2.3). Returns ms, or null.
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(text)) return Math.round(Number(text) * 1000);
  // Date.parse also reads bare numbers as years; an HTTP-date always names a month or weekday.
  if (!/[A-Za-z]/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// Spreads callers that wait for the same moment, so they do not all resend at once.
export const withJitter = (ms, random = Math.random) => ms + Math.round(random() * Math.min(1000, 250 + ms * 0.2));

const ownQuota = (op) => Boolean(RATE_LIMITS[op?.path]?.windows);
const cooldownKey = (op, scope) => (ownQuota(op) ? `${scope}|${op.path}` : scope);

export function noteRateLimited(op, scope, waitMs, now = Date.now()) {
  const key = cooldownKey(op, scope);
  const until = now + Math.min(Math.max(0, waitMs), MAX_COOLDOWN_MS);
  if (until > (cooldowns.get(key) ?? 0)) cooldowns.set(key, until);
}

// A request waits for the account's cooldown and, for an endpoint with its own quota, for that one too.
export function cooldownRemaining(op, scope, now = Date.now()) {
  const keys = ownQuota(op) ? [scope, cooldownKey(op, scope)] : [scope];
  return Math.max(0, ...keys.map((key) => (cooldowns.get(key) ?? 0) - now));
}

const cooldownError = (op, remaining) => new RateLimitError(`限流保护：Ozon 刚对该账号${ownQuota(op) ? `的 ${op.path}` : ''}返回 429（请求过多），`
  + `约 ${waitText(remaining)}后才能再次调用。请把等待时间告诉用户；不要重复重试。`);

function checkCooldown(op, scope, now) {
  const remaining = cooldownRemaining(op, scope, now);
  if (remaining > MAX_RETRY_WAIT_MS) throw cooldownError(op, remaining);
}

// Called before every send: waits out a short cooldown (with jitter), fails fast on a long one or
// on one that keeps being extended by fresh 429s. `signal` ends the wait early (it rejects); the
// timer never keeps the process alive on its own.
export async function awaitCooldown(op, scope, signal) {
  for (let round = 0; ; round += 1) {
    const remaining = cooldownRemaining(op, scope);
    if (!remaining) return;
    if (remaining > MAX_RETRY_WAIT_MS || round >= 3) throw cooldownError(op, remaining);
    await delay(withJitter(remaining), undefined, { ref: false, signal });
  }
}

// A retry needs budget left on the account and, for now, room in the endpoint's window; the send
// itself is counted by admitSend after the retry delay, like any other. Returns false instead of
// throwing: the caller reports the original error.
export function admitRetry(op, scope = '', now = Date.now()) {
  const budget = budgets.get(scope) ?? { tokens: RETRY_BUDGET.capacity, at: now };
  budget.tokens = Math.min(RETRY_BUDGET.capacity, budget.tokens + (now - budget.at) / RETRY_BUDGET.refillMs);
  budget.at = now;
  budgets.set(scope, budget);
  if (budget.tokens < 1) return false;
  try {
    checkAdmission(op, now, scope);
  } catch (error) {
    if (error instanceof RateLimitError) return false;
    throw error;
  }
  budget.tokens -= 1;
  return true;
}

export function afterSuccess(op, body, result, now = Date.now(), scope = '') {
  if (!op.read_only || !RATE_LIMITS[op.path]?.windows) return;
  for (const [key, entry] of cache) if (now - entry.at >= CACHE_TTL) cache.delete(key);
  cache.set(cacheKey(op, body, scope), { at: now, result });
}

const inflight = new Map();

export function shareInflight(op, body, fn, scope = '') {
  if (!op.read_only || !RATE_LIMITS[op.path]?.windows) return Promise.resolve().then(fn);
  const key = cacheKey(op, body, scope);
  if (!inflight.has(key)) {
    inflight.set(key, Promise.resolve().then(fn).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

export function resetRateLimits() {
  history.clear();
  cache.clear();
  inflight.clear();
  cooldowns.clear();
  budgets.clear();
}
