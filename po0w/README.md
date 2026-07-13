# PO0W 防火墙白名单

通过客户端当前的公网出口 IP 调用防火墙 API，自动维护目标服务器的访问白名单。

目前支持 **Surge iOS、Surge macOS、Egern、Stash、Loon** 和 **Quantumult X**，后续将逐步支持其他客户端。

## 客户端支持

| 客户端 | 状态 | 配置文件 |
| --- | --- | --- |
| Surge iOS | 已支持 | [`surge/po0w.sgmodule`](surge/po0w.sgmodule) |
| Surge macOS | 测试中 | [`surge/po0w.sgmodule`](surge/po0w.sgmodule) |
| Egern | 已支持 | [`egern/po0w.yaml`](egern/po0w.yaml) |
| Stash | 已支持 | [`stash/po0w.stoverride`](stash/po0w.stoverride) |
| Loon | 已支持 | [`loon/po0w.plugin`](loon/po0w.plugin) |
| Quantumult X | 已支持 | [`quanx/po0w.conf`](quanx/po0w.conf) |
| 其他客户端 | 计划中 | - |

## 功能

- Surge、Egern、Loon 与 Quantumult X 可在系统网络发生变化时自动更新白名单；Stash 当前不提供网络变化脚本类型。
- 每小时的第 0、30 分钟执行一次定时更新，用于托底。
- 根据当前网络环境自动选择蜂窝或非蜂窝 token 组；Wi-Fi、有线网卡及其他接口均属于非蜂窝。
- 支持一个网络配置多个 `token@slot_id`，并汇总展示全部请求结果。
- 支持指定自动更新时需要跳过的 Wi-Fi SSID。
- 自动更新会先通过 `DIRECT` 查询公网 IP；如果与缓存白名单中当前 slot 的 IP 一致，则不调用写入 API。
- Surge iOS 可点击 Panel 刷新按钮立即更新；Stash 可点击 Tile 手动刷新；Egern、Loon 与 Quantumult X 提供独立的手动更新脚本。
- 所有白名单 API 请求以及公网 IP 查询强制使用客户端的 `DIRECT` 策略。
- Panel、Tile、Widget、通知和交互结果页展示公网 IP、查询来源缩写、运营商地区、当前 IP 和完整白名单。

## 安装

### Surge iOS / macOS

在 Surge 中使用以下地址安装模块：

```text
https://raw.githubusercontent.com/alecthw/chnlist/main/po0w/surge/po0w.sgmodule
```

安装后编辑模块参数，将示例 token 替换为实际值。Surge Mac 使用同一个模块，Wi-Fi、有线网卡及其他网络均使用 `wifi_tokens`；Mac 不支持 Information Panel，当前先验证网络变化与 30 分钟定时更新功能。

### Egern

在 Egern 的“工具 → 模块”中使用以下地址安装模块：

```text
https://raw.githubusercontent.com/alecthw/chnlist/main/po0w/egern/po0w.yaml
```

安装后在模块的 Env 区域填写参数。界面中的 token 和 SSID 示例只是输入提示，必须替换为实际配置；`cache_diff` 默认开启。需要立即更新时，在 Egern 脚本列表中运行“PO0 手动更新”；“PO0 状态”Widget 只负责读取并展示最近结果，不会自动调用 API。

### Stash

在 Stash 中使用以下地址安装覆写：

```text
https://raw.githubusercontent.com/alecthw/chnlist/main/po0w/stash/po0w.stoverride
```

Stash 覆写没有交互式参数表。安装前或导入后，请同时编辑 `cron.script` 与 `tiles` 中的 `argument`，将示例 token、SSID 和 `cache_diff` 替换为实际配置，并确保两处参数完全一致。支持 `$trigger` 的版本会让 Tile 的非按钮刷新只读取最近结果，点击刷新按钮时按当前网络选择 token、忽略 `skip_ssids` 并立即更新；如果运行环境没有提供 `$trigger`，Tile 执行会安全降级为手动更新。

