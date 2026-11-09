// Ozon Performance API (advertising cabinet): pinned official snapshot, nothing is fetched at runtime.
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const load = (file) => JSON.parse(readFileSync(new URL(file, ROOT), 'utf8'));

export const ADS_SPEC = load('spec/performance-ru.json');
const ADS_SPEC_ZH = load('spec/performance-zh.json');

export const ADS_BASE_URL = 'https://api-performance.ozon.ru';
export const ADS_SOURCE = {
  date: '2026-11-09',
  version: ADS_SPEC.info.version,
  ru: 'https://docs.ozon.ru/api/performance/swagger.json',
  zh: 'https://docs.ozon.ru/api/performance/zh/swagger.json',
};

// Every official operation is classified by hand; a test fails when the snapshot adds one.
// Report generation counts as a read: it consumes report quota but changes no campaign.
export const READ_ONLY_IDS = new Set([
  'ListCampaigns', 'ListCampaignObjects', 'GetLimitsList', 'ExternalCampaign_BidBySKU',
  'ExternalCampaign_ListProductsWithBonuses2', 'SubmitRequest', 'VideoCampaignsSubmitRequest', 'AttributionSubmitRequest',
  'StatisticsCheck', 'ListReports', 'ListReportsExternal', 'DownloadStatistics', 'MediaCampaignList', 'ProductCampaignList',
  'GetCampaignExpense', 'GetCampaignDailyStats', 'SearchPromoOrdersReportSubmitRequest', 'SearchPromoProductsReportSubmitRequest',
  'GenerateAllSkuPromoOrdersReport', 'GenerateAllSkuPromoProductsReport', 'ExternalStatistics_StatisticsPhrasesSubmitRequest2',
  'SearchPromoProductsSKUStatistics2', 'CalculateDynamicBudget', 'GetProductsV2', 'GetProductsCompetitiveBids',
  'ExternalCampaign_ListSearchPromoProductsV2', 'ExternalCampaign_GetProductsRecommendedBids', 'ExternalCampaign_GetCPOMinBids',
  'VendorStatisticsSubmitRequest', 'VendorStatisticsListReports', 'VendorStatisticsCheck', 'GetVendorTag',
]);

// Writes include GET endpoints that switch promotion on/off or set bids.
export const WRITE_IDS = new Set([
  'CreateProductCampaignCPCV2', 'ActivateCampaign', 'DeactivateCampaign', 'PatchProductCampaign', 'AddProducts', 'UpdateProducts',
  'DeleteProducts', 'ExternalCampaign_SetSearchPromoBidsV2', 'ExternalCampaign_BatchEnableProducts',
  'ExternalCampaign_BatchDisableProducts', 'ExternalCampaign_DeleteSearchPromoBidsV2', 'ActivateAllSkuPromoCampaign',
  'DeactivateAllSkuPromoCampaign', 'SetAllSkuPromoCampaignBid2', 'ExternalCampaign_BatchEnableCarrots4',
  'ExternalCampaign_BatchDisableCarrots4',
]);

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
// Report endpoints document a JSON variant by its full path, e.g. `/api/client/statistics/daily/json`.
const JSON_VARIANT = /`(\/api\/client\/[A-Za-z0-9_/-]+\/json)`/;

function buildOperations() {
  const operations = [];
  for (const [path, item] of Object.entries(ADS_SPEC.paths)) {
    for (const method of METHODS) {
      const source = item[method];
      if (!source) continue;
      const zh = ADS_SPEC_ZH.paths?.[path]?.[method];
      const base = Object.freeze({
        path,
        method: method.toUpperCase(),
        operation_id: source.operationId,
        source_path: path,
        source_method: method,
        summary: zh?.summary || source.summary,
        summary_ru: source.summary,
        description_zh: zh?.description ?? '',
        tags: source.tags ?? [],
        // Fail closed: an operation missing from both lists is treated as a write.
        read_only: READ_ONLY_IDS.has(source.operationId),
        deprecated: Boolean(source.deprecated),
      });
      operations.push(base);
      const variant = (source.description ?? '').match(JSON_VARIANT)?.[1];
      if (variant && variant !== path) {
        operations.push(Object.freeze({ ...base, path: variant, operation_id: `${source.operationId}_json`,
          summary: `${base.summary}（JSON 格式）`, json_variant_of: path }));
      }
    }
  }
  return Object.freeze(operations);
}

export const ADS_OPERATIONS = buildOperations();
const BY_ENDPOINT = new Map(ADS_OPERATIONS.map((op) => [`${op.method} ${op.path}`, op]));

export function findAdsOperation(endpoint, method = 'GET') {
  return BY_ENDPOINT.get(`${String(method).toUpperCase()} ${endpoint}`);
}

export const adsSource = (op) => ADS_SPEC.paths[op.source_path][op.source_method];

const unescapePointer = (part) => part.replaceAll('~1', '/').replaceAll('~0', '~');

export function adsDeref(value) {
  let current = value;
  while (current && typeof current === 'object' && '$ref' in current) {
    const ref = current.$ref;
    if (!ref.startsWith('#/')) throw new Error('规范包含外部引用，禁止自动联网解析。');
    current = ref.slice(2).split('/').reduce((node, part) => node[unescapePointer(part)], ADS_SPEC);
  }
  return current;
}
