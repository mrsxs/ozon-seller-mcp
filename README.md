# ozon-seller-mcp

Ozon 卖家 API 的标准 MCP 服务（stdio），纯 Node 实现，`npx` 即装即用，**不需要 Python**。

- 覆盖俄文官方 OpenAPI（2026-10-26 快照）全部 **482 个接口**，参数严格按官方 schema 校验
- **6 个组合工具**：常见问题一次调用出结果（销量排行、商品列表、单品详情、库存、订单、经营概览）
- **默认只读**；写操作在发送前拦截
- 默认只暴露 25 个工具（工具定义约 44 KB，原先全量 274 个、约 422 KB），结果自动省略空值、超限截断
- HTTP 连接复用：首次请求后每次约 0.4 s（原先每次重新握手约 2.7 s）
- 官方限流写入工具说明和结果，并在本地做限流保护和缓存

## 快速开始

需要 Node.js ≥ 20.18（Accio 自带 Node 运行时）。把下面的配置合并到 MCP 客户端（Accio、Claude Desktop、Cursor 等）的 `mcpServers`：

```json
{
  "mcpServers": {
    "ozon-seller": {
      "command": "npx",
      "args": ["-y", "ozon-seller-mcp@latest"],
      "env": {
        "OZON_CLIENT_ID": "你的 Client ID",
        "OZON_API_KEY": "你的 API Key",
        "OZON_READ_ONLY": "true"
      }
    }
  }
}
```

