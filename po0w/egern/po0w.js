// =============================================================
// Egern 原生 PO0 防火墙白名单脚本
//
// - network：网络变化时更新当前网络对应的 token 组
// - schedule：每 30 分钟定时更新
// - manual：手动强制更新，Wi-Fi 下忽略 skip_ssids
// - widget：只读取最近结果，不发起 API 请求
// =============================================================

const SCRIPT_NAME = 'PO0';
const DEFAULT_HOST = '124.221.69.228';
const REQUEST_TIMEOUT_MS = 10000;
const PUBLIC_IP_TIMEOUT_MS = 4000;
const DEFAULT_CACHE_MAX_AGE_HOURS = 6;
const PUBLIC_IP_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const STORE_PREFIX = 'po0w:firewall:egern';

export default async function(ctx) {
    const env = normalizeEnv(ctx && ctx.env);
    const mode = env.mode || (ctx && ctx.widgetFamily ? 'widget' : 'update');

    if (mode === 'widget') return runWidget(ctx, env);

    try {
        const cfg = buildConfig(env);
        const snapshot = await runUpdate(ctx, cfg, env);
        if (mode === 'manual') {
            notifyManualResult(ctx, snapshot);
            return renderWidget(ctx, snapshot);
        }
    } catch (error) {
        const snapshot = createFailureSnapshot(ctx, env, error);
        writeSnapshot(ctx, env, snapshot);
        log(ctx, `[${SCRIPT_NAME}] ${snapshot.note}`);
        if (mode === 'manual') {
            notifyManualResult(ctx, snapshot);
            return renderWidget(ctx, snapshot);
        }
    }
}

function runWidget(ctx, env) {
    try {
        buildConfig(env);
        const snapshot = readSnapshot(ctx, env) || createEmptySnapshot(ctx);
        return renderWidget(ctx, snapshot);
    } catch (error) {
        return renderWidget(ctx, createFailureSnapshot(ctx, env, error, 'widget'));
    }
}

async function runUpdate(ctx, cfg, env) {
    const network = getNetworkInfo(ctx);
    const skippedSSID = network.type === 'wifi' && cfg.skipSSIDs.includes(network.ssid);

    if (skippedSSID && cfg.trigger !== 'manual') {
        const snapshot = createSkippedSnapshot(ctx, env, network, cfg.trigger);
        writeSnapshot(ctx, env, snapshot);
        log(ctx, `[${SCRIPT_NAME}] ${network.label}：${snapshot.summary}${snapshot.note ? `，${snapshot.note}` : ''}`);
        return snapshot;
    }

    if (skippedSSID) {
        log(ctx, `[${SCRIPT_NAME}] 手动更新忽略 skip_ssids，强制更新 Wi-Fi tokens`);
    }

    const selected = network.type === 'wifi' ? cfg.wifiTokens : cfg.cellularTokens;
    const groupName = network.type === 'wifi'
        ? (network.ssid ? 'Wi-Fi' : '非蜂窝')
        : '蜂窝';
    const publicInfo = await getDirectInfo(ctx);

    if (!selected.length) {
        const snapshot = createSnapshot({
            status: 'success',
            summary: '未请求（未配置 Token）',
            style: 'info',
            network,
            trigger: cfg.trigger,
            note: '',
            publicInfo,
            results: []
        });
        writeSnapshot(ctx, env, snapshot);
        log(ctx, `[${SCRIPT_NAME}] ${network.label}：${snapshot.summary}`);
        return snapshot;
    }

    const forceRefresh = cfg.trigger === 'manual';
    const tokenCache = readTokenCache(ctx, env);
    const tasks = selected.map(function(item) {
        if (!item.valid) {
            return Promise.resolve(createRequestFailure(item, groupName, item.error, false));
        }
        const previous = findCachedRequestResult(tokenCache, item);
        const cacheExpired = Boolean(cfg.cacheDiffMode > 0 && !forceRefresh && previous &&
            isTokenCacheExpired(previous.updatedAt, cfg.cacheMaxAgeHours));
        const cacheMatched = Boolean(cfg.cacheDiffMode > 0 && !forceRefresh && publicInfo.ip &&
            previous && !cacheExpired && (cfg.cacheDiffMode === 1
                ? isSameIPAddress(publicInfo.ip, getWhitelistSlotIP(previous, item.slot))
                : hasWhitelistIPAddress(previous, publicInfo.ip)));
        if (cacheMatched) {
            const cacheStatus = cfg.cacheDiffMode === 1 ? 'IP 未变化' : 'IP 已存在';
            return Promise.resolve(createCachedMatchResult(item, groupName, previous, cacheStatus));
        }
        return requestWhitelist(ctx, env, cfg.host, item, groupName).then(function(result) {
            return markCacheExpiredResult(result, cacheExpired);
        });
    });
    const results = await Promise.all(tasks);
    updateTokenCacheFromResults(ctx, env, tokenCache, selected, results);
    const successCount = results.filter(function(result) { return result.success; }).length;
    const failureCount = results.length - successCount;
    const expiredCacheCount = results.filter(function(result) { return result.cacheExpired; }).length;
    let status = 'success';
    let summary = '成功';
    let style = 'good';
    const allCacheHits = results.length > 0 && results.every(function(result) { return result && result.cacheHit; });

    if (allCacheHits) {
        summary = cfg.cacheDiffMode === 1 ? '未请求（IP 未变化）' : '未请求（IP 已存在）';
        style = 'info';
    } else if (successCount === 0) {
        status = 'failure';
        summary = '失败';
        style = 'error';
    } else if (failureCount > 0) {
        status = 'partial';
        summary = '部分失败';
        style = 'alert';
    }

    const notes = [];
    if (expiredCacheCount) notes.push(`${expiredCacheCount} 项缓存过期`);

    const snapshot = createSnapshot({
        status,
        summary,
        style,
        network,
        trigger: cfg.trigger,
        note: notes.join('；'),
        publicInfo,
        results
    });
    writeSnapshot(ctx, env, snapshot);
    log(ctx, `[${SCRIPT_NAME}] ${network.label}：${summary}${snapshot.note ? `，${snapshot.note}` : ''}`);
    return snapshot;
}

