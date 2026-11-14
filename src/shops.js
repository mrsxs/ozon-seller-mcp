// Shops: OZON_SHOPS (a JSON array, one entry per shop) or the single-shop env variables.
// The shop a tool call runs as travels in AsyncLocalStorage, so both transports pick the right
// credentials without every helper threading a shop argument through.
import { AsyncLocalStorage } from 'node:async_hooks';

const NAME = /^[\p{L}\p{N}_-]{1,32}$/u;
const FIELDS = new Set(['name', 'client_id', 'api_key', 'perf_client_id', 'perf_client_secret', 'access_token', 'market', 'default']);

// Platform-wide market data: the answer does not depend on which shop asks, and Ozon serves it
// only under Premium Pro. These always run as the shop marked "market": true.
export const MARKET_PATHS = new Set([
  '/v1/analytics/category/comparison',
  '/v1/search-queries/top',
  '/v1/search-queries/text',
]);

export class ShopConfigError extends Error {}

const text = (value) => {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return typeof value === 'string' ? value.trim() : '';
};

function legacyShop() {
  const env = (key) => (process.env[key] ?? '').trim();
  return [{
    name: 'default', legacy: true, isDefault: true, market: false,
    clientId: env('OZON_CLIENT_ID'), apiKey: env('OZON_API_KEY'),
    perfClientId: env('OZON_PERF_CLIENT_ID'), perfSecret: env('OZON_PERF_CLIENT_SECRET'),
    accessToken: env('OZON_ACCESS_TOKEN'),
  }];
}

// Messages name the entry and the field, never a value: a value may be a secret.
function parseShops(raw) {
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new ShopConfigError('OZON_SHOPS 不是合法 JSON；应为数组，例如 [{"name":"shop-a","client_id":"…","api_key":"…","market":true}]。');
  }
  if (!Array.isArray(list) || !list.length) throw new ShopConfigError('OZON_SHOPS 必须是至少含一个店铺的 JSON 数组。');
  const seen = new Set();
  const shops = list.map((item, i) => {
    const at = `OZON_SHOPS 第 ${i + 1} 项`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new ShopConfigError(`${at} 必须是对象。`);
    const unknown = Object.keys(item).filter((k) => !FIELDS.has(k));
    if (unknown.length) throw new ShopConfigError(`${at} 有未知字段：${unknown.join('、')}（可用 ${[...FIELDS].join('、')}）。`);
    const name = text(item.name);
    if (!NAME.test(name)) throw new ShopConfigError(`${at} 的 name 必须是 1～32 个字母、数字、汉字、_ 或 -。`);
    if (seen.has(name)) throw new ShopConfigError(`${at} 的 name「${name}」重复。`);
    seen.add(name);
    const shop = {
      name, legacy: false,
      clientId: text(item.client_id), apiKey: text(item.api_key),
      perfClientId: text(item.perf_client_id), perfSecret: text(item.perf_client_secret),
      accessToken: text(item.access_token),
      market: item.market ?? false, isDefault: item.default ?? false,
    };
    if (Boolean(shop.clientId) !== Boolean(shop.apiKey)) {
      throw new ShopConfigError(`店铺「${name}」的 client_id 和 api_key 要么都填，要么都不填。`);
    }
    if (Boolean(shop.perfClientId) !== Boolean(shop.perfSecret)) {
      throw new ShopConfigError(`店铺「${name}」的 perf_client_id 和 perf_client_secret 要么都填，要么都不填。`);
    }
    if (!hasSeller(shop) && !hasAds(shop)) {
      throw new ShopConfigError(`店铺「${name}」至少要填一组凭证：client_id + api_key（Seller API），或 perf_client_id + perf_client_secret（广告）。`);
    }
    for (const flag of ['market', 'isDefault']) {
      if (typeof shop[flag] !== 'boolean') throw new ShopConfigError(`店铺「${name}」的 ${flag === 'market' ? 'market' : 'default'} 只能是 true 或 false。`);
    }
    for (const [field, value] of Object.entries(shop)) {
      if (typeof value === 'string' && /[\r\n]/.test(value)) throw new ShopConfigError(`店铺「${name}」的 ${field} 含有换行。`);
    }
    return shop;
  });
  // Rate limits, the read cache and ad tokens are keyed by these ids: two entries must not share one.
  for (const [field, key] of [['client_id', 'clientId'], ['perf_client_id', 'perfClientId']]) {
    const ids = shops.map((s) => s[key]).filter(Boolean);
    const twice = ids.find((id, i) => ids.indexOf(id) !== i);
    if (twice) throw new ShopConfigError(`OZON_SHOPS 里有两个店铺的 ${field} 相同（${shops.filter((s) => s[key] === twice).map((s) => s.name).join('、')}）。`);
  }
  if (shops.filter((s) => s.market).length > 1) throw new ShopConfigError('OZON_SHOPS 里只能有一个店铺标 "market": true。');
  if (shops.filter((s) => s.isDefault).length > 1) throw new ShopConfigError('OZON_SHOPS 里只能有一个店铺标 "default": true。');
  return shops;
}

let cached;
let cachedFrom;
const ENV_KEYS = ['OZON_SHOPS', 'OZON_CLIENT_ID', 'OZON_API_KEY', 'OZON_PERF_CLIENT_ID', 'OZON_PERF_CLIENT_SECRET', 'OZON_ACCESS_TOKEN'];

export function shops() {
  const from = ENV_KEYS.map((k) => process.env[k] ?? '').join('\u0000');
  if (cached && cachedFrom === from) return cached;
  const raw = (process.env.OZON_SHOPS ?? '').trim();
  cached = raw ? parseShops(raw) : legacyShop();
  cachedFrom = from;
  return cached;
}

export const hasSeller = (shop) => Boolean(shop.clientId && shop.apiKey);
export const hasAds = (shop) => Boolean(shop.perfClientId && shop.perfSecret);

export const multiShop = () => shops().length > 1;
export const defaultShop = () => shops().find((s) => s.isDefault) ?? shops()[0];
// Only an explicit "market": true takes market endpoints away from the shop the caller chose.
export const marketShop = () => shops().find((s) => s.market) ?? null;

export function findShop(name) {
  const shop = shops().find((s) => s.name === name);
  if (!shop) throw new ShopConfigError(`没有名为「${name}」的店铺；可用：${shops().map((s) => s.name).join('、')}。`);
  return shop;
}

const storage = new AsyncLocalStorage();
export const runAsShop = (shop, fn) => storage.run(shop, fn);
export const currentShop = () => storage.getStore() ?? defaultShop();

// Market endpoints run as the market shop (when one is marked) whichever shop the call was made for.
export const shopForPath = (path) => (MARKET_PATHS.has(path) && marketShop()) || currentShop();

// Every configured secret, for redaction. Never throws: a broken config must not break error reporting.
export function allSecrets() {
  const out = [];
  for (const key of ['OZON_API_KEY', 'OZON_ACCESS_TOKEN', 'OZON_PERF_CLIENT_SECRET']) {
    const raw = process.env[key] ?? '';
    out.push(raw, raw.trim());
  }
  try {
    for (const s of shops()) out.push(s.apiKey, s.perfSecret, s.accessToken);
  } catch {
    // config errors are reported by checkConfiguration
  }
  return [...new Set(out.filter(Boolean))];
}
