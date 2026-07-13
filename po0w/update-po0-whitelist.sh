#!/bin/sh

# */5 * * * * /root/update-po0-whitelist.sh > /root/update-po0-whitelist.log 2>&1

TOKEN=""
SLOT="0"
CACHE_DIFF="true"
CACHE_MAX_AGE_HOURS=12

API_HOST="https://124.221.69.228"
API_URL="${API_HOST}/api/firewall/${TOKEN}/add?slot=${SLOT}"
CACHE_FILE="/tmp/po0w-currentip-slot-${SLOT}"
FORCE_UPDATE="false"

usage() {
    echo "Usage: $0 [-f]"
    echo "  -f  Force updating the whitelist and local cache"
}

while getopts "f" option; do
    case "$option" in
        f) FORCE_UPDATE="true" ;;
        *)
            usage
            exit 1
            ;;
    esac
done
shift $((OPTIND - 1))

if [ "$#" -ne 0 ]; then
    usage
    exit 1
fi

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*"
}

is_ipv4() {
    old_ifs="$IFS"
    IFS='.'
    set -- $1
    IFS="$old_ifs"

    [ "$#" -eq 4 ] || return 1
    for octet in "$@"; do
        case "$octet" in
            ''|*[!0-9]*) return 1 ;;
        esac
        [ "$octet" -le 255 ] 2>/dev/null || return 1
    done
    return 0
}

if [ -z "$TOKEN" ]; then
    log "ERROR: TOKEN is empty"
    exit 1
fi

case "$SLOT" in
    ''|*[!0-9]*)
        log "ERROR: SLOT must be a non-negative integer"
        exit 1
        ;;
esac

case "$(printf '%s' "$CACHE_DIFF" | tr 'A-Z' 'a-z')" in
    true) CACHE_DIFF="true" ;;
    false) CACHE_DIFF="false" ;;
    *)
        log "ERROR: CACHE_DIFF must be true or false"
        exit 1
        ;;
esac

case "$CACHE_MAX_AGE_HOURS" in
    ''|*[!0-9]*|0)
        log "ERROR: CACHE_MAX_AGE_HOURS must be a positive integer"
        exit 1
        ;;
esac
CACHE_MAX_AGE=$((CACHE_MAX_AGE_HOURS * 3600))

if command -v curl >/dev/null 2>&1; then
    HTTP_CLIENT="curl"
elif command -v wget >/dev/null 2>&1; then
    HTTP_CLIENT="wget"
else
    log "ERROR: curl or wget not found"
    exit 1
fi

get_public_ip() {
    for provider in 126 BILI IPIP
    do
        case "$provider" in
            126) url="https://ipservice.ws.126.net/locate/api/getLocByIp" ;;
            BILI) url="https://api.bilibili.com/x/web-interface/zone" ;;
            IPIP) url="https://myip.ipip.net/json" ;;
        esac

        if [ "$HTTP_CLIENT" = "curl" ]; then
            raw_ip="$(curl -k -f -sS --connect-timeout 5 --max-time 10 "$url" 2>/dev/null)"
        else
            raw_ip="$(wget --no-check-certificate -qO- -T 10 "$url" 2>/dev/null)"
        fi

        compact_response="$(printf '%s' "$raw_ip" | tr -d '\r\n')"
        case "$provider" in
            126|IPIP)
                public_ip="$(printf '%s' "$compact_response" | sed -n 's/.*"ip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
                ;;
            BILI)
                public_ip="$(printf '%s' "$compact_response" | sed -n 's/.*"addr"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
                ;;
        esac
        public_ip="$(printf '%s' "$public_ip" | tr -d ' \r\n\t')"
        if is_ipv4 "$public_ip"; then
            printf '%s\n' "$public_ip"
            return 0
        fi
    done
    return 1
}

PUBLIC_IP="$(get_public_ip)"
if ! is_ipv4 "$PUBLIC_IP"; then
    log "ERROR: failed to query public IPv4 address"
    exit 1
fi

CACHED_IP=""
CACHE_UPDATED_AT=""
if [ -f "$CACHE_FILE" ]; then
    CACHED_IP="$(sed -n '1p' "$CACHE_FILE")"
    CACHE_UPDATED_AT="$(sed -n '2p' "$CACHE_FILE")"
    if ! is_ipv4 "$CACHED_IP"; then
        CACHED_IP=""
    fi
fi

NOW="$(date '+%s')"
CACHE_EXPIRED="true"
CACHE_AGE=""
case "$CACHE_UPDATED_AT" in
    ''|*[!0-9]*)
        CACHE_EXPIRED="true"
        ;;
    *)
        CACHE_AGE=$((NOW - CACHE_UPDATED_AT))
        if [ "$CACHE_AGE" -ge 0 ] && [ "$CACHE_AGE" -le "$CACHE_MAX_AGE" ]; then
            CACHE_EXPIRED="false"
        fi
        ;;
esac

if [ "$FORCE_UPDATE" = "false" ] \
    && [ "$CACHE_DIFF" = "true" ] \
    && [ "$CACHE_EXPIRED" = "false" ] \
    && [ "$PUBLIC_IP" = "$CACHED_IP" ]; then
    log "SKIP: public IP unchanged: $PUBLIC_IP"
    exit 0
fi

if [ "$FORCE_UPDATE" = "true" ]; then
    log "INFO: forced update requested with -f; public IP: $PUBLIC_IP"
elif [ "$CACHE_DIFF" = "false" ]; then
    log "INFO: cache comparison disabled; public IP: $PUBLIC_IP"
elif [ -z "$CACHED_IP" ]; then
    log "INFO: no valid cache; public IP: $PUBLIC_IP"
elif [ "$PUBLIC_IP" != "$CACHED_IP" ]; then
    log "INFO: public IP changed: $CACHED_IP -> $PUBLIC_IP"
elif [ -z "$CACHE_UPDATED_AT" ]; then
    log "INFO: cache timestamp missing; forcing update"
elif [ "$CACHE_EXPIRED" = "true" ]; then
    log "INFO: cache expired after ${CACHE_AGE:-unknown} seconds; forcing update"
else
    log "INFO: forcing update"
fi

if [ "$HTTP_CLIENT" = "curl" ]; then
    RESPONSE="$(curl -k -sS --connect-timeout 10 --max-time 20 "$API_URL" 2>&1)"
    STATUS=$?
else
    RESPONSE="$(wget --no-check-certificate -qO- -T 20 "$API_URL" 2>&1)"
    STATUS=$?
fi

if [ "$STATUS" -ne 0 ]; then
    log "ERROR: $RESPONSE"
    exit 1
fi

API_CURRENT_IP="$(printf '%s' "$RESPONSE" | tr -d '\r\n' | sed -n 's/.*"currentIp"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if ! is_ipv4 "$API_CURRENT_IP"; then
    log "ERROR: API response does not contain a valid currentIp: $RESPONSE"
    exit 1
fi

umask 077
CACHE_TMP="${CACHE_FILE}.$$"
CACHE_UPDATED_AT="$(date '+%s')"
if ! printf '%s\n%s\n' "$API_CURRENT_IP" "$CACHE_UPDATED_AT" > "$CACHE_TMP" \
    || ! mv -f "$CACHE_TMP" "$CACHE_FILE"; then
    rm -f "$CACHE_TMP"
    log "ERROR: failed to write cache file: $CACHE_FILE"
    exit 1
fi

log "OK: public IP $PUBLIC_IP; cached currentIp $API_CURRENT_IP at $CACHE_UPDATED_AT; response: $RESPONSE"
exit 0
