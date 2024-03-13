# chnlist

![Daily Build](https://github.com/alecthw/chnlist/workflows/Daily%20Build/badge.svg)

提供一些科学上网相关软件的配置文件，包含路由器端和手机端软件的配置。

本项目中的配置文件主要是示范作用，并非所有文件都是拿来即用的，有一些要用的话还需要稍作修改。

**另一个主要的目的：抛弃订阅转换！！！并不是说订阅转换不好，主要太麻烦，尽量利用软件内置的订阅能力，在本地达到分流目的。**

## 路由器--Passwall

自定义域名，生成 dnsmasq 格式的配置文件，用于在 Passwall 中订阅。

引用数据取自 [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)。

### 原由

主要是为了解决 `steam` 等下载问题.

`passwall + chinadns-ng` 使用时，采用 `chinaip` 白名单模式，配置自定义域名直连时，虽然通过分流规则配置直连，但是其dns解析结果依然从代理走了，解析成代理区域的服务器，并非最优服务器。

如果直接写入direct_host，时不时需手动更新。

所以做了这个项目，每天拉取 [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community) 的数据，加上自定义的域名，生成 dnsmasq 格式的配置文件，然后在 passwall 中订阅即可。

### 下载地址

| release分支 | CDN |
| ---------- | --- |
| [链接](https://raw.githubusercontent.com/alecthw/chnlist/release/direct.domains.conf) | [链接](https://cdn.jsdelivr.net/gh/alecthw/chnlist@release/direct.domains.conf) |

## mosdns

[whitelist.list](https://raw.githubusercontent.com/alecthw/chnlist/release/mosdns/whitelist.list) 用于 mosdns 中，配合域名白名单实现精准的解析。

详情参考此项目 [openwrt-actions](https://github.com/alecthw/openwrt-actions)，其中预置了 openclash 和 mosdns 相配合的配置。

## 路由器--Openclash

首先推广下自己编译的 [OpenWrt 旁路由极简版](https://github.com/alecthw/openwrt-actions)，专为旁路由而制作。

- 编译脚本以及个人修改的组件依赖全开源，Github Actions 在线编译，安全可靠无后门。
- 基于 [lede](https://github.com/coolsnowwolf/lede) 源码
- 默认配置 DHCPv6 Client 接口 lan6。
- 默认配置好了 AdGuardHome 、 mosdns 和 openclash （或 ssrp ）的搭配运行配置。
- openclash 预置 clash_meta 内核。
- mosdns 使用了 [自己的修改版](https://github.com/alecthw/mosdns)，支持 MMDB GeoIP 匹配。

待补充.....

## iOS--Surge

待补充.....

## iOS--Loon

待补充.....

## iOS--Stash

待补充.....

## iOS--QuantumultX

待补充.....

## iOS--Shadowrocket

待补充.....

## Android--[Clash.Meta for Android](https://github.com/MetaCubeX/ClashMetaForAndroid/releases/tag/Prerelease-alpha)

待补充.....
