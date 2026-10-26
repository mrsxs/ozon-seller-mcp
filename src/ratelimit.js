// Official per-endpoint limits, transcribed from the pinned spec descriptions.
// Local counting is per MCP process; Ozon's server-side counter is authoritative.
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

const cacheKey = (op, body) => `${op.method} ${op.path} ${JSON.stringify(body ?? {})}`;

// Returns a cached result for an identical read, throws if the local window is exhausted.
export function beforeRequest(op, body, now = Date.now()) {
  const rule = RATE_LIMITS[op.path];
  if (!rule?.windows) return null;
  if (op.read_only) {
    const hit = cache.get(cacheKey(op, body));
    if (hit && now - hit.at < CACHE_TTL) {
      return { ...hit.result, from_cache: true, cached_at_utc: new Date(hit.at).toISOString() };
    }
  }
  const stamps = (history.get(op.path) ?? []).filter((t) => now - t < DAY);
  history.set(op.path, stamps);
  for (const [window, max] of rule.windows) {
    const used = stamps.filter((t) => now - t < window);
    if (used.length >= max) {
      const wait = Math.min(...used) + window - now;
      throw new RateLimitError(`限流保护：${op.path} 官方限制 ${rule.text}，本进程在限额窗口内已调用过（含被 Ozon 拒绝的调用），约 ${waitText(wait)}后才能再次调用。`
        + '请把等待时间告诉用户；不要重复重试，可合并查询（一次请求多个指标或更长日期范围）。');
    }
  }
  stamps.push(now);
  return null;
}

export function afterSuccess(op, body, result, now = Date.now()) {
  if (!op.read_only || !RATE_LIMITS[op.path]?.windows) return;
  for (const [key, entry] of cache) if (now - entry.at >= CACHE_TTL) cache.delete(key);
  cache.set(cacheKey(op, body), { at: now, result });
}

const inflight = new Map();

export function shareInflight(op, body, fn) {
  if (!op.read_only || !RATE_LIMITS[op.path]?.windows) return Promise.resolve().then(fn);
  const key = cacheKey(op, body);
  if (!inflight.has(key)) {
    inflight.set(key, Promise.resolve().then(fn).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

export function resetRateLimits() {
  history.clear();
  cache.clear();
  inflight.clear();
}
