#!/usr/bin/env node
// MCP stdio entry. stdout carries JSON-RPC only; diagnostics go to stderr.
import { redactText } from '../src/privacy.js';
import { VERSION } from '../src/version.js';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
} else if (args.includes('--help') || args.includes('-h')) {
  process.stderr.write(`ozon-seller-mcp ${VERSION} — Ozon Seller API MCP server (stdio)

用法：npx -y ozon-seller-mcp

环境变量：
  OZON_CLIENT_ID, OZON_API_KEY   单店凭证（只有一家店时用）
  OZON_SHOPS                     多店铺：JSON 数组，每项 {"name","client_id","api_key",
                                 "perf_client_id"?,"perf_client_secret"?,"access_token"?,"market"?,"default"?}；
                                 填了它就不再读上面的单店变量。"market": true 的店负责
                                 类目大盘、全站热搜词（需 Premium Pro）；工具多一个 shop 参数
  OZON_READ_ONLY                 true（默认，只读）/ false（允许写入）
  OZON_TOOLSET                   core（默认）/ all / minimal / 追加接口路径，逗号分隔
  OZON_COMPACT                   true（默认，省略空值字段）/ false
  OZON_MAX_RESULT_KB             单次结果上限，默认 80
  OZON_OUTPUT_DIR                HTML 报告输出目录
  OZON_ACCESS_TOKEN              Ozon Delivery 接口 OAuth 令牌（可选）
  OZON_PERF_CLIENT_ID            广告 Performance API 的 Client ID（可选，查广告数据用）
  OZON_PERF_CLIENT_SECRET        广告 Performance API 的 Client Secret
  OZON_PROXY                     只给 Ozon 用的代理：vless://（WS 节点）、http://、socks5://；留空直连
  HTTPS_PROXY                    标准代理变量，OZON_PROXY 为空时生效
`);
} else {
  // A stray error must not kill the server mid-conversation; log it to stderr and keep serving.
  // Logged text goes through the same redaction as tool results (configured keys, ad tokens).
  const report = (kind) => (error) => process.stderr.write(`[ozon-seller-mcp] ${kind}: ${redactText(error)}\n`);
  process.on('unhandledRejection', report('unhandledRejection'));
  process.on('uncaughtException', report('uncaughtException'));
  try {
    const { main } = await import('../src/server.js');
    await main();
  } catch (error) {
    process.stderr.write(`[ozon-seller-mcp] 启动失败：${redactText(error?.message ?? error)}\n`);
    process.exit(1);
  }
}
