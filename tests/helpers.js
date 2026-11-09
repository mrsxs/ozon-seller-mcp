import { resetAdsToken } from '../src/ads/http.js';
import { setFetchForTests } from '../src/http.js';
import { resetRateLimits } from '../src/ratelimit.js';

const ENV_KEYS = ['OZON_READ_ONLY', 'OZON_TOOLSET', 'OZON_CLIENT_ID', 'OZON_API_KEY', 'OZON_ACCESS_TOKEN',
  'OZON_COMPACT', 'OZON_MAX_RESULT_KB', 'OZON_OUTPUT_DIR', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY', 'OZON_PROXY',
  'OZON_PERF_CLIENT_ID', 'OZON_PERF_CLIENT_SECRET'];

export const PERF_ID = 'perf-id@advertising.performance.ozon.ru';
export const PERF_SECRET = 'perf-secret-value';

export async function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { OZON_CLIENT_ID: '1', OZON_API_KEY: 'test-key', OZON_PERF_CLIENT_ID: PERF_ID, OZON_PERF_CLIENT_SECRET: PERF_SECRET }, vars);
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  resetRateLimits();
  resetAdsToken();
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setFetchForTests(null);
    resetRateLimits();
    resetAdsToken();
  }
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

// routes: { '/v1/path': (body, callIndex) => Response | data }
export function mockOzon(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ path, body, init, url: String(url) });
    const route = routes[path];
    if (!route) throw new Error('unexpected request ' + path);
    const out = await route(body, calls.filter((c) => c.path === path).length);
    return out instanceof Response ? out : json(out);
  };
  setFetchForTests(fetch);
  return calls;
}

export const parse = (result) => JSON.parse(result.content[0].text);