// ============================================================
// 参数与网络环境
// ============================================================

function normalizeEnv(value) {
    const env = value && typeof value === 'object' ? value : {};
    return {
        mode: String(env.mode || ''),
        trigger: String(env.trigger || ''),
        host: String(env.host || ''),
        cellular_tokens: String(env.cellular_tokens || ''),
        wifi_tokens: String(env.wifi_tokens || ''),
        skip_ssids: String(env.skip_ssids || ''),
        cache_diff: String(env.cache_diff === null || typeof env.cache_diff === 'undefined' ? '' : env.cache_diff),
        cache_max_age_hours: String(env.cache_max_age_hours === null || typeof env.cache_max_age_hours === 'undefined'
            ? ''
            : env.cache_max_age_hours)
    };
}

function buildConfig(env) {
    const cellularTokens = parseTokenList(env.cellular_tokens, 'cellular');
    const wifiTokens = parseTokenList(env.wifi_tokens, 'wifi');
    if (!cellularTokens.length && !wifiTokens.length) {
        throw new Error('cellular_tokens 和 wifi_tokens 不能全空');
    }

    return {
        host: normalizeHost(env.host || DEFAULT_HOST),
        cellularTokens,
        wifiTokens,
        skipSSIDs: parseList(env.skip_ssids),
        cacheDiffMode: parseCacheDiffMode(env.cache_diff),
        cacheMaxAgeHours: parsePositiveNumberArg(env.cache_max_age_hours, DEFAULT_CACHE_MAX_AGE_HOURS),
        trigger: normalizeTrigger(env.trigger, env.mode)
    };
}

function parseCacheDiffMode(value) {
    const text = cleanText(value);
    if (!text) return 0;
    if (text === '0' || text === '1' || text === '2') return Number(text);
    throw new Error('cache_diff 必须是 0、1 或 2');
}

function parsePositiveNumberArg(value, defaultValue) {
    const text = cleanText(value);
    if (!text) return Number(defaultValue);
    const number = Number(text);
    if (!Number.isFinite(number) || number <= 0) {
        throw new Error('cache_max_age_hours 必须是大于 0 的数字');
    }
    return number;
}

function normalizeTrigger(trigger, mode) {
    if (trigger === 'schedule') return 'schedule';
    if (trigger === 'manual' || mode === 'manual') return 'manual';
    if (trigger === 'widget' || mode === 'widget') return 'widget';
    return 'network';
}

function normalizeHost(value) {
    let host = String(value || '').trim();
    host = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!host || /[\/?#@]/.test(host)) {
        throw new Error('host 必须是 IP 地址或域名，可包含端口但不能包含路径');
    }

    const colonCount = (host.match(/:/g) || []).length;
    if (colonCount > 1 && host.charAt(0) !== '[') host = `[${host}]`;
    return host;
}

function parseTokenList(value, type) {
    if (!value) return [];

    return String(value).split('|').map(function(part) {
        return part.trim();
    }).filter(Boolean).map(function(part, index) {
        const separator = part.lastIndexOf('@');
        const token = separator >= 0 ? part.substring(0, separator).trim() : '';
        const slot = separator >= 0 ? part.substring(separator + 1).trim() : '';
        const valid = Boolean(token) && /^\d+$/.test(slot);
        return {
            type,
            index: index + 1,
            token,
            slot: slot || '?',
            valid,
            error: valid ? '' : '格式错误，应为 token@slot_id，且 slot_id 为非负整数'
        };
    });
}

function parseList(value) {
    if (!value) return [];
    return String(value).split('|').map(function(item) {
        return item.trim();
    }).filter(Boolean);
}

function getNetworkInfo(ctx) {
    const device = ctx && ctx.device ? ctx.device : {};
    const wifi = device.wifi || {};
    const ssid = wifi.ssid === null || typeof wifi.ssid === 'undefined' ? '' : String(wifi.ssid);
    const ipv4Interface = device.ipv4 && device.ipv4.interface ? String(device.ipv4.interface) : '';
    const ipv6Interface = device.ipv6 && device.ipv6.interface ? String(device.ipv6.interface) : '';
    const interfaceNames = [];
    [ipv4Interface, ipv6Interface].forEach(function(value) {
        const name = String(value || '').trim();
        if (name && !interfaceNames.includes(name)) interfaceNames.push(name);
    });
    const hasCellular = interfaceNames.length > 0 && interfaceNames.every(function(name) {
        return /^pdp_ip\d+$/i.test(name);
    });
    if (hasCellular) {
        return { type: 'cellular', ssid: '', interfaces: interfaceNames, label: '蜂窝网络' };
    }

    const normalizedSSID = ssid.trim();
    return {
        type: 'wifi',
        ssid: normalizedSSID,
        interfaces: interfaceNames,
        label: normalizedSSID
            ? `Wi-Fi（${normalizedSSID}）`
            : (interfaceNames.length
                ? `非蜂窝（${interfaceNames.join(' / ')}）`
                : '非蜂窝')
    };
}

