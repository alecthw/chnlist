# PO0W 防火墙白名单

通过客户端当前的公网出口 IP 调用防火墙 API，自动维护目标服务器的访问白名单。

目前支持 **Surge iOS、Surge macOS** 和 **Egern**，后续将逐步支持其他客户端。

## 客户端支持

| 客户端 | 状态 | 配置文件 |
| --- | --- | --- |
| Surge iOS | 已支持 | [`surge/po0w.sgmodule`](surge/po0w.sgmodule) |
| Surge macOS | 已支持 | [`surge/po0w-mac.sgmodule`](surge/po0w-mac.sgmodule) |
| Egern | 已支持 | [`egern/po0w.yaml`](egern/po0w.yaml) |
| 其他客户端 | 计划中 | - |

## 功能

- 系统网络发生变化时自动更新白名单。
- 每小时的第 0、30 分钟执行一次定时更新，用于托底。
- 根据当前网络环境自动选择蜂窝或非蜂窝 token 组；Wi-Fi、有线网卡及其他接口均属于非蜂窝。
- 支持一个网络配置多个 `token@slot_id`，并汇总展示全部请求结果。
- 支持指定自动更新时需要跳过的 Wi-Fi SSID。
- Surge iOS 可点击 Panel 刷新按钮立即更新；Surge Mac 与 Egern 提供独立的手动更新脚本。
- 所有白名单 API 请求强制使用客户端的 `DIRECT` 策略。
- Surge iOS Panel 与 Egern Widget 展示成功、失败或部分失败，以及当前 IP 和完整白名单。

## 安装

### Surge iOS

在 Surge 中使用以下地址安装模块：

```text
https://raw.githubusercontent.com/alecthw/chnlist/main/po0w/surge/po0w.sgmodule
```

安装后编辑模块参数，将示例 token 替换为实际值。

### Surge macOS

Surge Mac 5.5.0 及以上版本使用独立的参数表格式，请安装：

```text
https://raw.githubusercontent.com/alecthw/chnlist/main/po0w/surge/po0w-mac.sgmodule
```

安装后填写 `WIFI_TOKENS`。Mac 的 Wi-Fi、有线网卡及其他网络均使用该 token 组；需要立即更新时，在脚本列表中运行“PO0W 手动更新”。Surge Mac 不提供 Information Panel，手动结果通过系统通知和脚本日志返回。

### Egern

在 Egern 的“工具 → 模块”中使用以下地址安装模块：

```text
https://raw.githubusercontent.com/alecthw/chnlist/main/po0w/egern/po0w.yaml
```

安装后在模块的 Env 区域填写参数。界面中的 token 和 SSID 示例只是输入提示，必须替换为实际配置。需要立即更新时，在 Egern 脚本列表中运行“PO0 手动更新”；“PO0 状态”Widget 只负责读取并展示最近结果，不会自动调用 API。

## 参数

| 参数 | 是否必填 | 说明 |
| --- | --- | --- |
| `host` | 否 | API 主机的 IP 地址或域名，默认 `124.221.69.228`。不要填写路径 |
| `cellular_tokens` | 二选一 | 蜂窝网络使用的 token，格式为 `token@slot_id` |
| `wifi_tokens` | 二选一 | Wi-Fi、有线网卡及其他非蜂窝网络使用的 token，格式为 `token@slot_id`；Surge Mac 中对应 `WIFI_TOKENS` |
| `skip_ssids` | 否 | 自动更新时需要跳过的 Wi-Fi SSID，多个 SSID 使用竖线分隔 |

`cellular_tokens` 和 `wifi_tokens` 不能同时为空。每组可以配置多个 token，使用 `|` 分隔：

```text
cellular_tokens=token1@3|token2@4
wifi_tokens=token3@2|token4@5
skip_ssids=Home|Office
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
| Surge iOS Panel / Surge Mac 与 Egern 手动脚本 | 蜂窝 | `cellular_tokens` | 不适用 |
| Surge iOS Panel / Surge Mac 与 Egern 手动脚本 | Wi-Fi | `wifi_tokens` | 忽略匹配并强制更新 |
| Surge iOS Panel / Surge Mac 与 Egern 手动脚本 | 有线或其他非蜂窝 | `wifi_tokens` | 不适用 |

命中 `skip_ssids` 并自动跳过时，Surge iOS Panel / Egern Widget 会继续展示上一次请求的状态、当前 IP、白名单和结果时间，不会用空结果覆盖。

脚本仅在所有已知主接口都匹配 iOS 蜂窝接口 `pdp_ip*` 时判定为蜂窝；其他接口、接口不一致或接口信息缺失时均按非蜂窝处理。`skip_ssids` 只在确实取得 Wi-Fi SSID 时生效。

Surge iOS Panel 的自动刷新和 Egern 状态 Widget 都只读取本地保存的最近结果，不会调用白名单 API。手动请求需要点击 Surge iOS Panel 刷新按钮，或运行 Surge Mac 的“PO0W 手动更新”及 Egern 的“PO0 手动更新”脚本。

## API 请求

每个 token 会调用一次：

```http
GET https://<host>/api/firewall/<token>/add?slot=<slot_id>
```

请求强制使用 `DIRECT`，确保服务器识别到当前蜂窝或非蜂窝网络的真实公网出口 IP。多个 token 会全部调用，并根据结果汇总为：

- 成功：全部请求成功。
- 部分失败：部分请求成功、部分失败。
- 失败：全部请求失败。

如果 API 返回 `{"code":403,"message":"IP is already pinned to another slot."}`，脚本会将该请求显示为“已存在”，不计入失败。因为当前 IP 已经处于白名单的其他 slot，无需重复添加；如果本地保存有该请求的上一次 IP 和白名单，则继续沿用展示。

## Panel / Widget 展示

Surge iOS Panel 和 Egern Widget 会展示最近一次请求的：

- API 请求结果和当时的网络环境。
- 触发方式与结果时间。
- 每个 `token@slot_id` 对应请求的成功或失败状态。
- 当前 IP。
- 白名单，格式为 `slot: IP`。

蜂窝和非蜂窝网络不会分别保存结果，所有网络共用同一份最近结果快照。新的 API 请求结果会覆盖当前展示，最近可用结果历史仍保存在同一个存储键中；遇到“IP 已存在于其他 slot”时，会优先按相同 token 跨网络复用上一次的当前 IP 和白名单，匹配不到时再使用最近一条可用结果。

持久化内容不包含原始 token；用于隔离不同模块配置的存储键只包含配置哈希。

## 注意事项

- token 会保存在客户端模块参数中，请勿分享已填写真实 token 的配置或截图。
- API 使用 HTTPS，并保持服务器证书校验开启。
- 如果当前网络对应的 token 组为空，本次不会发起请求。
- Wi-Fi SSID 匹配区分大小写。

## 文件说明

- [`surge/po0w.sgmodule`](surge/po0w.sgmodule)：Surge iOS 模块配置。
- [`surge/po0w-mac.sgmodule`](surge/po0w-mac.sgmodule)：使用 Surge Mac 参数表格式的模块配置。
- [`surge/po0w.js`](surge/po0w.js)：网络判断、API 请求、结果聚合、Panel 与 Mac 手动通知脚本。
- [`egern/po0w.yaml`](egern/po0w.yaml)：Egern 模块配置。
- [`egern/po0w.js`](egern/po0w.js)：使用 Egern `ctx` API 的原生实现，不依赖 Surge 适配层。

## 后续计划

- 支持更多代理客户端。
- 在保持统一参数格式的前提下复用现有 API 与 Panel 展示逻辑。
