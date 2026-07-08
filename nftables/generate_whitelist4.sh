#!/usr/bin/env bash

# crontab示例：*/5 * * * * /bin/bash /path/to/generate_whitelist4.sh >> /var/log/generate_whitelist4.log 2>&1

set -euo pipefail

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
sudo nft -f "$NFTABLES_CONF"

echo "处理完成，临时文件已删除。"