// ============================================================
// DIRECT 公网 IP 与运营商查询
// ============================================================

async function getDirectInfo(ctx) {
    const providers = [
        { name: '126', url: 'https://ipservice.ws.126.net/locate/api/getLocByIp', parse: parse126PublicInfo },
        { name: 'BILI', url: 'https://api.bilibili.com/x/web-interface/zone', parse: parseBilibiliPublicInfo },
        { name: 'IPIP', url: 'https://myip.ipip.net/json', parse: parseIPIPPublicInfo }
    ];
    const errors = [];

    for (let index = 0; index < providers.length; index++) {
        const provider = providers[index];
        try {
            const data = await requestPublicInfo(ctx, provider.url);
            const parsed = provider.parse(data);
            if (!parsed || !isValidIPAddress(parsed.ip)) throw new Error('响应中缺少有效公网 IP');
            const info = createPublicInfo(Object.assign({}, parsed, { provider: provider.name }));
            log(ctx, `[${SCRIPT_NAME}] 公网 IP: ${info.ip}（${info.provider}），运营商: ${info.carrier || '-'}`);
            return info;
        } catch (error) {
            const message = getErrorMessage(error);
            errors.push(`${provider.name}: ${message}`);
            log(ctx, `[${SCRIPT_NAME}] ${provider.name} 公网 IP 查询失败: ${message}`);
        }
    }
    return createPublicInfo({ error: errors.join('；') || '公网 IP 查询失败' });
}

async function requestPublicInfo(ctx, url) {
    const response = await ctx.http.get(url, {
        headers: { Accept: 'application/json', 'User-Agent': PUBLIC_IP_USER_AGENT },
        timeout: PUBLIC_IP_TIMEOUT_MS,
        policy: 'DIRECT',
        redirect: 'error',
        credentials: 'omit',
        insecureTls: false
    });
    const status = response ? Number(response.status || 0) : 0;
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status || '未知状态'}`);
    const body = response ? await response.text() : '';
    const parsed = parseResponseJSON(body);
    if (!parsed.ok) throw new Error('响应不是有效 JSON');
    return parsed.data;
}

function parse126PublicInfo(body) {
    const result = body && typeof body === 'object' ? body.result || {} : {};
    return { ip: result.ip, country: result.country, province: result.province, city: result.city, isp: result.operator || result.company };
}

function parseBilibiliPublicInfo(body) {
    const data = body && typeof body === 'object' ? body.data || {} : {};
    return { ip: data.addr, country: data.country, province: data.province, city: data.city, isp: data.isp };
}

function parseIPIPPublicInfo(body) {
    const data = body && typeof body === 'object' ? body.data || {} : {};
    const location = Array.isArray(data.location) ? data.location : [];
    return { ip: data.ip, country: location[0], province: location[1], city: location[2], isp: location[4] };
}

function createPublicInfo(options) {
    const value = options || {};
    const province = normalizeLocationPart(value.province);
    const city = normalizeLocationPart(value.city);
    const isp = normalizeISP(value.isp);
    return {
        ip: cleanText(value.ip),
        provider: cleanText(value.provider),
        country: cleanText(value.country),
        province,
        city,
        isp,
        carrier: formatCarrierLabel(province, city, isp),
        error: cleanText(value.error)
    };
}

function formatCarrierLabel(province, city, isp) {
    const normalizedProvince = normalizeLocationPart(province);
    const normalizedCity = normalizeLocationPart(city);
    const normalizedISP = normalizeISP(isp);
    let location = normalizedProvince;
    if (normalizedCity && normalizedCity !== normalizedProvince) location += normalizedCity;
    else if (!location) location = normalizedCity;
    if (location && normalizedISP) return `${location}${normalizedISP}`;
    if (normalizedISP) return normalizedISP;
    if (location) return `${location}（运营商未知）`;
    return '-';
}

function normalizeLocationPart(value) {
    return cleanText(value).replace(/^中国/, '').replace(/\s+/g, '')
        .replace(/(?:壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市)$/, '');
}

function normalizeISP(value) {
    const text = cleanText(value).replace(/\s+/g, '');
    if (!text) return '';
    if (/联通|unicom/i.test(text)) return '联通';
    if (/电信|telecom|chinanet/i.test(text)) return '电信';
    if (/移动|cmcc|china.?mobile/i.test(text)) return '移动';
    if (/广电|broadcast/i.test(text)) return '广电';
    if (/铁通|tietong/i.test(text)) return '铁通';
    if (/教育网|cernet/i.test(text)) return '教育网';
    return text.replace(/^中国/, '');
}

function cleanText(value) {
    return value === null || typeof value === 'undefined' ? '' : String(value).trim();
}

function isValidIPAddress(value) {
    const text = cleanText(value);
    if (!text) return false;
    if (text.includes(':')) return /^[0-9a-f:]+$/i.test(text);
    const parts = text.split('.');
    return parts.length === 4 && parts.every(function(part) {
        return /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255;
    });
}

function isValidWhitelistCIDR(value) {
    const text = cleanText(value);
    if (!text.endsWith('/24')) return false;
    const networkIP = text.substring(0, text.length - 3);
    return networkIP.split('.').length === 4 && isValidIPAddress(networkIP);
}

// ============================================================
// API 请求
// ============================================================

async function requestWhitelist(ctx, env, host, item, groupName) {
    const url = `https://${host}/api/firewall/${encodeURIComponent(item.token)}/add?slot=${encodeURIComponent(item.slot)}`;

    try {
        const response = await ctx.http.get(url, {
            headers: { Accept: 'application/json' },
            timeout: REQUEST_TIMEOUT_MS,
            policy: 'DIRECT',
            redirect: 'error',
            credentials: 'omit',
            insecureTls: false
        });
        const status = response ? Number(response.status || 0) : 0;
        const body = response ? await response.text() : '';
        const parsed = parseResponseJSON(body);
        const data = parsed.data;

        if (isAlreadyPinnedResponse(data)) {
            return createAlreadyPinnedResult(ctx, env, item, groupName);
        }

        if (status < 200 || status >= 300) {
            const responseMessage = data && (data.message || data.error);
            const detail = responseMessage
                ? `: ${sanitizeRequestError(formatServerError(responseMessage), item.token)}`
                : '';
            return createRequestFailure(item, groupName, `HTTP ${status || '未知状态'}${detail}`);
        }

        if (!parsed.ok) {
            return createRequestFailure(item, groupName, 'API 响应不是有效 JSON');
        }
        return createRequestResult(item, groupName, data);
    } catch (error) {
        return createRequestFailure(item, groupName, sanitizeRequestError(error, item.token));
    }
}