Stash 官方脚本覆写当前没有网络变化脚本类型，因此无法在网络切换瞬间自动触发。本实现使用每小时第 0、30 分钟的定时任务自动更新，并由 Tile 提供手动刷新入口；定时任务依赖 Stash 的 Network Extension（VPN）处于已连接状态。

Stash 官方脚本文档目前也没有公开 `$network` 字段。本实现会防御性读取兼容对象中的 `v4/v6.primaryInterface` 与 Wi-Fi SSID；只有取得的全部主接口都匹配 `pdp_ip*` 才使用蜂窝 token，字段缺失时按非蜂窝处理。建议首次安装后分别在蜂窝与 Wi-Fi 下点击 Tile，确认其中显示的网络分类符合设备实际情况。

### Loon

在 Loon 中使用以下地址安装插件：

```text
https://raw.githubusercontent.com/alecthw/chnlist/main/po0w/loon/po0w.plugin
```

安装后在插件参数中填写 `host`、`cellular_tokens`、`wifi_tokens`、`skip_ssids` 和 `cache_diff`。Loon 的“PO0W 手动更新”会忽略 `skip_ssids` 并立即调用 API；“PO0W 查看最近结果”只读取共享快照，通过通知展示上一次请求的网络环境、公网 IP、运营商、当前 IP、白名单和每个请求的结果。

Loon 官方 Script API 目前没有提供主接口信息。本实现仍会防御性读取兼容的 `$network.v4/v6.primaryInterface`，但只有确实取得且全部匹配 `pdp_ip*` 时才判定为蜂窝；接口字段缺失时严格按非蜂窝处理并使用 `wifi_tokens`。因此首次安装后应分别在蜂窝、Wi-Fi 和外接网卡下运行“PO0W 手动更新”，根据通知中的网络分类确认当前 Loon 版本是否提供兼容字段。

Loon 只会执行整个配置中排在最前面的一个 `network-changed` 脚本。如果同时安装了其他包含该脚本类型的插件，只有最靠前的插件能在网络切换时立即运行；PO0W 的 30 分钟定时任务和两个手动脚本不受此限制。

### Quantumult X

使用以下地址获取 Quantumult X 配置片段：

```text
https://raw.githubusercontent.com/alecthw/chnlist/main/po0w/quanx/po0w.conf
```

将文件中的 `[task_local]` 内容合并到 Quantumult X 配置。Quantumult X 没有交互式参数表，请同步编辑四条任务 URL 的 `#` fragment，将示例 token、SSID 和 `cache_diff` 替换为实际配置并保持四处参数一致；参数包含 `&`、`#` 等 URL 保留字符时需要先编码。

“PO0W 手动更新”UIAction 会忽略 `skip_ssids` 并立即调用 API；“PO0W 查看状态”只读取共享快照，通过 Quantumult X 的交互结果页展示最近一次请求。`event-network`、定时任务和 UIAction 都依赖 Quantumult X Tunnel 处于运行状态。

Quantumult X 没有公开 Surge 式主接口字段。本实现优先将非空 SSID 判为非蜂窝；当该字段是本地 IPv4/IPv6 地址时按有线网络处理且不参与 `skip_ssids` 匹配；SSID 为空时，仅在 `$environment.cellular` 返回明确的当前蜂窝信息时判为蜂窝，否则归入非蜂窝。建议首次安装后分别在蜂窝、Wi-Fi 和外接网卡下运行“PO0W 手动更新”，确认交互结果中的网络分类。

## 参数

| 参数 | 是否必填 | 说明 |
| --- | --- | --- |
| `host` | 否 | API 主机的 IP 地址或域名，默认 `124.221.69.228`。不要填写路径 |
| `cellular_tokens` | 二选一 | 蜂窝网络使用的 token，格式为 `token@slot_id` |
| `wifi_tokens` | 二选一 | Wi-Fi、有线网卡及其他非蜂窝网络使用的 token，格式为 `token@slot_id`；Loon 或 Quantumult X 无法确认蜂窝时也使用此组 |
| `skip_ssids` | 否 | 自动更新时需要跳过的 Wi-Fi SSID，多个 SSID 使用竖线分隔 |
| `cache_diff` | 否 | `true` 时比较公网 IP 与 slot 缓存，相同则跳过写入；`false` 时直接调用白名单 API。默认 `true` |

