// Run as a child by tests/ads.test.js. Completes one report submission whose report stays
// IN_PROGRESS (its status keeps answering), then starts an ozon_ads_stats call whose other requests
// never answer, without awaiting it. With no background work and no timer that keeps the process
// alive, Node exits at once: nothing polls that report, and the pending call holds nothing open
// (no 90 s budget, 30 s token limit or 120 s report age keeps it running).
import { setFetchForTests } from '../../src/http.js';
import { callTool } from '../../src/tools.js';

Object.assign(process.env, { OZON_PERF_CLIENT_ID: 'p@advertising.performance.ozon.ru', OZON_PERF_CLIENT_SECRET: 'perf-secret' });
const json = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
let hang = false;
setFetchForTests(async (url) => {
  const path = new URL(url).pathname;
  if (hang && path !== '/api/client/statistics/u-1') return new Promise(() => {});
  if (path === '/api/client/token') return json({ access_token: 'child-token', expires_in: 1800 });
  if (path === '/api/client/statistics/json') return json({ UUID: 'u-1' });
  return json({ state: 'IN_PROGRESS' });
});
const out = await callTool('ozon_ads_api_call', { endpoint: '/api/client/statistics/json', method: 'POST',
  body: { campaigns: ['1'], dateFrom: '2026-10-01', dateTo: '2026-10-01' } });
process.stdout.write(`submitted ${JSON.parse(out.content[0].text).data.UUID}\n`);
hang = true;
callTool('ozon_ads_stats', { date_from: '2026-11-03', date_to: '2026-11-09' });
