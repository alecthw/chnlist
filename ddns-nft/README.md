# nftables po0 严格转发规则

这里提供一套用于 po0 转发机的 nftables 配置模板，并配合 DDNS 域名自动维护 IPv4 白名单。

目标效果：

- 仅允许中国大陆 IPv4 访问服务器 SSH。
- 仅允许白名单 IPv4 访问 po0 转发目的地址。
- 服务器本机出站仅允许访问局域网地址、中国大陆 IPv4 和配置中的 po0/rfc 出口机地址。
- 白名单来源由 DDNS 域名解析得到，并统一转换成 `/24` 网段保存，避免移动网络或家庭宽带地址小范围变化后频繁失效。

## 文件说明

- `po0-example.nft`：nftables 主配置模板，包含 NAT 转发、入站/转发/出站过滤规则。
- `generate_whitelist4.sh`：解析指定 DDNS 域名的 A 记录，生成 `/etc/nftables/whitelist4.nft`，并刷新 nftables。
- `surge/`：Surge 模块和共享 DDNS 脚本。
- `loon/`：Loon 插件，复用 `DDNS.js`。
- `stash/`：Stash 覆写配置，复用 `DDNS.js`。
- `egern/`：Egern 模块配置，复用 `DDNS.js`。
- `quanx/`：Quantumult X 配置片段，复用 `DDNS.js` 的兼容层。
- `cn4.nft`：中国大陆 IPv4 地址集合，需要从 release 地址下载到服务器。
- `whitelist4.nft`：脚本生成的白名单 IPv4 集合，不需要手动维护。

## 依赖

服务器需要安装：

```bash
apt install nftables dnsutils
```

其中 `dnsutils` 提供 `dig`。如果没有 `dig`，脚本会 fallback 到 `getent ahostsv4`。

域名解析使用服务器系统当前 DNS 配置：

- 有 `dig` 时执行 `dig +short A 域名`。
- 没有 `dig` 时执行 `getent ahostsv4 域名`。

脚本不会指定固定公共 DNS。

## 准备目录和中国大陆 IPv4 集合

创建 nftables include 目录：

```bash
mkdir -p /etc/nftables
```

下载中国大陆 IPv4 set：

```bash
curl -fsSL https://raw.githubusercontent.com/alecthw/chnlist/release/nftables/cn4.nft \
  -o /etc/nftables/cn4.nft
```

该文件由仓库自动生成。po0 环境通常不需要高频更新，如需更新可手动重新下载。

## 配置主规则

参考 `po0-example.nft`，修改顶部变量：

```nft
define SSH_PORT = 22

define RELAY_LAN_IP = 10.100.0.10

define PORT_IN_1   = 30001
define DEST_IP_1   = 203.0.113.10
define DEST_PORT_1 = 30001
```

需要注意：

- `RELAY_LAN_IP` 应填写本机 po0 内网地址。
- `PORT_IN_*` 是本机监听端口。
- `DEST_IP_*` / `DEST_PORT_*` 是实际 rfc/po0 出口机地址和端口。
- 模板中会 include `/etc/nftables/cn4.nft` 和 `/etc/nftables/whitelist4.nft`。

确认无误后覆盖系统配置：

```bash
cp ddns-nft/po0-example.nft /etc/nftables.conf
```

## 配置 DDNS 白名单

编辑 `generate_whitelist4.sh` 中的 `DOMAINS`：

```bash
DOMAINS=(
  "ddns1.example.com"
  "ddns2.example.com"
  "ddns3.example.com"
)
```

脚本执行流程：

1. 读取已有 `/etc/nftables/whitelist4.nft` 中的 `/24` 网段。
2. 查询 `DOMAINS` 里每个域名的 IPv4 A 记录。
3. 将每个 IPv4 转换成 `/24`，例如 `180.102.51.80` 转成 `180.102.51.0/24`。
4. 如果没有新增 `/24` 网段，直接退出，不写入文件，也不刷新 nftables。
5. 如果存在新增网段，和已有白名单合并、去重，写回 `/etc/nftables/whitelist4.nft`。
6. 执行 `nft -f /etc/nftables.conf` 刷新规则。

脚本只处理 IPv4 A 记录，不处理 IPv6。

首次运行前，如果主配置已经 include 了 `whitelist4.nft`，可以先创建一个空集合，避免 nftables 因 include 文件不存在而失败：

```bash
cat >/etc/nftables/whitelist4.nft <<'EOF'
set whitelist4 {
    type ipv4_addr
    flags interval
    auto-merge
    elements = {
    }
}
EOF
```

然后执行脚本：

```bash
bash ddns-nft/generate_whitelist4.sh
```

root 执行时脚本会直接调用 `nft`；非 root 执行时会通过 `sudo nft` 刷新规则。

## 检查和应用

先检查语法：

```bash
nft -c -f /etc/nftables.conf
```

应用规则：

```bash
nft -f /etc/nftables.conf
systemctl restart nftables
```

确认集合已经加载：

```bash
nft list set ip filter whitelist4
nft list set ip filter cn4
```

## 定时更新白名单

建议定时执行 `generate_whitelist4.sh`，让 DDNS 地址变化后自动进入白名单。DDNS 模块已经监听网络变化并会主动更新解析记录，定时检测主要用于兜底，无需高频触发：

```cron
*/30 * * * * /bin/bash /path/to/generate_whitelist4.sh >> /var/log/generate_whitelist4.log 2>&1
```

脚本会保留已有白名单网段，并追加新解析到的 `/24`。如果没有新增网段，本次执行不会改写 `/etc/nftables/whitelist4.nft`，也不会刷新 nftables；旧网段不会自动删除。

## 常见问题

### `sudo: unable to resolve host ...`

这是 sudo 在解析本机 hostname 时的警告，通常是 `/etc/hostname` 和 `/etc/hosts` 不匹配导致。当前脚本 root 执行时不会再调用 sudo，因此 root 手动执行不会触发这个警告。

如果非 root 执行仍出现该提示，检查 `/etc/hosts` 是否包含当前 hostname，例如：

```text
127.0.1.1 your-hostname
```

### 手动 `nft -f /etc/nftables.conf` 不报错，但脚本报 hostname 解析

手动执行 `nft` 不经过 sudo；旧脚本无论是否 root 都调用 `sudo nft`，所以会触发 sudo 的 hostname 检查。现在脚本已改为 root 直接调用 `nft`。

### 域名解析用的是哪个 DNS

脚本不指定 DNS 服务器，使用系统 resolver。也就是服务器 `/etc/resolv.conf`、systemd-resolved 或本机 DNS 缓存服务配置的 DNS。

### 为什么用 `/24` 而不是单个 IP

DDNS 客户端、公网出口和服务器端解析可能存在短时间不一致；一些网络的公网 IPv4 也可能在同一网段内变化。保存 `/24` 可以减少频繁变动导致的访问失败。
