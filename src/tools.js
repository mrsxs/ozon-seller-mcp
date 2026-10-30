import { compactEnabled, maxResultBytes, readOnlyMode, toolsetSpec } from './config.js';
import { COMPOSITE_TOOLS } from './composite.js';
import { dropEmpty, fitToBudget } from './compact.js';
import { proxySummary, request } from './http.js';
import { hidePersonal, redact } from './privacy.js';
import { rateLimitText } from './ratelimit.js';
import { renderReport } from './reports.js';
import { compileSchema, describe, enforceMode, formatErrors, inputSchema, validate } from './schema.js';
import { CATALOG, OPERATIONS, findOperation, operationSource } from './spec.js';
import { VERSION } from './version.js';

// Default tool set: endpoints the composite tools do not already cover. Everything
// else stays reachable through ozon_api_catalog + ozon_api_call.
const CORE_READ = [
  '/v1/seller/info', '/v1/roles', '/v3/product/info/list',
  '/v2/product/info/stocks-by-warehouse/fbs', '/v1/product/info/stocks-by-warehouse/fbo',
  '/v4/posting/fbs/list', '/v3/posting/fbs/get', '/v3/posting/fbo/list', '/v2/posting/fbo/get',
  '/v1/analytics/data', '/v1/returns/list', '/v2/warehouse/list', '/v1/finance/balance',
];
const CORE_WRITE = ['/v2/products/stocks', '/v1/product/import/prices'];

const EXTRA_HINTS = {
  '/v1/analytics/data': '实测（2026-10-26）：带 sort 参数的请求每次都被 Ozon 以“每秒限流”拒绝，不带 sort 正常。'
    + '销量排行请直接用 ozon_top_products（不传 sort，本地排序）；自行调用时不要传 sort，limit 取 1000 后自行排序。',
};