`cellular_tokens` 和 `wifi_tokens` 不能同时为空。每组可以配置多个 token，使用 `|` 分隔：

```text
cellular_tokens=token1@3|token2@4
wifi_tokens=token3@2|token4@5
skip_ssids=Home|Office
cache_diff=true
```

`slot_id` 必须是非负整数。实际可用范围由服务器返回的白名单 `limit` 决定。

## 触发行为

| 触发方式 | 当前网络 | 使用的 token | `skip_ssids` 行为 |
| --- | --- | --- | --- |
| 网络变化 | 蜂窝 | `cellular_tokens` | 不适用 |
| 网络变化 | Wi-Fi | `wifi_tokens` | 匹配时跳过 |
| 网络变化 | 有线或其他非蜂窝 | `wifi_tokens` | 不适用 |
| 30 分钟定时任务 | 蜂窝 | `cellular_tokens` | 不适用 |
| 30 分钟定时任务 | Wi-Fi | `wifi_tokens` | 匹配时跳过 |
| 30 分钟定时任务 | 有线或其他非蜂窝 | `wifi_tokens` | 不适用 |
| Surge iOS Panel / Stash Tile / Egern、Loon 与 Quantumult X 手动脚本 | 蜂窝 | `cellular_tokens` | 不适用 |
| Surge iOS Panel / Stash Tile / Egern、Loon 与 Quantumult X 手动脚本 | Wi-Fi | `wifi_tokens` | 忽略匹配并强制更新 |
| Surge iOS Panel / Stash Tile / Egern、Loon 与 Quantumult X 手动脚本 | 有线或其他非蜂窝 | `wifi_tokens` | 不适用 |

表中的“网络变化”触发适用于 Surge、Egern、Loon 与 Quantumult X。Stash 使用 30 分钟定时任务和 Tile 手动刷新，不会在网络切换瞬间执行脚本；Loon 还受“整个配置只执行第一个 `network-changed` 脚本”的限制。

命中 `skip_ssids` 并自动跳过时，Surge iOS Panel / Stash Tile / Egern Widget / Loon 与 Quantumult X 最近结果会继续展示上一次请求的状态、当前 IP、白名单和结果时间，不会用空结果覆盖。

除 Quantumult X 外，脚本仅在所有已知主接口都匹配 iOS 蜂窝接口 `pdp_ip*` 时判定为蜂窝；其他接口、接口不一致或接口信息缺失时均按非蜂窝处理。Quantumult X 在没有主接口字段时使用其原生 `$environment.cellular` 作为正向蜂窝信号，具体限制见安装章节。`skip_ssids` 只在确实取得 Wi-Fi SSID 时生效。

Surge iOS Panel 的自动刷新、Stash Tile 的非点击刷新、Egern 状态 Widget、Loon 的“PO0W 查看最近结果”和 Quantumult X 的“PO0W 查看状态”都只读取本地保存的最近结果，不会调用白名单 API。手动请求需要点击 Surge iOS Panel 刷新按钮或 Stash Tile，或运行 Loon、Quantumult X 的“PO0W 手动更新”及 Egern 的“PO0 手动更新”脚本。

## API 请求

需要写入时，每个 token 会调用一次：

```http
GET https://<host>/api/firewall/<token>/add?slot=<slot_id>
```

请求强制使用 `DIRECT`，确保服务器识别到当前蜂窝或非蜂窝网络的真实公网出口 IP。

各客户端的自动任务会先通过 `126`、`BILI`、`IPIP` 三个来源依次查询公网 IP，所有查询同样强制使用 `DIRECT`。取得公网 IP 后，脚本按当前 `token@slot` 找到对应 slot 缓存；如果缓存 IP 与公网 IP 一致，该 token 显示为“无需更新”，不会调用白名单写入 API。公网 IP 查询失败时会继续调用写入 API，避免第三方查询服务异常造成漏更新。