function parseResponseJSON(body) {
    try {
        return { ok: true, data: JSON.parse(String(body || '')) };
    } catch (error) {
        return { ok: false, data: null };
    }
}

function createRequestResult(item, groupName, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return createRequestFailure(item, groupName, 'API 响应格式错误');
    }

    const hasCurrentIP = typeof data.currentIp === 'string' && data.currentIp.trim() !== '';
    const hasWhitelist = Array.isArray(data.whitelist);
    const whitelist = hasWhitelist ? normalizeWhitelist(data.whitelist) : [];
    let error = '';

    if (data.tokenAvailable === false) {
        error = 'token 不可用';
    } else if (Number(data.code) >= 400) {
        error = sanitizeRequestError(
            formatServerError(data.message || data.error || `API 错误 ${data.code}`),
            item.token
        );
    } else if (data.success === false) {
        error = sanitizeRequestError(
            formatServerError(data.message || data.error || 'API 返回失败'),
            item.token
        );
    } else if (data.error) {
        error = sanitizeRequestError(formatServerError(data.error), item.token);
    } else if (!hasCurrentIP || !hasWhitelist) {
        error = 'API 响应缺少 currentIp 或 whitelist';
    }

    return {
        label: formatRequestLabel(groupName, item),
        tokenKey: getTokenKey(item.token),
        slot: item.slot,
        success: !error,
        apiRequested: true,
        cacheHit: false,
        cacheComparable: !error,
        whitelistReceived: hasWhitelist,
        error,
        currentIp: hasCurrentIP ? data.currentIp.trim() : '-',
        whitelist
    };
}

function isAlreadyPinnedResponse(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const message = String(data.message || '').trim();
    return Number(data.code) === 403 && /^IP is already pinned to another slot\.?$/i.test(message);
}

function createAlreadyPinnedResult(ctx, env, item, groupName) {
    const label = formatRequestLabel(groupName, item);
    const strictPrevious = findCachedRequestResult(readTokenCache(ctx, env), item);
    const snapshot = readSnapshot(ctx, env);
    const previous = strictPrevious || findPreviousRequestResultInSnapshot(snapshot, env, item, label, true);
    const hasPreviousData = hasUsableRequestData(previous);

    return {
        label,
        tokenKey: getTokenKey(item.token),
        slot: item.slot,
        success: true,
        apiRequested: true,
        cacheHit: false,
        cacheComparable: Boolean(strictPrevious),
        whitelistReceived: false,
        statusText: 'IP 已在其他 slot',
        detail: hasPreviousData
            ? 'IP 已在其他 slot，沿用上次数据'
            : 'IP 已在其他 slot，暂无白名单数据',
        error: '',
        currentIp: hasPreviousData && previous.currentIp ? previous.currentIp : '-',
        whitelist: hasPreviousData && Array.isArray(previous.whitelist) ? previous.whitelist : []
    };
}

function createCachedMatchResult(item, groupName, previous, statusText) {
    return {
        label: formatRequestLabel(groupName, item),
        tokenKey: getTokenKey(item.token),
        slot: item.slot,
        success: true,
        apiRequested: false,
        cacheHit: true,
        cacheComparable: true,
        whitelistReceived: false,
        statusText: statusText || 'IP 未变化',
        detail: '',
        error: '',
        currentIp: previous && previous.currentIp ? previous.currentIp : '-',
        whitelist: previous && Array.isArray(previous.whitelist) ? previous.whitelist : []
    };
}

function findCachedRequestResult(cache, item) {
    const entries = cache && cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
    const tokenKey = getTokenKey(item.token);
    const entry = entries[tokenKey];
    if (!entry || !isValidWhitelistCIDR(entry.ip)) return null;
    return {
        tokenKey,
        currentIp: entry.currentIp || '-',
        whitelist: Array.isArray(entry.whitelist) && entry.whitelist.length
            ? normalizeWhitelist(entry.whitelist)
            : [{ slot: String(entry.slot || item.slot), ip: String(entry.ip) }],
        cacheComparable: true,
        updatedAt: Number(entry.updatedAt || 0)
    };
}