const annotations = (readOnly, local = false) => ({
  readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !local,
});
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function metaTools() {
  const endpoint = { type: 'string', description: '官方接口路径，如 /v3/product/list' };
  const method = { type: 'string', enum: ['GET', 'POST'], default: 'POST' };
  const body = { type: 'object', description: '严格遵循该接口官方 requestBody；不得传入 API Key 或 Client-Id。' };
  return [
    { name: 'ozon_status', description: '查询本机 MCP 运行模式、工具集、接口覆盖数、凭证是否配置、Node 版本与代理设置；不联网、不回显密钥。',
      inputSchema: schema({}), annotations: annotations(true, true) },
    { name: 'ozon_api_catalog', description: '分页搜索全部 482 个官方接口（名称/路径/分组）及只读分类、限流说明；不发送业务请求。未出现在工具列表里的接口用 ozon_api_call 调用。',
      inputSchema: schema({ query: { type: 'string', default: '' }, offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }),
      annotations: annotations(true, true) },
    { name: 'ozon_api_describe', description: '获取某接口完整官方说明、必填项、嵌套参数 schema、枚举、限制、示例、响应定义和原文链接。',
      inputSchema: schema({ endpoint, method }, ['endpoint']), annotations: annotations(true, true) },
    { name: 'ozon_validate_request', description: '离线校验请求参数；不调用 Ozon，不受只读模式影响。用于确认写入方案是否符合官方参数。',
      inputSchema: schema({ endpoint, method, body }, ['endpoint', 'body']), annotations: annotations(true, true) },
    { name: 'ozon_api_call', description: '按官方路径调用任一已登记接口（含未单独列出的接口）；严格校验参数并执行 OZON_READ_ONLY 服务端拦截。',
      inputSchema: schema({ endpoint, method, body }, ['endpoint']), annotations: annotations(readOnlyMode()) },
    { name: 'ozon_render_report', description: '将已核实数据生成本地离线 HTML；含摘要卡、搜索排序表格和 CSV 导出，不查询或修改 Ozon。report 格式见展示技能。',
      inputSchema: schema({
        report: { type: 'object', properties: {
          title: { type: 'string' }, scope: { type: 'string' }, subtitle: { type: 'string' }, queried_at: { type: 'string' },
          metrics: { type: 'array', items: { type: 'object' } }, sections: { type: 'array', items: { type: 'object' } },
          limitations: { type: 'array', items: { type: 'string' } } }, required: ['title', 'scope'] },
        filename: { type: 'string', default: 'ozon-report.html' },
      }, ['report']),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  ];
}

function selectedOperations() {
  const readOnly = readOnlyMode();
  const tokens = toolsetSpec().split(',').map((t) => t.trim()).filter(Boolean);
  const chosen = new Set();
  for (const token of tokens) {
    if (token === 'all') {
      for (const op of OPERATIONS.values()) chosen.add(op.tool_name);
    } else if (token === 'core') {
      for (const path of [...CORE_READ, ...(readOnly ? [] : CORE_WRITE)]) chosen.add(findOperation(path).tool_name);
    } else if (token === 'minimal') {
      // meta + composite tools only
    } else if (token.startsWith('/')) {
      const op = findOperation(token, 'POST') ?? findOperation(token, 'GET');
      if (!op) throw new Error(`OZON_TOOLSET 中的接口未登记：${token}`);
      chosen.add(op.tool_name);
    } else if (OPERATIONS.has(token)) {
      chosen.add(token);
    } else {
      throw new Error(`OZON_TOOLSET 无法识别：${token}（可用 core、all、minimal、接口路径或工具名，逗号分隔）`);
    }
  }
  return [...chosen].map((name) => OPERATIONS.get(name)).filter((op) => !readOnly || op.read_only);
}

function makeTool(op) {
  const source = operationSource(op);
  const prefix = op.read_only ? '[只读]' : '[写入/可能有副作用]';
  const limit = rateLimitText(op.path);
  const description = `${prefix} ${op.summary}\n${op.method} ${op.path}\n`
    + (limit ? `⚠ 限流：${limit}。调用前告知用户；结果不变时不要重复调用。\n` : '')
    + (EXTRA_HINTS[op.path] ? EXTRA_HINTS[op.path] + '\n' : '')
    + (op.description_zh || source.description || '')
    + '\n参数直接对应官方请求体；完整响应/示例可用 ozon_api_describe 查看。'
    + (op.deprecated ? '\n官方标记已弃用，请先核对替代版本。' : '');
  return { name: op.tool_name, description, inputSchema: inputSchema(op.tool_name), annotations: annotations(op.read_only) };
}

const strip = ({ handler, ...tool }) => tool;

export function listTools() {
  return [...metaTools(), ...COMPOSITE_TOOLS.map(strip), ...selectedOperations().map(makeTool)];
}

// Called once at startup so configuration typos fail loudly instead of mid-conversation.
export function checkConfiguration() {
  readOnlyMode();
  compactEnabled();
  maxResultBytes();
  selectedOperations();
}

function shrink(result, path) {
  let out = hidePersonal(result);
  if (compactEnabled()) out = dropEmpty(out);
  const limit = path && rateLimitText(path);
  if (limit) out = { ...out, rate_limit: `官方限制 ${limit}；请告知用户，避免重复调用。` };
  const { value, truncated } = fitToBudget(out, maxResultBytes());
  if (!truncated.length) return value;
  return {
    ...value,
    truncated,
    truncation_hint: `结果超过 ${Math.round(maxResultBytes() / 1024)}KB 上限，已截断上列数组（kept/total）。请缩小 limit、按 last_id/cursor 分页，或在 MCP env 调大 OZON_MAX_RESULT_KB。`,
  };
}

function opFromArgs(args) {
  const op = findOperation(args.endpoint, args.method ?? 'POST');
  if (!op) throw new Error('未登记的接口路径或 HTTP 方法；请先搜索 ozon_api_catalog。');
  return op;
}

function catalog(args) {
  const query = (args.query ?? '').toLowerCase();
  const listed = new Set(selectedOperations().map((op) => op.tool_name));
  const found = CATALOG.operations.filter((o) => JSON.stringify(o).toLowerCase().includes(query));
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 30;
  return {
    total: found.length, offset, has_next: offset + limit < found.length,
    operations: found.slice(offset, offset + limit).map((o) => ({
      tool_name: o.tool_name, method: o.method, path: o.path, summary: o.summary, tags: o.tags,
      read_only: o.read_only, deprecated: o.deprecated || undefined,
      enabled: !readOnlyMode() || o.read_only, listed_as_tool: listed.has(o.tool_name),
      rate_limit: rateLimitText(o.path),
    })),
    hint: '未列为独立工具（listed_as_tool=false）的接口，用 ozon_api_call 传 endpoint 与 body 调用。',
  };
}

const COMPOSITE = new Map(COMPOSITE_TOOLS.map((t) => [t.name, t]));

async function execute(name, args) {
  switch (name) {
    case 'ozon_status': {
      const readOnly = readOnlyMode();
      return {
        version: VERSION, read_only: readOnly, toolset: toolsetSpec(), listed_tools: listTools().length,
        api_key_configured: Boolean(process.env.OZON_API_KEY), client_id: process.env.OZON_CLIENT_ID || null,
        official_operations: OPERATIONS.size,
        available_api_operations: [...OPERATIONS.values()].filter((o) => !readOnly || o.read_only).length,
        compact_results: compactEnabled(), max_result_kb: Math.round(maxResultBytes() / 1024),
        source_date: CATALOG.source_date, source_version: CATALOG.source_version,
        node: process.version, platform: process.platform, proxy: proxySummary(),
      };
    }
    case 'ozon_api_catalog':
      return catalog(args);
    case 'ozon_api_describe':
      return { ...describe(opFromArgs(args).tool_name), rate_limit: rateLimitText(args.endpoint) };
    case 'ozon_validate_request': {
      const op = opFromArgs(args);
      validate(op.tool_name, args.body ?? {});
      return { valid: true, network_called: false, endpoint: op.path, allowed_in_current_mode: !readOnlyMode() || op.read_only };
    }
    case 'ozon_api_call': {
      const op = opFromArgs(args);
      return shrink(await request(op.path, args.body ?? {}, op.method), op.path);
    }
    case 'ozon_render_report':
      return renderReport(args.report, args.filename ?? 'ozon-report.html');
    default: {
      if (COMPOSITE.has(name)) return shrink(await COMPOSITE.get(name).handler(args));
      const op = OPERATIONS.get(name);
      if (!op) throw new Error('未知工具。');
      enforceMode(op);
      return shrink(await request(op.path, args, op.method), op.path);
    }
  }
}

function checkToolArguments(name, args) {
  const tool = metaTools().find((t) => t.name === name) ?? COMPOSITE.get(name);
  if (!tool) return;
  const check = compileSchema('tool:' + name, tool.inputSchema);
  if (!check(args)) throw new Error(`工具参数校验失败；未执行操作。${formatErrors(check.errors, 3).join('；')}`);
}

export async function callTool(name, args) {
  try {
    const input = args ?? {};
    checkToolArguments(name, input);
    const result = redact(await execute(name, input));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: redact(String(error?.message ?? error)) }], isError: true };
  }
}