`cache_diff` 只控制是否执行上述缓存比较。设为 `false` 时，网络变化和定时任务仍会查询并展示公网 IP 与运营商，但会跳过比较步骤，直接调用所有有效 token 的白名单写入 API。

点击 Surge Panel 或 Stash Tile 刷新按钮，以及运行 Egern、Loon、Quantumult X 手动更新时，仍会先查询并展示公网 IP 与运营商，但属于强制刷新，不受 `cache_diff` 影响；即使公网 IP 与缓存一致，也会调用所有有效 token 的白名单写入 API。多个 token 的执行结果汇总为：

- 成功：全部请求成功。
- 部分失败：部分请求成功、部分失败。
- 失败：全部请求失败。

如果 API 返回 `{"code":403,"message":"IP is already pinned to another slot."}`，脚本会将该请求显示为“已存在”，不计入失败。因为当前 IP 已经处于白名单的其他 slot，无需重复添加；如果本地保存有该请求的上一次 IP 和白名单，则继续沿用展示。

## Panel / Tile / Widget / 通知与交互展示

Surge iOS Panel、Stash Tile、Egern Widget、Loon 最近结果通知，以及 Quantumult X 交互结果页会展示最近一次请求的：

- API 请求结果和当时的网络环境。
- 公网 IP 后使用括号标注查询来源 `126`、`BILI` 或 `IPIP`。
- 地区与运营商格式例如“上海联通”“江苏苏州电信”“浙江杭州移动”。
- 触发方式与结果时间。
- 每个 `token@slot_id` 对应请求的成功或失败状态。
- 当前 IP。
- 白名单，格式为 `slot: IP`。

蜂窝和非蜂窝网络不会分别保存结果，所有网络共用同一份最近结果快照。新的更新结果会覆盖当前展示；遇到“IP 已存在于其他 slot”时，会优先按相同 token 跨网络复用上一次的当前 IP 和白名单，匹配不到时再使用最近一条可用结果。

持久化内容包含最近的公网 IP、查询来源、运营商信息、白名单结果，以及用于跨网络切换比较的 slot IP 缓存。比较记录使用 `token` 哈希定位并读取对应 slot，不区分蜂窝和非蜂窝，也不保存原始 token；用于隔离不同模块配置的存储键只包含配置哈希。

## 注意事项

- token 会保存在客户端模块参数中，请勿分享已填写真实 token 的配置或截图。
- API 使用 HTTPS，并保持服务器证书校验开启。
- 如果当前网络对应的 token 组为空，本次不会发起请求。
- Wi-Fi SSID 匹配区分大小写。

## 文件说明

- [`surge/po0w.sgmodule`](surge/po0w.sgmodule)：Surge iOS 与 macOS 共用模块配置。
- [`surge/po0w.js`](surge/po0w.js)：网络判断、API 请求、结果聚合、Panel 与 Mac 手动通知脚本。
- [`egern/po0w.yaml`](egern/po0w.yaml)：Egern 模块配置。
- [`egern/po0w.js`](egern/po0w.js)：使用 Egern `ctx` API 的原生实现，不依赖 Surge 适配层。
- [`stash/po0w.stoverride`](stash/po0w.stoverride)：Stash 覆写配置，提供 30 分钟定时任务和 Tile。
- [`stash/po0w.js`](stash/po0w.js)：使用 Stash 脚本全局接口的原生实现，不依赖其他客户端适配层。
- [`loon/po0w.plugin`](loon/po0w.plugin)：Loon 插件配置，提供网络变化、30 分钟定时、手动更新和查看结果脚本。
- [`loon/po0w.js`](loon/po0w.js)：使用 Loon `$argument`、`$config`、`$httpClient` 等原生接口的实现。
- [`quanx/po0w.conf`](quanx/po0w.conf)：Quantumult X `[task_local]` 配置片段，提供网络变化、30 分钟定时和两个 UIAction。
- [`quanx/po0w.js`](quanx/po0w.js)：使用 Quantumult X `$environment`、`$task`、`$prefs` 与 `$done` 的原生实现。

## 后续计划

- 支持更多代理客户端。
- 在保持统一参数格式的前提下复用现有 API 与 Panel 展示逻辑。
