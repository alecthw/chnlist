# po0 严格规则

高防限制：

- 仅允许中国大陆 IP 地址连接到 po0 转发
- 仅允许本地入站，和中国大陆 IP 的 SSH 入站
- 本地仅允许向局域网地址、中国大陆 IP 以及 rfc/po0 出口机 发起连接

## 使用

需先下载 China ip 地址 set

- <https://raw.githubusercontent.com/alecthw/chnlist/release/nftables/cn4.nft>

该文件每日从 clang.cn 拉取地址表自动生成。不过由于 po0 禁 http/https，就不用设置每日自动更新了，也没必要每天更新。

新建目录 `mkdir /etc/nftables`，将其放到这个目录下 `/etc/nftables/cn4.nft`。

参考 [po0-example.nft](po0-example.nft) 模板，配置成你的转发端口和 IP，覆盖 `/etc/nftables.conf` 的配置即可。

应用生效：

```bash
# 写完后先检查语法：
nft -c -f /etc/nftables.conf

# 应用
nft -f /etc/nftables.conf
systemctl restart nftables
```
