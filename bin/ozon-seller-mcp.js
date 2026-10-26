#!/usr/bin/env node
// MCP stdio entry. stdout carries JSON-RPC only; diagnostics go to stderr.
import { VERSION } from '../src/version.js';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
} else if (args.includes('--help') || args.includes('-h')) {
  process.stderr.write(`ozon-seller-mcp ${VERSION} — Ozon Seller API MCP server (stdio)

用法：npx -y ozon-seller-mcp

环境变量：
  OZON_CLIENT_ID, OZON_API_KEY   店铺凭证（必填）
  OZON_READ_ONLY                 true（默认，只读）/ false（允许写入）
  OZON_TOOLSET                   core（默认）/ all / minimal / 追加接口路径，逗号分隔
  OZON_COMPACT                   true（默认，省略空值字段）/ false
  OZON_MAX_RESULT_KB             单次结果上限，默认 80
  OZON_OUTPUT_DIR                HTML 报告输出目录
  OZON_ACCESS_TOKEN              Ozon Delivery 接口 OAuth 令牌（可选）
  HTTPS_PROXY                    代理（可选）
`);
} else {
  // A stray error must not kill the server mid-conversation; log it to stderr and keep serving.
  const report = (kind) => (error) => process.stderr.write(`[ozon-seller-mcp] ${kind}: ${error?.stack ?? error}\n`);
  process.on('unhandledRejection', report('unhandledRejection'));
  process.on('uncaughtException', report('uncaughtException'));
  try {
    const { main } = await import('../src/server.js');
    await main();
  } catch (error) {
    process.stderr.write(`[ozon-seller-mcp] 启动失败：${error?.message ?? error}\n`);
    process.exit(1);
  }
}
