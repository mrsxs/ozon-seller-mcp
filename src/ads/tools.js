// MCP tools for the Ozon Performance API (advertising cabinet).
import { readOnlyMode } from '../config.js';
import { adsConfigured, adsRequest } from './http.js';
import { describeAds } from './schema.js';
import { ADS_OPERATIONS, ADS_SOURCE, findAdsOperation } from './spec.js';
import { DEFAULT_THRESHOLDS, adsStats } from './stats.js';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const date = (description) => ({ type: 'string', format: 'date', description });

// Without a method, a path that exists under exactly one method resolves to it.
function resolveOperation(endpoint, method) {
  if (method) return findAdsOperation(endpoint, method);
  const matches = HTTP_METHODS.map((m) => findAdsOperation(endpoint, m)).filter(Boolean);
  if (matches.length > 1) throw new Error(`${endpoint} 有多个 HTTP 方法（${matches.map((o) => o.method).join('/')}），请指定 method。`);
  return matches[0];
}

function catalog(args) {
  if (args.endpoint) {
    const op = resolveOperation(args.endpoint, args.method);
    if (!op) throw new Error('未登记的广告接口路径或 HTTP 方法；先不带 endpoint 搜索 ozon_ads_api_catalog。');
    return describeAds(op);
  }
  const query = (args.query ?? '').toLowerCase();
  const found = ADS_OPERATIONS.filter((op) => JSON.stringify(op).toLowerCase().includes(query));
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 30;
  return {
    total: found.length,
    offset,
    has_next: offset + limit < found.length,
    operations: found.slice(offset, offset + limit).map((op) => ({
      method: op.method, path: op.path, summary: op.summary, summary_ru: op.summary_ru, tags: op.tags,
      read_only: op.read_only, enabled: !readOnlyMode() || op.read_only, json_variant_of: op.json_variant_of,
    })),
    source: ADS_SOURCE,
    hint: '传 endpoint（可加 method）查看参数说明；调用用 ozon_ads_api_call。报表类接口优先用带 /json 的版本。',
  };
}

async function call(args) {
  const op = resolveOperation(args.endpoint, args.method);
  if (!op) throw new Error('未登记的广告接口路径或 HTTP 方法；先用 ozon_ads_api_catalog 搜索。');
  return adsRequest(op.path, { method: op.method, params: args.params ?? {}, body: args.body });
}

const thresholdProps = {
  target_drr: { type: 'number', minimum: 0, maximum: 1000, default: DEFAULT_THRESHOLDS.target_drr, description: 'DRR 目标上限（%），应按商品毛利率设置' },
  min_views: { type: 'integer', minimum: 0, default: DEFAULT_THRESHOLDS.min_views, description: '展示少于该值不评判点击率' },
  min_clicks: { type: 'integer', minimum: 0, default: DEFAULT_THRESHOLDS.min_clicks, description: '点击少于该值不评判转化' },
  low_ctr_ratio: { type: 'number', minimum: 0, maximum: 1, default: DEFAULT_THRESHOLDS.low_ctr_ratio, description: '点击率低于本活动均值的该比例时标记' },
};

const ADS_TOOLS = [
  {
    name: 'ozon_ads_stats',
    description: '【一次调用】按点击付费（CPC）广告分析：每个活动和每个商品的展示、点击、点击率、加购率、下单率、花费、平均点击价、单均成本、DRR，'
      + '并标出点击率偏低、有点击无订单、DRR 超标的商品。查“广告数据/点击率/CTR/推广效果/哪个广告亏钱”时用它。'
      + '活动汇总秒回；商品明细走官方异步报表（含本期已移出活动的商品），通常要等 10–30 秒，调用前告诉用户稍等。默认最近 7 天（莫斯科时间，含今天），最长 62 天。',
    inputSchema: obj({
      date_from: date('开始日期 YYYY-MM-DD（莫斯科时间）'),
      date_to: date('结束日期 YYYY-MM-DD，默认今天'),
      days: { type: 'integer', minimum: 1, maximum: 62, default: 7, description: '未填 date_from 时统计最近多少天' },
      campaign_ids: { type: 'array', items: { type: ['string', 'integer'] }, minItems: 1, maxItems: 100, description: '只看这些活动 ID' },
      include_archived: { type: 'boolean', default: false, description: '是否包含已归档活动' },
      include_products: { type: 'boolean', default: true, description: '是否生成商品明细（异步报表，通常 10–30 秒；false 只看活动汇总，秒回）' },
      product_limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: '商品行按花费降序最多返回多少行' },
      ...thresholdProps,
    }),
    annotations: RO,
    handler: adsStats,
  },
  {
    name: 'ozon_ads_api_catalog',
    description: `搜索 Ozon Performance API（广告）全部 ${ADS_OPERATIONS.length} 个接口（含官方说明中的 /json 报表版本），或传 endpoint 查看参数、请求体与响应定义；不联网。`,
    inputSchema: obj({
      query: { type: 'string', default: '', description: '按路径、名称、分组搜索，如 statistics、campaign、бюджет' },
      endpoint: { type: 'string', description: '查看某个接口的详细说明，如 /api/client/statistics/daily/json' },
      method: { type: 'string', enum: HTTP_METHODS },
      offset: { type: 'integer', minimum: 0, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
    }),
    annotations: LOCAL,
    handler: catalog,
  },
  {
    name: 'ozon_ads_api_call',
    description: '按官方路径调用 Performance API（广告）接口：路径参数和查询参数放 params（如 {"campaignId":"123"}），请求体放 body；严格按官方规范校验，'
      + 'OZON_READ_ONLY=true 时拦截改出价、启停活动等写操作。统计报表限制：同一账号同时只能生成 1 个、一次最多 10 个活动、最长 62 天。',
    inputSchema: obj({
      endpoint: { type: 'string', description: '官方路径，可带 {campaignId} 这类占位符，如 /api/client/campaign/{campaignId}/v2/products' },
      method: { type: 'string', enum: HTTP_METHODS, description: '该路径只有一个方法时可省略' },
      params: { type: 'object', description: '路径参数 + 查询参数；ID 按官方规范传字符串' },
      body: { type: 'object', description: '请求体（POST/PUT/PATCH）' },
    }, ['endpoint']),
    handler: call,
  },
];

export const ADS_TOOL_MAP = new Map(ADS_TOOLS.map((tool) => [tool.name, tool]));

const callAnnotations = (readOnly) => ({ readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true });

// Listed only with Performance API credentials, so sellers without ads see the same tools as before.
// Unlisted ads tools still answer a direct call with the credential setup message.
export function listAdsTools() {
  if (!adsConfigured()) return [];
  return ADS_TOOLS.map(({ handler, ...tool }) => (tool.name === 'ozon_ads_api_call' ? { ...tool, annotations: callAnnotations(readOnlyMode()) } : tool));
}
