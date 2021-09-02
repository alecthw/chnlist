# chnlist

![Daily Build](https://github.com/alecthw/chnlist/workflows/Daily%20Build/badge.svg)

自定义域名，生产dnsmasq格式的配置文件。

引用数据取自[v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)。

## 原由

passwall+chinadns-ng使用时，采用chinaip白名单模式，配置自定义域名直连时，虽然通过分流规则配置直连，但是其dns解析结果依然从代理走了，解析成代理区域的服务器，并非最优服务器。

如果直接写入direct_host，时不时需手动更新。

所以做了这个项目，每天拉取[v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)的数据，加上自定义的域名，生成dnsmasq格式的配置文件，然后在passwall中订阅即可。

主要是为了解决steam等下载问题

## 下载地址
| release分支 | CDN |
| ------ | ------ |
| [链接](https://raw.githubusercontent.com/alecthw/chnlist/release/direct.domains.conf) | [链接](https://cdn.jsdelivr.net/gh/alecthw/chnlist@release/direct.domains.conf) |