function findPreviousRequestResultInSnapshot(snapshot, env, item, label, allowFallback) {
    if (!snapshot) return null;

    const usableResults = (Array.isArray(snapshot.results) ? snapshot.results : []).filter(hasUsableRequestData);
    const exact = usableResults.find(function(result) {
        return result.label === label;
    });
    if (exact) return exact;

    const tokenKey = getTokenKey(item.token);
    const sameTokenKey = usableResults.find(function(result) {
        return result.tokenKey && result.tokenKey === tokenKey;
    });
    if (sameTokenKey) return sameTokenKey;

    const equivalentLabels = getEquivalentRequestLabels(env, item.token);
    const sameToken = usableResults.find(function(result) {
        return equivalentLabels.includes(result.label);
    });
    return sameToken || (allowFallback ? usableResults[0] : null) || null;
}

function getEquivalentRequestLabels(env, token) {
    const labels = [];
    [
        { value: env.cellular_tokens, type: 'cellular', groupNames: ['蜂窝'] },
        { value: env.wifi_tokens, type: 'wifi', groupNames: ['Wi-Fi', '非蜂窝'] }
    ].forEach(function(group) {
        parseTokenList(group.value, group.type).forEach(function(item) {
            if (item.valid && item.token === token) {
                group.groupNames.forEach(function(groupName) {
                    labels.push(formatRequestLabel(groupName, item));
                });
            }
        });
    });
    return labels;
}

function hasUsableRequestData(result) {
    return Boolean(result) && (
        (result.currentIp && result.currentIp !== '-') ||
        (Array.isArray(result.whitelist) && result.whitelist.length > 0)
    );
}

function getWhitelistSlotIP(result, slot) {
    if (!result || !Array.isArray(result.whitelist)) return '';
    const targetSlot = String(slot);
    const entry = result.whitelist.find(function(value) {
        return value && String(value.slot) === targetSlot;
    });
    return entry && entry.ip ? String(entry.ip).trim() : '';
}

function hasWhitelistIPAddress(result, address) {
    return Boolean(result && Array.isArray(result.whitelist)) && result.whitelist.some(function(entry) {
        return entry && isSameIPAddress(address, entry.ip);
    });
}

function isSameIPAddress(left, right) {
    const publicIP = cleanText(left);
    const cachedCIDR = cleanText(right);
    if (publicIP.split('.').length !== 4 || !isValidIPAddress(publicIP) || !isValidWhitelistCIDR(cachedCIDR)) {
        return false;
    }
    const networkIP = cachedCIDR.substring(0, cachedCIDR.length - 3);
    return publicIP.split('.').slice(0, 3).join('.') === networkIP.split('.').slice(0, 3).join('.');
}

function isTokenCacheExpired(updatedAt, maxAgeHours) {
    const timestamp = Number(updatedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return true;
    const age = Date.now() - timestamp;
    return age < 0 || age > Number(maxAgeHours) * 60 * 60 * 1000;
}

function markCacheExpiredResult(result, expired) {
    if (!expired || !result) return result;
    result.cacheExpired = true;
    return result;
}

function createRequestFailure(item, groupName, error, apiRequested) {
    return {
        label: formatRequestLabel(groupName, item),
        tokenKey: getTokenKey(item.token),
        slot: item.slot,
        success: false,
        apiRequested: apiRequested !== false,
        cacheHit: false,
        cacheComparable: false,
        whitelistReceived: false,
        error: getErrorMessage(error),
        currentIp: '-',
        whitelist: []
    };
}

function formatRequestLabel(groupName, item) {
    return `${groupName} #${item.index}（slot ${item.slot}）`;
}

function normalizeWhitelist(whitelist) {
    return whitelist.map(function(entry) {
        const value = entry && typeof entry === 'object' ? entry : {};
        return {
            slot: value.slot === null || typeof value.slot === 'undefined' ? '?' : String(value.slot),
            ip: value.ip === null || typeof value.ip === 'undefined' || value.ip === '' ? '-' : String(value.ip)
        };
    }).sort(function(left, right) {
        const leftSlot = Number(left.slot);
        const rightSlot = Number(right.slot);
        if (Number.isFinite(leftSlot) && Number.isFinite(rightSlot)) return leftSlot - rightSlot;
        return String(left.slot).localeCompare(String(right.slot));
    });
}

function sanitizeRequestError(error, token) {
    let message = getErrorMessage(error);
    if (token) {
        const secrets = Array.from(new Set([
            String(token),
            encodeURIComponent(String(token))
        ])).filter(Boolean).sort(function(left, right) {
            return right.length - left.length;
        });
        secrets.forEach(function(secret) {
            message = message.split(secret).join('***');
        });
    }
    return message.length > 200 ? `${message.substring(0, 197)}...` : message;
}

function sanitizeAllTokens(error, env) {
    let message = getErrorMessage(error);
    parseTokenList(env.cellular_tokens, 'cellular')
        .concat(parseTokenList(env.wifi_tokens, 'wifi'))
        .forEach(function(item) {
            message = sanitizeRequestError(message, item.token);
        });
    return message;
}

function formatServerError(value) {
    let text;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch (error) {
            text = String(value);
        }
    }
    text = String(text || 'API 返回失败').replace(/\s+/g, ' ').trim();
    return text.length > 200 ? `${text.substring(0, 197)}...` : text;
}

// ============================================================
// 持久化
// ============================================================

function createSnapshot(options) {
    return {
        version: 2,
        status: options.status,
        summary: options.summary,
        style: options.style,
        network: options.network,
        trigger: options.trigger,
        note: options.note || '',
        publicInfo: options.publicInfo || createPublicInfo({}),
        results: options.results || [],
        updatedAt: Date.now()
    };
}

