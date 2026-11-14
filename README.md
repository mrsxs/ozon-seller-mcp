# ozon-seller-mcp

Ozon 卖家 API 的标准 MCP 服务（stdio），纯 Node 实现，`npx` 即装即用，**不需要 Python**。

- **广告数据**：接入 Ozon Performance API（广告后台）全部 48 个接口，`ozon_ads_stats` 一次调用出点击率/加购率/下单率/DRR 分析，见[广告数据](#广告数据performance-api)

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
| `OZON_CLIENT_ID` / `OZON_API_KEY` | — | 单店凭证；只有一家店时用 |
| `OZON_SHOPS` | — | 多店铺：JSON 数组，见下方「多店铺」；填了它就不再读单店的 4 个凭证变量 |
| `OZON_READ_ONLY` | `true` | `false` 才允许写操作；其他值启动报错，拼写错误不会开放写入 |
| `OZON_TOOLSET` | `core` | `core` 常用工具；`minimal` 只要组合工具和通用工具；`all` 全部接口；可追加接口路径或工具名，逗号分隔，如 `core,/v1/returns/list` |
| `OZON_COMPACT` | `true` | 结果省略 null、空字符串、空数组、空对象 |
| `OZON_MAX_RESULT_KB` | `80` | 单次结果上限；超出时截断最大的数组并提示分页 |
| `OZON_OUTPUT_DIR` | `~/.accio/outputs/ozon` | HTML 报告目录 |
| `OZON_ACCESS_TOKEN` | — | Ozon Delivery 分组接口的 OAuth 令牌 |
| `OZON_PERF_CLIENT_ID` / `OZON_PERF_CLIENT_SECRET` | — | 广告 Performance API 凭证，查广告数据才需要；和上面的 Seller API 凭证不是一组 |
| `OZON_PROXY` | 空 | 只给 Ozon 请求用的代理，留空就直连。支持 `vless://` 节点链接（WebSocket 类型）、`http://`、`socks5://`；设置后优先于 `HTTPS_PROXY` |
| `HTTPS_PROXY` | — | 标准代理变量，`OZON_PROXY` 为空时生效 |

修改后需要重启 MCP。

## 多店铺

一个 MCP 连多家店：`OZON_SHOPS` 填一个 JSON 数组，每家店一项。

```json
"env": {
  "OZON_SHOPS": "[{\"name\":\"shop-a\",\"client_id\":\"…\",\"api_key\":\"…\",\"perf_client_id\":\"…@advertising.performance.ozon.ru\",\"perf_client_secret\":\"…\",\"market\":true,\"default\":true},{\"name\":\"shop-b\",\"client_id\":\"…\",\"api_key\":\"…\",\"perf_client_id\":\"…\",\"perf_client_secret\":\"…\"}]",
  "OZON_READ_ONLY": "true"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 店铺名，1～32 个字母、数字、汉字、`_`、`-`，不能重复；调用时用它选店 |
| `client_id` / `api_key` | 二选一 | 该店的 Seller API 凭证，两项要么都填要么都不填 |
| `perf_client_id` / `perf_client_secret` | 二选一 | 该店的广告凭证，两项要么都填要么都不填；每家店至少填一组凭证（只做广告的店可以不填 Seller API） |
| `access_token` | 否 | 该店的 Ozon Delivery OAuth 令牌 |
| `default` | 否 | `true` = 调用不指定店铺时用它；不标就用第一项 |
| `market` | 否 | `true` = 市场数据店，最多一家；没有店标它时，市场数据接口就用调用时选的那家店 |

- 访问 Ozon 的工具（含组合工具、广告工具）都多一个可选参数 `shop`（店铺名），不填用默认店。结果里的 `shop` 字段写明实际用哪家店的凭证查的。只在本地运行的工具（`ozon_status`、目录、说明、校验、报告）没有这个参数。
- **市场数据固定走 `market` 店**：类目大盘 `/v1/analytics/category/comparison`、全站热搜词 `/v1/search-queries/top`、`/v1/search-queries/text` 要 Premium Pro 订阅，结果和查询的店铺无关，所以不论 `shop` 填哪家，都用市场数据店的凭证查。本店相关的数据（销量、商品搜索词、价格指数、广告）一律用各自店的凭证。
- 限流和 5 分钟读缓存按店铺（Client-Id）分开计；广告令牌每家店各一个。
- 配置有错（JSON 不合法、缺凭证、重名、未知字段、两家店填了同一个 `client_id` / `perf_client_id`、两家都标 `market`）启动时直接报错，报错只说第几项哪个字段，不回显密钥。所有店的密钥都会从结果和报错里隐藏。
- `ozon_status` 列出每家店的名称、Client-Id、是否默认 / 市场店、是否配了 Seller API / 广告凭证，不含密钥。

## 通过节点访问 Ozon

国内网络直连 Ozon 经常不通。把节点链接填进 `OZON_PROXY` 即可，不用另装代理软件：

```json
"env": {
  "OZON_CLIENT_ID": "你的 Client ID",
  "OZON_API_KEY": "你的 API Key",
  "OZON_PROXY": "vless://UUID@地址:443?type=ws&security=tls&host=域名&sni=域名&path=%2Fws"
}
```

- 支持 `type=ws`、`security=tls` 或 `none` 的 VLESS 节点（常见的 Cloudflare WS 节点）；Reality、gRPC、XTLS 等类型不支持，可用本机客户端转成 `http://127.0.0.1:端口` 再填
- 到 Ozon 的 HTTPS 在隧道内端到端加密，节点只转发字节，看不到 API Key
- 链接里的 UUID 等同节点密码，只放在 MCP 配置里，不要提交到仓库；`ozon_status` 和报错只显示节点地址，不显示 UUID

## 连不上 Ozon

报错会写明底层原因、耗时和当前代理，例如 `连接 Ozon 失败（ECONNREFUSED，8 ms，代理：HTTPS_PROXY=http://127.0.0.1:7899）`。`ozon_status` 会显示 Node 版本和生效的代理。

| 报错里的原因 | 处理 |
|---|---|
| `代理配置无效` | 代理变量缺少协议，改成 `http://127.0.0.1:端口` |
| 带代理的 `ECONNREFUSED` / `UND_ERR_CONNECT_TIMEOUT` | 代理软件没开或端口不对；不需要代理就删掉该变量 |
| 直连的 `UND_ERR_CONNECT_TIMEOUT` / `ECONNRESET` | 本机直连不通（软路由下 TCP 几毫秒就“连上”、TLS 握手却超时也属于这种）。在 `env` 配置 `OZON_PROXY`，见上一节；Node 不读系统代理，浏览器能打开不代表 MCP 能通 |
| `VLESS_WS_FAILED` / 经 VLESS 节点的 `ECONNRESET` | 节点握手失败或 UUID 不对：核对链接里的 UUID、host、path，确认节点没过期 |
| `SELF_SIGNED_CERT_IN_CHAIN` 等证书错误 | 杀毒软件或公司网关在扫描 HTTPS。关闭 HTTPS 扫描，或在 `env` 加 `"NODE_OPTIONS": "--use-system-ca"`（Node ≥ 22.15） |
| `ENOTFOUND` | DNS 解析失败 |
| `HTTP 401/403` | 网络已通，检查 Client ID、API Key 和权限 |

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

营收 `revenue`（来自 `/v1/analytics/data`）单位是卢布，结果里带 `revenue_currency: "RUB"`；商品价格 `price`/`old_price`/`min_price` 是店铺结算币种（可能是 CNY），见 `price_currency`（旧字段 `currency` 保留，值相同）。两者不要直接相加或相除。

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

## 广告数据（Performance API）

广告数据不在 Seller API 里，而在独立的 Performance API（`api-performance.ozon.ru`），需要另一组凭证：

1. 卖家后台 **设置 → API 密钥 → Performance API**，没有服务账号就先创建
2. 点服务账号名称 → **添加新密钥**，得到 Client ID（以 `@advertising.performance.ozon.ru` 结尾）和 Client Secret
3. 填到 MCP 的 `env`：

```json
"env": {
  "OZON_PERF_CLIENT_ID": "xxxx@advertising.performance.ozon.ru",
  "OZON_PERF_CLIENT_SECRET": "你的 Client Secret"
}
```

配置了这两项后才会出现下面 3 个广告工具（没配时工具列表与以前一样，`ozon_status` 的 `ads.setup_hint` 会提示怎么配）。只用广告功能时可以不填 `OZON_CLIENT_ID` / `OZON_API_KEY`。访问令牌由服务自动获取（30 分钟有效，提前 1 分钟换新，遇到 401 自动刷新一次），不会出现在结果里。代理设置（`OZON_PROXY` 等）与 Seller API 共用。

| 工具 | 内容 |
|---|---|
| `ozon_ads_stats` | 【一次调用】按点击付费活动：各活动和各商品的展示、点击、点击率、加购率、下单率、花费、平均点击价、单均成本、DRR；标出点击率偏低、点击≥100 无订单、DRR 超过目标的商品。默认最近 7 天（莫斯科时间），最长 62 天。实测一个 8 个活动的店铺约 25 秒 |
| `ozon_ads_api_catalog` | 搜索全部 48 个广告接口 + 官方说明中给出的 12 个 `/json` 报表版本，或查看单个接口的参数与响应定义 |
| `ozon_ads_api_call` | 按路径调用任一广告接口：路径参数和查询参数放 `params`，请求体放 `body` |

- `ozon_ads_stats` 的活动汇总来自 `/api/client/statistics/campaign/product/json`（同步，不消耗限额）；商品明细来自异步活动报表 `/api/client/statistics/json`（每次最多 10 个活动，同一账号同时只生成 1 个，最多等 90 秒），包含本期内已移出活动的商品。同一进程内同一广告账号的报表逐个生成：本服务记住每个广告账号最近提交的报表（UUID、提交时间），下一次提交前（`ozon_ads_stats` 和 `ozon_ads_api_call` 的报表提交，含外部流量报表）先在本次调用内查它的状态，等到 OK/ERROR（外部流量报表还有 TIMEOUT/CANCEL）或它已提交满 120 秒；查询失败不算完成，每次查询也受上一份报表剩余的等待上限约束。本次调用的时间预算内没等到就不提交并返回提示。报表提交不自动重试；已发出但结果未知（连接中断、超时、5xx）时，按“可能正在生成”处理，下一次提交等它满 120 秒。没有任何后台任务；相同查询同时进行时共用一份报表。`ozon_ads_stats` 整次调用（活动列表、汇总、取令牌、等待、重试、报表）共用一个 90 秒期限，超时即取消，不再发出后续请求。`include_products=false` 只看活动汇总
- `/api/client/statistics/products/sku` 实测只接受今天或昨天（Ozon 返回 `date range must contain only today or yesterday`），所以不用于多天统计
- `OZON_READ_ONLY=true` 时，改出价、启停活动、增删商品、开关“按订单付款”等 16 个写接口在发送前拦截（包括 `GET /api/client/campaign/all_sku_promo/activate` 这类用 GET 做写操作的接口）
- 官方限制：每天总计 100 000 次；统计报表同一账号同时只能生成 1 个、一次最多 10 个活动、最长 62 天
- 多活动统计报表是 ZIP，本服务不解压；请每次一个活动，或用 `/json` 版本
- 活动列表按页读取（每页 100，直到读完），同时最多 4 个请求

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

本地保护：同一进程内超出上述窗口时直接返回“约 N 秒后可再调用”，不发请求；限流接口的相同只读请求 5 分钟内返回缓存（`from_cache: true`）。本地计数只统计当前进程（含被 Ozon 拒绝的调用），以 Ozon 服务端为准。只读请求遇到 429/502/503/504 且 `Retry-After`（秒数或 HTTP 日期）≤ 5 秒时重试一次；每次实际发送（含重试、等过冷却之后）在发出前一刻计入上述窗口，并受每个账号的重试额度限制（并发失败时不会把请求量翻倍），等待时间加少量随机抖动。写请求从不自动重试。Ozon 返回 429 后，同一账号（同一 Client-Id 或广告 Client ID）的后续请求都先等过 `Retry-After`（最多按 60 秒计）：剩余不超过 5 秒就等待后发送，更长则直接返回“约 N 秒后可再调用”；有独立限额的接口（上表）只冷却该接口本身。

**实测注意**：`/v1/analytics/data` 带 `sort` 参数的请求在 2026-10-26 连续被 Ozon 以“每秒限流”拒绝，同样的请求不带 `sort` 正常。`ozon_top_products` 因此不传 `sort`，一次取 1000 个 SKU 后本地排序。

## 参数校验

- 必填、类型、嵌套、枚举、上下限、数组约束、日期、date-time（RFC 3339，须带时区，如 `2026-10-01T00:00:00Z`；闰秒只接受 UTC 23:59:60）与 int32/int64/uint64 格式、未知字段，发送前全部校验。少数字段（如 `/v1/finance/balance` 的 `date_from`）规范类型是 date-time、说明和官方示例却是 `YYYY-MM-DD`，这些字段两种写法都接受
- 整数参数超出 ±9007199254740991 时直接拒绝：JSON 解析时这类数字已被舍入（9007199254740993 会变成 …992），照发可能作用到别的对象
- 482 个 schema 与原 Python 版逐个比对一致（3114 个校验用例结论相同），以下 8 处除外
- 官方规范有 8 个 schema 把某字段列为必填、却没有定义该字段（如 `/v2/products/stocks` 的 `quant_size`，`/v1/cargoes/label/transport/status` 的 `operation_idd`），原实现因此无法调用这些接口。现在这些字段改为“已声明、不校验类型”的可选字段，说明里注明官方列为必填，最终以 Ozon 返回为准
- 官方 `type=null` 的字段禁止传入，不猜测类型；`int`/`bool` 等书写错误按无歧义方式规范化

## 隐私与安全

- API Key 不出现在结果、错误信息和报告中
- 所有结果默认去掉名为 `customer`、`addressee`、`address`、`phone`、`email`、`legal_info` 的字段（包括仓库地址、电话等非客户数据）
- 写模式下上传文件只接受常见文档和图片类型（pdf、jpg、png、doc/xls 等），防止被诱导上传密钥或配置文件
- 超过 2^53 的 int64 ID 以字符串原样返回，不会丢精度
- 不跟随 HTTP 重定向，凭证不会发往其他主机
- 只请求官方规范中登记的接口路径

## 开发

```bash
npm install
npm test          # 52 个单元/契约测试，不联网
npm run smoke     # 启动真实进程，跑一遍 MCP stdio 握手
```

发布：修改 `package.json` 的 `version`，推送 `v<版本号>` 标签，GitHub Actions 测试通过后发布到 npm（需要仓库 Secret `NPM_TOKEN`）。

## 来源

- 俄文主规范：https://docs.ozon.ru/api/seller/swagger.json
- 中文辅助规范：https://docs.ozon.ru/api/seller/zh/swagger.json
- 广告 Performance API（2026-11-09 快照）：https://docs.ozon.ru/api/performance/swagger.json 、中文 https://docs.ozon.ru/api/performance/zh/swagger.json
- MCP SDK：`@modelcontextprotocol/server` 2.4.0

`spec/` 是版本快照，不在运行时联网更新。Accio 展示技能见 `ozon-seller-assistant.skill`（源文件在 `skills/`）。
