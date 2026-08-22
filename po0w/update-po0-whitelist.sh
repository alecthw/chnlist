#!/bin/sh

# */5 * * * * /root/update-po0-whitelist.sh > /root/update-po0-whitelist.log 2>&1

# One TOKEN/SLOT pair per line, in TOKEN@SLOT format.
TOKEN_SLOT_PAIRS='
token1@0
token2@1
'
CACHE_DIFF="true"
CACHE_MAX_AGE_HOURS=12
CACHE_FILE_DIR="/tmp/po0w"

API_HOST="https://124.221.69.228"
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

is_ipv4_cidr24() {
    case "$1" in
        */24) is_ipv4 "${1%/24}" ;;
        *) return 1 ;;
    esac
}

same_c_segment() {
    public_prefix="${1%.*}"
    network_ip="${2%/24}"
    network_prefix="${network_ip%.*}"
    [ "$public_prefix" = "$network_prefix" ]
}

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

if [ -z "$CACHE_FILE_DIR" ]; then
    log "ERROR: CACHE_FILE_DIR is empty"
    exit 1
fi

umask 077
if ! mkdir -p "$CACHE_FILE_DIR"; then
    log "ERROR: failed to create cache directory: $CACHE_FILE_DIR"
    exit 1
fi

if command -v curl >/dev/null 2>&1; then
    HTTP_CLIENT="curl"
elif command -v wget >/dev/null 2>&1; then
    HTTP_CLIENT="wget"
else
    log "ERROR: curl or wget not found"
    exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
    log "ERROR: sha256sum not found"
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

update_pair() {
    TOKEN="$1"
    SLOT="$2"

    if [ -z "$TOKEN" ]; then
        log "ERROR: TOKEN is empty"
        return 1
    fi

    case "$SLOT" in
        ''|*[!0-9]*)
            log "ERROR: SLOT must be a non-negative integer"
            return 1
            ;;
    esac

    TOKEN_HASH="$(printf '%s\n' "$TOKEN" | sha256sum)"
    TOKEN_HASH="${TOKEN_HASH%% *}"
    if [ -z "$TOKEN_HASH" ]; then
        log "ERROR: failed to hash TOKEN"
        return 1
    fi

    TOKEN_ID="$(printf '%.12s' "$TOKEN_HASH")"
    API_URL="${API_HOST}/api/firewall/${TOKEN}/add?slot=${SLOT}"
    CACHE_FILE="${CACHE_FILE_DIR}/${TOKEN_HASH}"

    CACHED_IP=""
    CACHE_UPDATED_AT=""
    if [ -f "$CACHE_FILE" ]; then
        CACHED_IP="$(sed -n '1p' "$CACHE_FILE")"
        CACHE_UPDATED_AT="$(sed -n '2p' "$CACHE_FILE")"
        if ! is_ipv4_cidr24 "$CACHED_IP"; then
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
        && same_c_segment "$PUBLIC_IP" "$CACHED_IP"; then
        log "SKIP: [slot=$SLOT token_id=$TOKEN_ID] public IP $PUBLIC_IP is already covered by $CACHED_IP"
        return 0
    fi

    if [ "$FORCE_UPDATE" = "true" ]; then
        log "INFO: [slot=$SLOT token_id=$TOKEN_ID] forced update requested with -f; public IP: $PUBLIC_IP"
    elif [ "$CACHE_DIFF" = "false" ]; then
        log "INFO: [slot=$SLOT token_id=$TOKEN_ID] cache comparison disabled; public IP: $PUBLIC_IP"
    elif [ -z "$CACHED_IP" ]; then
        log "INFO: [slot=$SLOT token_id=$TOKEN_ID] no valid cache; public IP: $PUBLIC_IP"
    elif ! same_c_segment "$PUBLIC_IP" "$CACHED_IP"; then
        log "INFO: [slot=$SLOT token_id=$TOKEN_ID] public IP $PUBLIC_IP is outside cached network $CACHED_IP"
    elif [ -z "$CACHE_UPDATED_AT" ]; then
        log "INFO: [slot=$SLOT token_id=$TOKEN_ID] cache timestamp missing; forcing update"
    elif [ "$CACHE_EXPIRED" = "true" ]; then
        log "INFO: [slot=$SLOT token_id=$TOKEN_ID] cache expired after ${CACHE_AGE:-unknown} seconds; forcing update"
    else
        log "INFO: [slot=$SLOT token_id=$TOKEN_ID] forcing update"
    fi

    if [ "$HTTP_CLIENT" = "curl" ]; then
        RESPONSE="$(curl -k -sS --connect-timeout 10 --max-time 20 "$API_URL" 2>&1)"
        STATUS=$?
    else
        RESPONSE="$(wget --no-check-certificate -qO- -T 20 "$API_URL" 2>&1)"
        STATUS=$?
    fi

    if [ "$STATUS" -ne 0 ]; then
        log "ERROR: [slot=$SLOT token_id=$TOKEN_ID] $RESPONSE"
        return 1
    fi

    API_CURRENT_IP="$(printf '%s' "$RESPONSE" | tr -d '\r\n' | sed -n 's/.*"currentIp"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | tr -d '\\')"
    if ! is_ipv4_cidr24 "$API_CURRENT_IP"; then
        log "ERROR: [slot=$SLOT token_id=$TOKEN_ID] API response does not contain a valid currentIp: $RESPONSE"
        return 1
    fi

    CACHE_TMP="${CACHE_FILE}.$"
    CACHE_UPDATED_AT="$(date '+%s')"
    if ! printf '%s\n%s\n' "$API_CURRENT_IP" "$CACHE_UPDATED_AT" > "$CACHE_TMP" \
        || ! mv -f "$CACHE_TMP" "$CACHE_FILE"; then
        rm -f "$CACHE_TMP"
        log "ERROR: [slot=$SLOT token_id=$TOKEN_ID] failed to write cache file: $CACHE_FILE"
        return 1
    fi

    log "OK: [slot=$SLOT token_id=$TOKEN_ID] public IP $PUBLIC_IP; cached currentIp $API_CURRENT_IP at $CACHE_UPDATED_AT; response: $RESPONSE"
    return 0
}