function createEmptySnapshot(ctx) {
    return {
        version: 2,
        status: 'empty',
        summary: '暂无',
        style: 'info',
        network: getNetworkInfo(ctx),
        trigger: 'widget',
        note: '运行“PO0 手动更新”，或等待网络变化和定时任务',
        publicInfo: createPublicInfo({}),
        results: [],
        updatedAt: 0
    };
}

function createSkippedSnapshot(ctx, env, network, trigger) {
    const previous = readSnapshot(ctx, env);
    const previousResults = previous && Array.isArray(previous.results) ? previous.results : [];
    if (!previousResults.length) {
        return createSnapshot({
            status: 'success',
            summary: '已跳过（命中 skip_ssids）',
            style: 'info',
            network,
            trigger,
            note: '暂无历史结果',
            results: []
        });
    }

    return {
        version: 2,
        status: 'success',
        summary: '已跳过（命中 skip_ssids）',
        style: 'info',
        network,
        trigger,
        note: '',
        publicInfo: previous.publicInfo || createPublicInfo({}),
        results: copyRequestResults(previousResults),
        updatedAt: Number(previous.updatedAt || 0)
    };
}

function createFailureSnapshot(ctx, env, error, trigger) {
    return createSnapshot({
        status: 'failure',
        summary: '失败',
        style: 'error',
        network: getNetworkInfo(ctx),
        trigger: trigger || normalizeTrigger(env.trigger, env.mode),
        note: `参数或运行错误: ${sanitizeAllTokens(error, env)}`,
        results: []
    });
}

function readSnapshot(ctx, env) {
    return normalizeSnapshotForRead(readStoredJSON(ctx, getStoreKey(env, 'snapshot')));
}

function writeSnapshot(ctx, env, snapshot) {
    try {
        mergeSnapshotResultsWithPrevious(snapshot, readSnapshot(ctx, env));
        return writeStoredJSON(ctx, getStoreKey(env, 'snapshot'), sanitizeSnapshotForStorage(snapshot));
    } catch (error) {
        log(ctx, `[${SCRIPT_NAME}] 保存状态失败: ${getErrorMessage(error)}`);
    }
    return false;
}

function mergeSnapshotResultsWithPrevious(snapshot, previous) {
    const previousResults = previous && Array.isArray(previous.results) ? previous.results : [];
    if (!previousResults.length) return snapshot;
    const currentResults = snapshot && Array.isArray(snapshot.results) ? snapshot.results : [];
    if (!currentResults.length) {
        snapshot.results = copyRequestResults(previousResults);
        snapshot.note = appendFallbackNote(snapshot.note);
        return snapshot;
    }
    snapshot.results = currentResults.map(function(result) {
        if (result && result.success && result.apiRequested && result.whitelistReceived === true) return result;
        const tokenKey = result && result.tokenKey ? String(result.tokenKey) : '';
        const previousResult = previousResults.find(function(candidate) {
            const candidateKey = candidate && candidate.tokenKey ? String(candidate.tokenKey) : '';
            if (tokenKey && candidateKey) return tokenKey === candidateKey;
            return candidate && result && candidate.label === result.label;
        });
        if (!previousResult) return result;
        return Object.assign({}, result, {
            detail: appendFallbackDetail(result),
            currentIp: previousResult.currentIp || '-',
            whitelist: Array.isArray(previousResult.whitelist) ? normalizeWhitelist(previousResult.whitelist) : []
        });
    });
    return snapshot;
}

function appendFallbackDetail(result) {
    if (result && result.cacheHit) return result.detail ? String(result.detail) : '';
    if (result && (result.statusText === '已存在' || result.statusText === 'IP 已在其他 slot') && result.detail) {
        return String(result.detail);
    }
    return '沿用上次数据';
}

function appendFallbackNote(note) {
    const items = String(note || '').split('；').map(function(item) { return item.trim(); }).filter(Boolean);
    if (!items.some(function(item) { return item.includes('沿用'); })) items.push('沿用上次数据');
    return Array.from(new Set(items)).join('；');
}

function normalizeSnapshotForRead(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const currentResults = Array.isArray(snapshot.results) ? snapshot.results : [];
    const legacyResults = Array.isArray(snapshot.lastRequestResults) ? snapshot.lastRequestResults : [];
    const useLegacyResults = !currentResults.length && legacyResults.length > 0;
    return {
        version: 2,
        status: snapshot.status,
        summary: snapshot.summary,
        style: snapshot.style,
        network: snapshot.network,
        trigger: snapshot.trigger,
        note: snapshot.note || '',
        publicInfo: snapshot.publicInfo || createPublicInfo({}),
        results: copyRequestResults(useLegacyResults ? legacyResults : currentResults),
        updatedAt: Number(useLegacyResults
            ? (snapshot.lastRequestUpdatedAt || snapshot.updatedAt || 0)
            : (snapshot.updatedAt || 0))
    };
}

function sanitizeSnapshotForStorage(snapshot) {
    const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return {
        version: 2,
        status: value.status,
        summary: value.summary,
        style: value.style,
        network: value.network,
        trigger: value.trigger,
        note: value.note || '',
        publicInfo: value.publicInfo || createPublicInfo({}),
        results: copyRequestResults(value.results),
        updatedAt: Number(value.updatedAt || 0)
    };
}

