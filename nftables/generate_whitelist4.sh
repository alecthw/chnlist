#!/usr/bin/env bash

# crontab示例：*/5 * * * * /bin/bash /path/to/generate_whitelist4.sh >> /var/log/generate_whitelist4.log 2>&1

set -euo pipefail

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export PATH

NFTABLES_CONF="/etc/nftables.conf"
OUTPUT_DIR="/etc/nftables"
OUTPUT_FILE="${OUTPUT_DIR}/whitelist4.nft"

# 填写需要解析的域名
DOMAINS=(
  "ddns1.example.com"
  "ddns2.example.com"
  "ddns3.example.com"
)

TMP_NETS="$(mktemp)"
TMP_EXISTING="$(mktemp)"
TMP_ALL="$(mktemp)"

cleanup() {
  rm -f "$TMP_NETS" "$TMP_EXISTING" "$TMP_ALL"
}
trap cleanup EXIT

ip_to_cidr24() {
  local ip="$1"
  IFS='.' read -r a b c d <<< "$ip"
  [[ -n "${a:-}" && -n "${b:-}" && -n "${c:-}" && -n "${d:-}" ]] || return 1
  echo "${a}.${b}.${c}.0/24"
}

extract_existing_nets() {
  if [[ -f "$OUTPUT_FILE" ]]; then
    grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}/24' "$OUTPUT_FILE" | sort -u > "$TMP_EXISTING" || true
  else
    : > "$TMP_EXISTING"
  fi
}

resolve_domain() {
  local domain="$1"
  if command -v dig >/dev/null 2>&1; then
    dig +short A "$domain" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true
  else
    getent ahostsv4 "$domain" | awk '{print $1}' | sort -u || true
  fi
}

find_nft() {
  if command -v nft >/dev/null 2>&1; then
    command -v nft
  elif [[ -x /usr/sbin/nft ]]; then
    echo /usr/sbin/nft
  elif [[ -x /sbin/nft ]]; then
    echo /sbin/nft
  else
    echo "错误: 未找到 nft 命令，请确认已安装 nftables。" >&2
    return 1
  fi
}

echo "检查输出目录..."
mkdir -p "$OUTPUT_DIR"

echo "读取现有网段..."
extract_existing_nets

: > "$TMP_NETS"

echo "查询域名 DNS..."
for domain in "${DOMAINS[@]}"; do
  echo "处理域名: $domain"
  while IFS= read -r ip; do
    [[ -z "$ip" ]] && continue
    cidr="$(ip_to_cidr24 "$ip")" || continue

    if grep -qxF "$cidr" "$TMP_EXISTING"; then
      echo "  已存在，跳过: $cidr"
      continue
    fi

    echo "$cidr" >> "$TMP_NETS"
    echo "  新增: $cidr"
  done < <(resolve_domain "$domain")
done

if [[ ! -s "$TMP_NETS" ]]; then
  echo "没有新增网段，跳过写入 $OUTPUT_FILE 和刷新 nftables。"
  echo "处理完成，临时文件已删除。"
  exit 0
fi

NFT_BIN="$(find_nft)"
if [[ "$(id -u)" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
  echo "错误: 非 root 执行时需要 sudo。" >&2
  exit 1
fi

cat "$TMP_EXISTING" "$TMP_NETS" | sort -u > "$TMP_ALL"

{
  echo "set whitelist4 {"
  echo "    type ipv4_addr"
  echo "    flags interval"
  echo "    auto-merge"
  echo "    elements = {"

  total="$(wc -l < "$TMP_ALL" | tr -d ' ')"
  idx=0
  while IFS= read -r net; do
    [[ -z "$net" ]] && continue
    idx=$((idx + 1))
    if [[ "$idx" -lt "$total" ]]; then
      echo "        ${net},"
    else
      echo "        ${net}"
    fi
  done < "$TMP_ALL"

  echo "    }"
  echo "}"
} > "$OUTPUT_FILE"

echo "已写入 $OUTPUT_FILE"

echo "刷新 nftables 规则..."
if [[ "$(id -u)" -eq 0 ]]; then
  "$NFT_BIN" -f "$NFTABLES_CONF"
else
  sudo "$NFT_BIN" -f "$NFTABLES_CONF"
fi

echo "处理完成，临时文件已删除。"
