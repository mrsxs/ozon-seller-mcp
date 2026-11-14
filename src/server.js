import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { MARKET_PATHS, defaultShop, marketShop, multiShop, shops } from './shops.js';
import { callTool, checkConfiguration, listTools } from './tools.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = [
  'Ozon 卖家 API。常见问题优先用一次调用的组合工具：ozon_top_products（销量排行）、ozon_product_overview（商品列表）、',
  'ozon_product_detail（单品详情）、ozon_stock_overview（库存/缺货）、ozon_orders_overview（订单货件）、ozon_sales_overview（销量趋势与财务）。',
  '其他接口先用 ozon_api_catalog 搜索，再用对应工具或 ozon_api_call 调用。',
  '广告（Performance API）：点击率/推广效果用 ozon_ads_stats；其他广告接口用 ozon_ads_api_catalog 搜索、ozon_ads_api_call 调用。',
  '工具说明或结果中出现“限流”时，必须把官方限制告诉用户，不要重复重试。默认只读。',
].join('');

function instructions() {
  if (!multiShop()) return INSTRUCTIONS;
  const market = marketShop();
  return INSTRUCTIONS + `多店铺：${shops().map((s) => s.name).join('、')}。访问店铺数据的工具都有 shop 参数，不填 = 默认店「${defaultShop().name}」；`
    + '问到某家店时必须传 shop，比较多家店时逐店调用，结果里的 shop 字段写明是哪家店的数据。'
    + (market ? `市场数据接口（${[...MARKET_PATHS].join('、')}）固定用「${market.name}」的凭证，结果对所有店通用。` : '');
}

export function createServer() {
  const server = new Server({ name: 'ozon-seller', version: VERSION }, { capabilities: { tools: {} }, instructions: instructions() });
  server.setRequestHandler('tools/list', async () => ({ tools: listTools() }));
  server.setRequestHandler('tools/call', async (request) => callTool(request.params.name, request.params.arguments));
  return server;
}

export async function main() {
  checkConfiguration();
  await createServer().connect(new StdioServerTransport());
}