function copyRequestResults(results) {
    return (Array.isArray(results) ? results : []).map(function(result) {
        return {
            label: result && result.label ? String(result.label) : '',
            tokenKey: result && result.tokenKey ? String(result.tokenKey) : '',
            slot: result && result.slot !== null && typeof result.slot !== 'undefined' ? String(result.slot) : '?',
            success: Boolean(result && result.success),
            apiRequested: Boolean(result && result.apiRequested),
            cacheHit: Boolean(result && result.cacheHit),
            cacheComparable: result && result.cacheComparable !== false,
            whitelistReceived: Boolean(result && result.whitelistReceived),
            statusText: result && result.statusText ? String(result.statusText) : '',
            detail: result && result.detail ? String(result.detail) : '',
            error: result && result.error ? String(result.error) : '',
            currentIp: result && result.currentIp ? String(result.currentIp) : '-',
            whitelist: result && Array.isArray(result.whitelist)
                ? result.whitelist.map(function(entry) {
                    return {
                        slot: entry && entry.slot !== null && typeof entry.slot !== 'undefined' ? String(entry.slot) : '?',
                        ip: entry && entry.ip ? String(entry.ip) : '-'
                    };
                })
                : []
        };
    });
}

function getTokenKey(token) {
    return token ? hashString(`token:${String(token)}`) : '';
}

function readTokenCache(ctx, env) {
    const stored = readStoredJSON(ctx, getStoreKey(env, 'token-cache'));
    if (stored && stored.entries && typeof stored.entries === 'object') {
        return { version: 2, entries: stored.entries };
    }

    const migrated = migrateLegacyTokenCache(readStoredJSON(ctx, getStoreKey(env, 'snapshot')));
    if (Object.keys(migrated.entries).length) writeTokenCache(ctx, env, migrated);
    return migrated;
}

function writeTokenCache(ctx, env, cache) {
    try {
        const saved = writeStoredJSON(ctx, getStoreKey(env, 'token-cache'), {
            version: 2,
            entries: cache && cache.entries && typeof cache.entries === 'object' ? cache.entries : {}
        });
        if (!saved) log(ctx, `[${SCRIPT_NAME}] 保存 token 缓存失败`);
        return saved;
    } catch (error) {
        log(ctx, `[${SCRIPT_NAME}] 保存 token 缓存失败: ${getErrorMessage(error)}`);
        return false;
    }
}

function updateTokenCacheFromResults(ctx, env, cache, items, results) {
    const value = cache && typeof cache === 'object' ? cache : { version: 2, entries: {} };
    value.version = 2;
    if (!value.entries || typeof value.entries !== 'object') value.entries = {};
    let changed = false;

    items.forEach(function(item, index) {
        const result = results[index];
        if (!item || !item.valid || !result || !result.success || result.apiRequested !== true ||
            result.cacheComparable === false || result.whitelistReceived !== true) return;
        const slotIP = getWhitelistSlotIP(result, item.slot);
        if (!isValidWhitelistCIDR(slotIP)) return;
        const key = getTokenKey(item.token);
        if (result.cacheHit && value.entries[key]) return;
        value.entries[key] = {
            slot: String(item.slot),
            ip: slotIP,
            currentIp: result.currentIp || '-',
            whitelist: Array.isArray(result.whitelist) ? normalizeWhitelist(result.whitelist) : [],
            updatedAt: Date.now()
        };
        changed = true;
    });

    if (changed) writeTokenCache(ctx, env, value);
}

function migrateLegacyTokenCache(snapshot) {
    const cache = { version: 2, entries: {} };
    if (!snapshot || typeof snapshot !== 'object') return cache;
    const current = Array.isArray(snapshot.results) ? snapshot.results : [];
    const history = Array.isArray(snapshot.lastUsableResults) ? snapshot.lastUsableResults : [];
    current.concat(history).forEach(function(result) {
        if (!result || !result.success || result.apiRequested !== true || result.whitelistReceived !== true ||
            result.cacheComparable === false || !hasUsableRequestData(result)) return;
        const key = result.tokenKey ? String(result.tokenKey) : '';
        if (!key || cache.entries[key]) return;
        const slot = result.slot === null || typeof result.slot === 'undefined' ? '?' : String(result.slot);
        const slotIP = getWhitelistSlotIP(result, slot);
        if (!isValidWhitelistCIDR(slotIP)) return;
        cache.entries[key] = {
            slot,
            ip: slotIP,
            currentIp: result.currentIp || '-',
            whitelist: Array.isArray(result.whitelist) ? normalizeWhitelist(result.whitelist) : [],
            updatedAt: Number(snapshot.updatedAt || Date.now())
        };
    });
    return cache;
}

function readStoredJSON(ctx, key) {
    try {
        if (ctx.storage && typeof ctx.storage.getJSON === 'function') {
            const value = ctx.storage.getJSON(key);
            return value && typeof value === 'object' ? value : null;
        }
        const raw = ctx.storage && typeof ctx.storage.get === 'function' ? ctx.storage.get(key) : null;
        if (!raw) return null;
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return value && typeof value === 'object' ? value : null;
    } catch (error) {
        return null;
    }
}

function writeStoredJSON(ctx, key, value) {
    if (ctx.storage && typeof ctx.storage.setJSON === 'function') {
        ctx.storage.setJSON(key, value);
        return true;
    }
    if (ctx.storage && typeof ctx.storage.set === 'function') {
        ctx.storage.set(key, JSON.stringify(value));
        return true;
    }
    return false;
}