PAIR_COUNT=0
FAILED_COUNT=0
while IFS= read -r TOKEN_SLOT_PAIR; do
    if [ -z "$TOKEN_SLOT_PAIR" ]; then
        continue
    fi

    PAIR_COUNT=$((PAIR_COUNT + 1))
    case "$TOKEN_SLOT_PAIR" in
        *[[:space:]]*|*@*@*|@*|*@)
            log "ERROR: TOKEN_SLOT_PAIRS line $PAIR_COUNT must use TOKEN@SLOT format"
            FAILED_COUNT=$((FAILED_COUNT + 1))
            continue
            ;;
        *@*)
            TOKEN="${TOKEN_SLOT_PAIR%@*}"
            SLOT="${TOKEN_SLOT_PAIR#*@}"
            ;;
        *)
            log "ERROR: TOKEN_SLOT_PAIRS line $PAIR_COUNT must use TOKEN@SLOT format"
            FAILED_COUNT=$((FAILED_COUNT + 1))
            continue
            ;;
    esac

    if ! update_pair "$TOKEN" "$SLOT"; then
        FAILED_COUNT=$((FAILED_COUNT + 1))
    fi
done <<EOF
$TOKEN_SLOT_PAIRS
EOF

if [ "$PAIR_COUNT" -eq 0 ]; then
    log "ERROR: TOKEN_SLOT_PAIRS is empty"
    exit 1
fi

if [ "$FAILED_COUNT" -ne 0 ]; then
    log "ERROR: $FAILED_COUNT of $PAIR_COUNT TOKEN/SLOT pairs failed"
    exit 1
fi

log "OK: processed $PAIR_COUNT TOKEN/SLOT pairs"
exit 0
