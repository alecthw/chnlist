# PO0W 防火墙白名单

通过客户端当前的公网出口 IP 调用防火墙 API，自动维护目标服务器的访问白名单。

目前仅支持 **Surge iOS**，后续将逐步支持其他客户端。

## 客户端支持

| 客户端 | 状态 | 配置文件 |
| --- | --- | --- |
| Surge iOS | 已支持 | [`surge/po0w.sgmodule`](surge/po0w.sgmodule) |
| 其他客户端 | 计划中 | - |

## 功能

- 系统网络发生变化时自动更新白名单。
- 每小时的第 0、30 分钟执行一次定时更新，用于托底。
- 根据当前网络环境自动选择蜂窝或 Wi-Fi token 组。
- 支持一个网络配置多个 `token@slot_id`，并汇总展示全部请求结果。
- 支持指定自动更新时需要跳过的 Wi-Fi SSID。
- 点击 Panel 刷新按钮可立即手动更新。
- 所有白名单 API 请求强制使用 Surge `DIRECT` 策略。
- Panel 展示成功、失败或部分失败，以及当前 IP 和完整白名单。

## 安装

在 Surge 中使用以下地址安装模块：

```text
https://raw.githubusercontent.com/alecthw/chnlist/main/po0w/surge/po0w.sgmodule
```

安装后编辑模块参数，将示例 token 替换为实际值。模块仅适用于 iOS。

## 参数

| 参数 | 是否必填 | 说明 |
| --- | --- | --- |
| `host` | 否 | API 主机的 IP 地址或域名，默认 `124.221.69.228`。不要填写路径 |
| `cellular_tokens` | 二选一 | 蜂窝网络使用的 token，格式为 `token@slot_id` |
| `wifi_tokens` | 二选一 | Wi-Fi 使用的 token，格式为 `token@slot_id` |
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
| 30 分钟定时任务 | 蜂窝 | `cellular_tokens` | 不适用 |
| 30 分钟定时任务 | Wi-Fi | `wifi_tokens` | 匹配时跳过 |
| Panel 手动刷新 | 蜂窝 | `cellular_tokens` | 不适用 |
| Panel 手动刷新 | Wi-Fi | `wifi_tokens` | 忽略匹配并强制更新 |

命中 `skip_ssids` 并自动跳过时，Panel 会继续展示上一次请求的状态、当前 IP、白名单和结果时间，不会用空结果覆盖。

Panel 的自动刷新只读取本地保存的最近结果，不会调用白名单 API。只有点击 Panel 刷新按钮才会手动发起请求。

## API 请求

每个 token 会调用一次：

```http
GET https://<host>/api/firewall/<token>/add?slot=<slot_id>
```

请求强制使用 `DIRECT`，确保服务器识别到当前蜂窝或 Wi-Fi 的真实公网出口 IP。多个 token 会全部调用，并根据结果汇总为：

- 成功：全部请求成功。
- 部分失败：部分请求成功、部分失败。
- 失败：全部请求失败。

如果 API 返回 `{"code":403,"message":"IP is already pinned to another slot."}`，脚本会将该请求显示为“已存在”，不计入失败。因为当前 IP 已经处于白名单的其他 slot，无需重复添加；如果本地保存有该请求的上一次 IP 和白名单，则继续沿用展示。

## Panel 展示

Panel 会展示最近一次请求的：

- API 请求结果和当时的网络环境。
- 触发方式与结果时间。
- 每个 `token@slot_id` 对应请求的成功或失败状态。
- 当前 IP。
- 白名单，格式为 `slot: IP`。

脚本只持久化最近一轮的展示结果，新的 API 请求结果会覆盖旧结果。持久化内容不包含原始 token；用于隔离不同模块配置的存储键只包含配置哈希。

## 注意事项

- token 会保存在 Surge 模块参数中，请勿分享已填写真实 token 的配置或截图。
- API 使用 HTTPS，并保持服务器证书校验开启。
- 如果当前网络对应的 token 组为空，本次不会发起请求。
- Wi-Fi SSID 匹配区分大小写。

## 文件说明

- [`surge/po0w.sgmodule`](surge/po0w.sgmodule)：Surge 模块配置。
- [`surge/po0w.js`](surge/po0w.js)：网络判断、API 请求、结果聚合和 Panel 脚本。

## 后续计划

- 支持更多代理客户端。
- 在保持统一参数格式的前提下复用现有 API 与 Panel 展示逻辑。