function getStoreKey(env, suffix) {
    const scope = [
        env.host || DEFAULT_HOST,
        env.cellular_tokens || '',
        env.wifi_tokens || '',
        env.skip_ssids || ''
    ].join('|');
    return `${STORE_PREFIX}:${hashString(scope)}:${suffix || 'snapshot'}`;
}

function hashString(value) {
    let hash = 0;
    const text = String(value || '');
    for (let index = 0; index < text.length; index++) {
        hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return (hash >>> 0).toString(36);
}

// ============================================================
// Widget 与通知
// ============================================================

function renderWidget(ctx, snapshot) {
    const style = snapshot.style || 'info';
    const color = style === 'good'
        ? '#2D6A4F'
        : (style === 'alert' ? '#9A6700' : (style === 'error' ? '#9D2A2A' : '#2B5C8A'));
    const title = `PO0 防火墙白名单 · ${snapshot.summary || '失败'}`;
    const content = formatWidgetContent(snapshot);

    return {
        type: 'widget',
        backgroundColor: color,
        padding: 16,
        gap: 8,
        children: [
            {
                type: 'text',
                text: title,
                font: { size: 'headline', weight: 'semibold' },
                textColor: '#FFFFFF'
            },
            {
                type: 'text',
                text: content,
                font: { size: 'caption2' },
                textColor: '#FFFFFFDD'
            }
        ]
    };
}

function formatWidgetContent(snapshot) {
    const publicInfo = snapshot.publicInfo && typeof snapshot.publicInfo === 'object' ? snapshot.publicInfo : {};
    const publicIP = publicInfo.ip
        ? `${publicInfo.ip}${publicInfo.provider ? `（${publicInfo.provider}）` : ''}`
        : (publicInfo.error ? '查询失败' : '-');
    const carrier = publicInfo.carrier && publicInfo.carrier !== '-' ? publicInfo.carrier : '-';
    const publicIPWithCarrier = carrier !== '-' ? `${publicIP} ${carrier}` : publicIP;
    const displayMeta = buildDisplayMeta(snapshot);
    const lines = [
        `API 请求结果: ${snapshot.summary || '失败'}`,
        `当前网络环境: ${snapshot.network && snapshot.network.label ? snapshot.network.label : '未知'}`,
        `公网 IP: ${publicIPWithCarrier}`,
        `触发方式: ${formatTrigger(snapshot.trigger)}`,
        `更新时间: ${formatDate(snapshot.updatedAt)}`
    ];

    if (displayMeta.note) lines.push(`说明: ${displayMeta.note}`);

    (snapshot.results || []).forEach(function(result) {
        lines.push('');
        lines.push(`【${result.label}】`);
        if (result.detail && !displayMeta.hiddenDetails[result.detail]) lines.push(`说明: ${result.detail}`);
        if (result.error) lines.push(`错误: ${result.error}`);
        lines.push(`当前 IP: ${result.currentIp || '-'}`);
        lines.push('白名单:');
        if (result.whitelist && result.whitelist.length) {
            result.whitelist.forEach(function(entry) {
                lines.push(`  ${entry.slot}: ${entry.ip}`);
            });
        } else {
            lines.push('  （空）');
        }
    });
    return lines.join('\n');
}

function buildDisplayMeta(snapshot) {
    const noteItems = String(snapshot && snapshot.note || '')
        .split('；')
        .map(function(item) { return item.trim(); })
        .filter(Boolean);
    const detailCounts = Object.create(null);
    const hiddenDetails = Object.create(null);

    (snapshot && Array.isArray(snapshot.results) ? snapshot.results : []).forEach(function(result) {
        const detail = result && result.detail ? String(result.detail).trim() : '';
        if (detail) detailCounts[detail] = (detailCounts[detail] || 0) + 1;
    });

    Object.keys(detailCounts).forEach(function(detail) {
        const coveredByNote = noteItems.some(function(note) {
            return note === detail || note.includes(detail) || detail.includes(note);
        });
        if (coveredByNote) {
            hiddenDetails[detail] = true;
        } else if (detailCounts[detail] > 1) {
            noteItems.push(`${detail}（${detailCounts[detail]} 项）`);
            hiddenDetails[detail] = true;
        }
    });

    return {
        note: Array.from(new Set(noteItems)).join('；'),
        hiddenDetails
    };
}

function formatTrigger(trigger) {
    if (trigger === 'schedule') return '定时任务';
    if (trigger === 'manual') return '手动更新';
    if (trigger === 'widget') return '状态小组件';
    return '网络变化';
}

function notifyManualResult(ctx, snapshot) {
    if (!ctx || typeof ctx.notify !== 'function') return;
    const requestLines = (snapshot.results || []).slice(0, 5).map(function(result) {
        return `${result.label}: ${result.statusText || (result.success ? '成功' : '失败')}`;
    });
    const body = [
        snapshot.network && snapshot.network.label ? snapshot.network.label : '未知网络',
        snapshot.note || '',
        requestLines.join('\n')
    ].filter(Boolean).join('\n');
    try {
        ctx.notify({
            title: `PO0 白名单 · ${snapshot.summary || '失败'}`,
            body,
            sound: false
        });
    } catch (error) { /* noop */ }
}

function formatDate(value) {
    if (!value) return '-';
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '-';
    const pad = function(number) { return String(number).padStart(2, '0'); };
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function log(ctx, message) {
    try {
        if (typeof console !== 'undefined' && console && typeof console.log === 'function') {
            console.log(String(message));
        }
    } catch (error) { /* noop */ }
}

function getErrorMessage(error) {
    return String(error && error.message ? error.message : error);
}