Windows 上如果客户端找不到 `npx`，把 `command` 改为 `"cmd"`，`args` 改为 `["/c", "npx", "-y", "ozon-seller-mcp@latest"]`。国内网络可在 `env` 中加 `"npm_config_registry": "https://registry.npmmirror.com"` 加速首次安装。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OZON_CLIENT_ID` / `OZON_API_KEY` | — | 店铺凭证，必填 |
| `OZON_READ_ONLY` | `true` | `false` 才允许写操作；其他值启动报错，拼写错误不会开放写入 |
| `OZON_TOOLSET` | `core` | `core` 常用工具；`minimal` 只要组合工具和通用工具；`all` 全部接口；可追加接口路径或工具名，逗号分隔，如 `core,/v1/returns/list` |
| `OZON_COMPACT` | `true` | 结果省略 null、空字符串、空数组、空对象 |
| `OZON_MAX_RESULT_KB` | `80` | 单次结果上限；超出时截断最大的数组并提示分页 |
| `OZON_OUTPUT_DIR` | `~/.accio/outputs/ozon` | HTML 报告目录 |
| `OZON_ACCESS_TOKEN` | — | Ozon Delivery 分组接口的 OAuth 令牌 |
| `HTTPS_PROXY` | — | 设置后经代理访问 |

修改后需要重启 MCP。

## 工具

### 组合工具（一次调用）

| 工具 | 内容 | 实测耗时* |
|---|---|---|
| `ozon_top_products` | 销量/营收 Top N + 详情（价格、库存、状态）+ 中文属性 + 尺寸重量 | 约 11 s（Ozon 分析接口本身约 9 s）；5 分钟内换指标/条数约 0.6 s |
| `ozon_product_overview` | 商品列表 + 详情，可分页 | 约 1.3 s / 50 个 |
| `ozon_product_detail` | 指定商品：属性、尺寸、价格佣金、FBS/FBO 分仓库存 | 约 3 s |
| `ozon_stock_overview` | 全店库存汇总，零库存/低库存清单 | 约 1.2 s / 481 个商品 |
| `ozon_orders_overview` | FBS+FBO 货件按状态汇总、热销、取消原因、最近货件（按天并行翻页） | 约 4.7 s / 2434 个货件 |
| `ozon_sales_overview` | 按天/周/月的销量营收趋势 + 同期财务余额 | 约 7 s |

\* 2026-10-26 在一家约 480 个商品的店铺实测，从国内网络访问。

### 通用工具

| 工具 | 用途 |
|---|---|
| `ozon_status` | 运行模式、工具集、凭证是否配置（不回显密钥） |
| `ozon_api_catalog` | 搜索全部 482 个接口、只读分类、限流说明 |
| `ozon_api_describe` | 接口完整说明、参数 schema、示例、响应定义 |
| `ozon_validate_request` | 只校验参数，不发请求 |
| `ozon_api_call` | 按路径调用任一接口（含未列为独立工具的接口） |
| `ozon_render_report` | 生成离线 HTML 报告（搜索、排序、CSV 导出） |

独立接口工具名为 `ozon_<官方 operationId>`，参数就是官方请求体。

## 限流

官方文档中写明限额的接口如下。工具说明里会标出 `⚠ 限流`，调用结果附带 `rate_limit` 字段，Accio 技能要求模型把限额告诉用户。

| 接口 | 官方限制 |
|---|---|
| `/v1/analytics/data`（销量/营收分析，`ozon_top_products`、`ozon_sales_overview` 共用） | **1 次/分钟，50 次/天** |
| `/v1/analytics/turnover/stocks` | 1 次/分钟（按 Client-Id） |
| `/v1/warehouse/list` | 1 次/分钟 |
| `/v1/product/placement-zone/info` | 10 次/秒 |
| `/v2/draft/create/info` 及 4 个供货草稿创建接口 | 2 次/分钟，50 次/小时 |
| `/v2/products/stocks`（改库存） | 80 次/分钟 |
| `/v1/barcode/add`、`/v1/barcode/generate` | 20 次/分钟 |
| `/v1/product/import/prices`（改价） | 每个商品 10 次/小时 |
| `/v1/report/discounted/create` | 1 次/分钟 |
| `/v1/report/placement/by-products/create`、`by-supplies/create` | 5 次/天 |
| 商品导入、改属性、改图片、改货号、解档等 | 按商品操作数有分钟/天额度，剩余用 `/v4/product/info/limit` 查询 |

其他接口文档未写具体数字，Ozon 仍可能返回 429。

本地保护：同一进程内超出上述窗口时直接返回“约 N 秒后可再调用”，不发请求；限流接口的相同只读请求 5 分钟内返回缓存（`from_cache: true`）。本地计数只统计当前进程（含被 Ozon 拒绝的调用），以 Ozon 服务端为准。只读请求遇到 429/502/503/504 且 `Retry-After` ≤ 5 秒时重试一次；写请求从不自动重试。

**实测注意**：`/v1/analytics/data` 带 `sort` 参数的请求在 2026-10-26 连续被 Ozon 以“每秒限流”拒绝，同样的请求不带 `sort` 正常。`ozon_top_products` 因此不传 `sort`，一次取 1000 个 SKU 后本地排序。

## 参数校验

- 必填、类型、嵌套、枚举、上下限、数组约束、日期与 int32/int64/uint64 格式、未知字段，发送前全部校验
- 482 个 schema 与原 Python 版逐个比对一致（3114 个校验用例结论相同），以下 8 处除外
- 官方规范有 8 个 schema 把某字段列为必填、却没有定义该字段（如 `/v2/products/stocks` 的 `quant_size`，`/v1/cargoes/label/transport/status` 的 `operation_idd`），原实现因此无法调用这些接口。现在这些字段改为“已声明、不校验类型”的可选字段，说明里注明官方列为必填，最终以 Ozon 返回为准
- 官方 `type=null` 的字段禁止传入，不猜测类型；`int`/`bool` 等书写错误按无歧义方式规范化

## 隐私与安全

- API Key 不出现在结果、错误信息和报告中
- 订单结果默认去掉 `customer`、`addressee`、`address`、`phone`、`email`、`legal_info`
- 不跟随 HTTP 重定向，凭证不会发往其他主机
- 只请求官方规范中登记的接口路径

## 开发

```bash
npm install
npm test          # 21 个单元/契约测试，不联网
npm run smoke     # 启动真实进程，跑一遍 MCP stdio 握手
```

发布：修改 `package.json` 的 `version`，推送 `v<版本号>` 标签，GitHub Actions 测试通过后发布到 npm（需要仓库 Secret `NPM_TOKEN`）。

## 来源

- 俄文主规范：https://docs.ozon.ru/api/seller/swagger.json
- 中文辅助规范：https://docs.ozon.ru/api/seller/zh/swagger.json
- MCP SDK：`@modelcontextprotocol/server` 2.4.0

`spec/` 是版本快照，不在运行时联网更新。Accio 展示技能见 `ozon-seller-assistant.skill`（源文件在 `skills/`）。
