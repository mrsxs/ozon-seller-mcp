import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { callTool, checkConfiguration, listTools } from './tools.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = [
  'Ozon 卖家 API。常见问题优先用一次调用的组合工具：ozon_top_products（销量排行）、ozon_product_overview（商品列表）、',
  'ozon_product_detail（单品详情）、ozon_stock_overview（库存/缺货）、ozon_orders_overview（订单货件）、ozon_sales_overview（销量趋势与财务）。',
  '其他接口先用 ozon_api_catalog 搜索，再用对应工具或 ozon_api_call 调用。',
  '工具说明或结果中出现“限流”时，必须把官方限制告诉用户，不要重复重试。默认只读。',
].join('');

export function createServer() {
  const server = new Server({ name: 'ozon-seller', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler('tools/list', async () => ({ tools: listTools() }));
  server.setRequestHandler('tools/call', async (request) => callTool(request.params.name, request.params.arguments));
  return server;
}

export async function main() {
  checkConfiguration();
  await createServer().connect(new StdioServerTransport());
}
