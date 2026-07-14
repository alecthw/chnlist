// =============================================================
// Quantumult X PO0 防火墙白名单脚本
//
// - event-network：网络变化时更新
// - cron：每 30 分钟更新
// - event-interaction：手动更新或查看最近一次结果
// - 仅使用 Quantumult X 原生 $task/$prefs/$notify/$done API
// =============================================================

const SCRIPT_NAME = 'PO0W';
const DEFAULT_HOST = '124.221.69.228';
const PUBLIC_IP_TIMEOUT_MS = 4000;
const DEFAULT_CACHE_MAX_AGE_HOURS = 6;
const PUBLIC_IP_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const STORE_PREFIX = 'po0w:firewall:quanx';

const rawArgs = getRuntimeArgs();
const mode = rawArgs.mode || 'update';

async function start() {
    if (mode === 'status') {
        runStatus();
        return;
    }

    try {
        const snapshot = await runUpdate();
        if (mode === 'manual') {
            finishInteraction(snapshot, getNetworkInfo());
        } else {
            if (snapshot.status !== 'success') notifyAutomaticFailure(snapshot);
            $done();
        }
    } catch (error) {
        const snapshot = createFailureSnapshot(error);
        writeSnapshot(snapshot);
        console.log(`[${SCRIPT_NAME}] ${snapshot.note}`);

        if (mode === 'manual') {
            finishInteraction(snapshot, getNetworkInfo());
        } else {
            notifyAutomaticFailure(snapshot);
            $done();
        }
    }
}

function runStatus() {
    try {
        buildConfig(rawArgs);
        const currentNetwork = getNetworkInfo();
        const snapshot = readSnapshot();

        if (!snapshot) {
            $done({
                title: 'PO0W 防火墙白名单',
                message: [
                    'API 请求结果: 暂无',
                    `当前网络环境: ${currentNetwork.label}`,
                    '公网 IP: 暂无',
                    '请先运行“PO0W 手动更新”，或等待网络变化/定时任务执行。'
                ].join('\n')
            });
            return;
        }

        finishInteraction(snapshot, currentNetwork);
    } catch (error) {
        $done({
            title: 'PO0W 查看状态失败',
            message: sanitizeAllTokens(`参数或运行错误: ${getErrorMessage(error)}`)
        });
    }
}

async function runUpdate() {
    const cfg = buildConfig(rawArgs);
    const network = getNetworkInfo();
    const skippedSSID = network.type === 'wifi' && network.ssid && cfg.skipSSIDs.includes(network.ssid);

    if (skippedSSID && !isManualTrigger(cfg.trigger)) {
        const snapshot = createSkippedSnapshot(network, cfg.trigger);
        writeSnapshot(snapshot);
        console.log(`[${SCRIPT_NAME}] ${network.label}：${snapshot.summary}${snapshot.note ? `，${snapshot.note}` : ''}`);
        return snapshot;
    }

    if (skippedSSID) {
        console.log(`[${SCRIPT_NAME}] 手动更新忽略 skip_ssids，强制更新非蜂窝 Tokens`);
    }

    const selected = network.type === 'cellular' ? cfg.cellularTokens : cfg.wifiTokens;
    const groupName = network.type === 'cellular'
        ? '蜂窝'
        : (network.ssid ? 'Wi-Fi' : '非蜂窝');
    const publicInfo = await getDirectInfo();

    if (!selected.length) {
        const snapshot = createSnapshot({
            status: 'success',
            summary: '未请求（未配置 Token）',
            network,
            trigger: cfg.trigger,
            note: '',
            publicInfo,
            results: []
        });
        writeSnapshot(snapshot);
        console.log(`[${SCRIPT_NAME}] ${network.label}：${snapshot.summary}`);
        return snapshot;
    }

    const forceRefresh = isManualTrigger(cfg.trigger);
    const tokenCache = readTokenCache();
    const tasks = selected.map(function (item) {
        if (!item.valid) {
            return Promise.resolve(createRequestFailure(item, groupName, item.error, false));
        }
        const previous = findCachedRequestResult(tokenCache, item);
        const cacheExpired = Boolean(cfg.cacheDiff && !forceRefresh && previous &&
            isTokenCacheExpired(previous.updatedAt, cfg.cacheMaxAgeHours));
        const cachedSlotIP = previous && !cacheExpired
            ? getWhitelistSlotIP(previous, item.slot)
            : '';
        if (cfg.cacheDiff && !forceRefresh && publicInfo.ip && isSameIPAddress(publicInfo.ip, cachedSlotIP)) {
            return Promise.resolve(createCachedMatchResult(item, groupName, previous));
        }
        return requestWhitelist(cfg.host, item, groupName).then(function(result) {
            return markCacheExpiredResult(result, cacheExpired);
        });
    });
    const results = await Promise.all(tasks);
    updateTokenCacheFromResults(tokenCache, selected, results);
    const successCount = results.filter(function (result) { return result.success; }).length;
    const failureCount = results.length - successCount;
    const expiredCacheCount = results.filter(function (result) { return result.cacheExpired; }).length;
    let status = 'success';
    let summary = '成功';
    const allCacheHits = results.length > 0 && results.every(function(result) { return result && result.cacheHit; });

    if (allCacheHits) {
        summary = '未请求（IP 未变化）';
    } else if (successCount === 0) {
        status = 'failure';
        summary = '失败';
    } else if (failureCount > 0) {
        status = 'partial';
        summary = '部分失败';
    }

    const notes = [];
    if (!cfg.cacheDiff && !forceRefresh) notes.push('缓存比较已关闭');
    if (expiredCacheCount) notes.push(`${expiredCacheCount} 项缓存过期`);

    const snapshot = createSnapshot({
        status,
        summary,
        network,
        trigger: cfg.trigger,
        note: notes.join('；'),
        publicInfo,
        results
    });
    writeSnapshot(snapshot);
    console.log(`[${SCRIPT_NAME}] ${network.label}：${summary}${snapshot.note ? `，${snapshot.note}` : ''}`);
    return snapshot;
}

// ============================================================
// 参数与网络环境
// ============================================================

function getRuntimeArgs() {
    const environment = getRuntimeEnvironment();
    const variableArgs = parseEnvironmentVariables(environment.variables);
    const sourceArgs = parseSourcePath(environment.sourcePath);
    return Object.assign({}, variableArgs, sourceArgs);
}

function parseSourcePath(sourcePath) {
    const text = String(sourcePath || '');
    const index = text.indexOf('#');
    return index >= 0 ? parseArgs(text.substring(index + 1)) : {};
}

function parseEnvironmentVariables(variables) {
    if (!variables) return {};
    if (typeof variables === 'string') return parseArgs(variables.replace(/^#/, ''));
    if (typeof variables !== 'object' || Array.isArray(variables)) return {};

    const result = {};
    Object.keys(variables).forEach(function (key) {
        const value = variables[key];
        if (value !== undefined && value !== null) result[key] = String(value);
    });
    return result;
}

function parseArgs(argument) {
    const result = {};
    if (!argument) return result;

    String(argument).split('&').forEach(function (pair) {
        const index = pair.indexOf('=');
        if (index <= 0) return;
        const key = pair.substring(0, index).trim();
        result[key] = decodeArgValue(pair.substring(index + 1).trim());
    });
    return result;
}

function decodeArgValue(value) {
    try {
        return decodeURIComponent(value);
    } catch (error) {
        return value;
    }
}

function buildConfig(args) {
    const cellularTokens = parseTokenList(args.cellular_tokens, 'cellular');
    const wifiTokens = parseTokenList(args.wifi_tokens, 'wifi');
    if (!cellularTokens.length && !wifiTokens.length) {
        throw new Error('cellular_tokens 和 wifi_tokens 不能全空');
    }

    return {
        host: normalizeHost(args.host || DEFAULT_HOST),
        cellularTokens,
        wifiTokens,
        skipSSIDs: parseList(args.skip_ssids),
        cacheDiff: parseBooleanArg(args.cache_diff, true),
        cacheMaxAgeHours: parsePositiveNumberArg(args.cache_max_age_hours, DEFAULT_CACHE_MAX_AGE_HOURS),
        trigger: normalizeTrigger(args.trigger, args.mode)
    };
}

function parseBooleanArg(value, defaultValue) {
    const text = cleanText(value).toLowerCase();
    if (!text) return Boolean(defaultValue);
    if (text === 'true') return true;
    if (text === 'false') return false;
    throw new Error('cache_diff 必须是 true 或 false');
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

function normalizeTrigger(trigger, currentMode) {
    if (trigger === 'cron') return 'cron';
    if (trigger === 'manual' || currentMode === 'manual') return 'manual';
    if (trigger === 'status' || currentMode === 'status') return 'status';
    return 'event';
}

function isManualTrigger(trigger) {
    return trigger === 'manual';
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

    return String(value).split('|').map(function (part) {
        return part.trim();
    }).filter(Boolean).map(function (part, index) {
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
    return String(value).split('|').map(function (item) {
        return item.trim();
    }).filter(Boolean);
}

function getNetworkInfo() {
    const network = getRuntimeNetwork();
    const environment = getRuntimeEnvironment();
    const interfaces = getPrimaryInterfaces(network, environment);
    const rawSSID = getCurrentSSID(network, environment);
    const wiredAddress = isIPAddress(rawSSID) ? rawSSID : '';
    const ssid = wiredAddress ? '' : rawSSID;

    // Quantumult X 会在 Wi-Fi 下提供 SSID；部分有线网络会把本地 IP
    // 放在同一字段中。这两种情况均优先判定为非蜂窝，避免设备仍有
    // 蜂窝信息时将 Wi-Fi 或外接网卡误判为蜂窝。
    if (rawSSID) {
        return {
            type: 'wifi',
            ssid,
            interfaces,
            label: wiredAddress
                ? `非蜂窝（${wiredAddress}）`
                : `Wi-Fi（${ssid}）`
        };
    }

    const cellularByInterface = interfaces.length > 0
        && interfaces.every(isCellularInterface);
    const cellularByEnvironment = interfaces.length === 0
        && hasCellularInfo(environment && environment.cellular);
    const cellular = cellularByInterface || cellularByEnvironment;

    if (cellular) {
        return {
            type: 'cellular',
            ssid: '',
            interfaces,
            label: '蜂窝网络'
        };
    }

    return {
        type: 'wifi',
        ssid,
        interfaces,
        label: ssid
            ? `Wi-Fi（${ssid}）`
            : (interfaces.length
                ? `非蜂窝（${interfaces.join(' / ')}）`
                : '非蜂窝')
    };
}

function getRuntimeNetwork() {
    try {
        return typeof $network !== 'undefined' && $network && typeof $network === 'object'
            ? $network
            : {};
    } catch (error) {
        return {};
    }
}

function getRuntimeEnvironment() {
    try {
        return typeof $environment !== 'undefined' && $environment && typeof $environment === 'object'
            ? $environment
            : {};
    } catch (error) {
        return {};
    }
}

function getPrimaryInterfaces(network, environment) {
    const value = network && typeof network === 'object' ? network : {};
    const env = environment && typeof environment === 'object' ? environment : {};
    const candidates = [
        value.v4 && value.v4.primaryInterface,
        value.v6 && value.v6.primaryInterface,
        env.v4 && env.v4.primaryInterface,
        env.v6 && env.v6.primaryInterface,
        env.primaryInterface,
        env['primary-interface'],
        env.interface,
        env['network-interface']
    ];
    const interfaces = [];

    candidates.forEach(function (candidate) {
        const name = candidate === null || typeof candidate === 'undefined'
            ? ''
            : String(candidate).trim();
        if (name && !interfaces.includes(name)) interfaces.push(name);
    });
    return interfaces;
}

function isCellularInterface(name) {
    return /^pdp_ip\d+$/i.test(String(name || '').trim());
}

function hasCellularInfo(cellular) {
    if (!cellular || typeof cellular !== 'object' || Array.isArray(cellular)) return false;
    return Object.keys(cellular).some(function (key) {
        const value = cellular[key];
        if (value === null || typeof value === 'undefined') return false;
        if (typeof value === 'string') {
            const text = value.trim().toLowerCase();
            return Boolean(text) && text !== 'null' && text !== 'undefined' && text !== '-';
        }
        if (typeof value === 'number') return Number.isFinite(value);
        if (typeof value === 'boolean') return value;
        if (typeof value === 'object') return hasCellularInfo(value);
        return false;
    });
}

function isIPAddress(value) {
    const text = String(value || '').trim();
    if (!text) return false;

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
        return text.split('.').every(function (part) {
            const number = Number(part);
            return number >= 0 && number <= 255;
        });
    }

    const address = text.split('%')[0];
    return address.includes(':')
        && /^[0-9a-f:]+$/i.test(address)
        && (address.match(/:/g) || []).length >= 2;
}

function getCurrentSSID(network, environment) {
    try {
        const value = network && typeof network === 'object' ? network : {};
        const env = environment && typeof environment === 'object' ? environment : {};
        if (value.wifi && value.wifi.ssid) return String(value.wifi.ssid).trim();
        if (env.ssid) return String(env.ssid).trim();
        if (env.wifi && env.wifi.ssid) return String(env.wifi.ssid).trim();
    } catch (error) { /* noop */ }
    return '';
}

// ============================================================
// DIRECT 公网 IP 与运营商查询
// ============================================================

async function getDirectInfo() {
    const providers = [
        { name: '126', url: 'https://ipservice.ws.126.net/locate/api/getLocByIp', parse: parse126PublicInfo },
        { name: 'BILI', url: 'https://api.bilibili.com/x/web-interface/zone', parse: parseBilibiliPublicInfo },
        { name: 'IPIP', url: 'https://myip.ipip.net/json', parse: parseIPIPPublicInfo }
    ];
    const errors = [];
    for (let index = 0; index < providers.length; index++) {
        const provider = providers[index];
        try {
            const data = await requestPublicInfo(provider.url);
            const parsed = provider.parse(data);
            if (!parsed || !isValidIPAddress(parsed.ip)) throw new Error('响应中缺少有效公网 IP');
            const info = createPublicInfo(Object.assign({}, parsed, { provider: provider.name }));
            console.log(`[${SCRIPT_NAME}] 公网 IP: ${info.ip}（${info.provider}），运营商: ${info.carrier || '-'}`);
            return info;
        } catch (error) {
            const message = getErrorMessage(error);
            errors.push(`${provider.name}: ${message}`);
            console.log(`[${SCRIPT_NAME}] ${provider.name} 公网 IP 查询失败: ${message}`);
        }
    }
    return createPublicInfo({ error: errors.join('；') || '公网 IP 查询失败' });
}

async function requestPublicInfo(url) {
    let timer;
    let response;
    try {
        response = await Promise.race([
            $task.fetch({
                url,
                method: 'GET',
                headers: { Accept: 'application/json', 'User-Agent': PUBLIC_IP_USER_AGENT },
                opts: { policy: 'direct', 'skip-cert-verify': false }
            }),
            new Promise(function(resolve, reject) {
                timer = setTimeout(function() { reject(new Error('HTTP TIMEOUT')); }, PUBLIC_IP_TIMEOUT_MS);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
    const status = Number(response && (response.statusCode || response.status) || 0);
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status || '未知状态'}`);
    const body = response && response.body !== undefined && response.body !== null ? String(response.body) : '';
    try {
        return JSON.parse(body);
    } catch (error) {
        throw new Error('响应不是有效 JSON');
    }
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
        ip: cleanText(value.ip), provider: cleanText(value.provider), country: cleanText(value.country),
        province, city, isp, carrier: formatCarrierLabel(province, city, isp), error: cleanText(value.error)
    };
}

function formatCarrierLabel(province, city, isp) {
    const p = normalizeLocationPart(province);
    const c = normalizeLocationPart(city);
    const operator = normalizeISP(isp);
    let location = p;
    if (c && c !== p) location += c;
    else if (!location) location = c;
    if (location && operator) return `${location}${operator}`;
    if (operator) return operator;
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

async function requestWhitelist(host, item, groupName) {
    const url = `https://${host}/api/firewall/${encodeURIComponent(item.token)}/add?slot=${encodeURIComponent(item.slot)}`;
    const request = {
        url,
        method: 'GET',
        headers: { Accept: 'application/json' },
        opts: {
            policy: 'direct',
            'skip-cert-verify': false
        }
    };

    try {
        const response = await $task.fetch(request);
        const status = Number(response && (response.statusCode || response.status) || 0);
        const body = response && response.body !== undefined && response.body !== null
            ? String(response.body)
            : '';
        let data = null;

        try {
            data = JSON.parse(body);
        } catch (error) { /* handled below */ }

        if (isAlreadyPinnedResponse(data)) {
            return createAlreadyPinnedResult(item, groupName);
        }

        if (status < 200 || status >= 300) {
            const responseMessage = data && (data.message || data.error);
            const detail = responseMessage
                ? `: ${sanitizeRequestError(formatServerError(responseMessage), item.token)}`
                : '';
            return createRequestFailure(item, groupName, `HTTP ${status || '未知状态'}${detail}`);
        }

        if (!data) {
            return createRequestFailure(item, groupName, 'API 响应不是有效 JSON');
        }

        return createRequestResult(item, groupName, data);
    } catch (error) {
        return createRequestFailure(item, groupName, sanitizeRequestError(error, item.token));
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
        requestKey: getRequestKey(item.token),
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

function createAlreadyPinnedResult(item, groupName) {
    const label = formatRequestLabel(groupName, item);
    const strictPrevious = findCachedRequestResult(readTokenCache(), item);
    const snapshot = readSnapshot();
    const previous = strictPrevious || findPreviousRequestResultInSnapshot(snapshot, item, label, true);
    const hasPreviousData = previous && hasUsableRequestData(previous);

    return {
        label,
        requestKey: getRequestKey(item.token),
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

function createCachedMatchResult(item, groupName, previous) {
    return {
        label: formatRequestLabel(groupName, item),
        requestKey: getRequestKey(item.token),
        slot: item.slot,
        success: true,
        apiRequested: false,
        cacheHit: true,
        cacheComparable: true,
        whitelistReceived: false,
        statusText: 'IP 未变化',
        detail: '',
        error: '',
        currentIp: previous && previous.currentIp ? previous.currentIp : '-',
        whitelist: previous && Array.isArray(previous.whitelist) ? previous.whitelist : []
    };
}

function findCachedRequestResult(cache, item) {
    const entries = cache && cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
    const requestKey = getRequestKey(item.token);
    const entry = entries[requestKey];
    if (!entry || !isValidWhitelistCIDR(entry.ip)) return null;
    return {
        requestKey,
        currentIp: entry.currentIp || '-',
        whitelist: Array.isArray(entry.whitelist) && entry.whitelist.length
            ? normalizeWhitelist(entry.whitelist)
            : [{ slot: String(entry.slot || item.slot), ip: String(entry.ip) }],
        cacheComparable: true,
        updatedAt: Number(entry.updatedAt || 0)
    };
}

function findPreviousRequestResultInSnapshot(snapshot, item, label, allowFallback) {
    if (!snapshot) return null;

    const usableResults = (Array.isArray(snapshot.results) ? snapshot.results : []).filter(hasUsableRequestData);
    const requestKey = getRequestKey(item.token);
    const sameToken = usableResults.find(function (result) {
        return result.requestKey && result.requestKey === requestKey;
    });
    if (sameToken) return sameToken;

    const exact = usableResults.find(function (result) {
        return result.label === label;
    });
    return exact || (allowFallback ? usableResults[0] : null) || null;
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
        requestKey: item.token ? getRequestKey(item.token) : '',
        slot: item.slot,
        success: false,
        apiRequested: apiRequested !== false,
        cacheHit: false,
        cacheComparable: false,
        whitelistReceived: false,
        error: sanitizeRequestError(error, item.token),
        currentIp: '-',
        whitelist: []
    };
}

function formatRequestLabel(groupName, item) {
    return `${groupName} #${item.index}（slot ${item.slot}）`;
}

function getRequestKey(token) {
    return hashString(`token:${String(token || '')}`);
}

function normalizeWhitelist(whitelist) {
    return whitelist.map(function (entry) {
        const value = entry && typeof entry === 'object' ? entry : {};
        return {
            slot: value.slot === undefined || value.slot === null ? '?' : String(value.slot),
            ip: value.ip === undefined || value.ip === null || value.ip === '' ? '-' : String(value.ip)
        };
    }).sort(function (left, right) {
        const leftSlot = Number(left.slot);
        const rightSlot = Number(right.slot);
        if (Number.isFinite(leftSlot) && Number.isFinite(rightSlot)) return leftSlot - rightSlot;
        return String(left.slot).localeCompare(String(right.slot));
    });
}

function sanitizeRequestError(error, token) {
    let message = getErrorMessage(error);
    if (token) {
        [String(token), encodeURIComponent(String(token))].forEach(function (secret) {
            if (secret) message = message.split(secret).join('***');
        });
    }
    message = sanitizeAllTokens(message);
    return message.length > 200 ? `${message.substring(0, 197)}...` : message;
}

function sanitizeAllTokens(value) {
    let message = String(value || '');
    const tokens = parseTokenList(rawArgs.cellular_tokens, 'cellular')
        .concat(parseTokenList(rawArgs.wifi_tokens, 'wifi'))
        .map(function (item) { return item.token; })
        .filter(Boolean);

    tokens.forEach(function (token) {
        [String(token), encodeURIComponent(String(token))].forEach(function (secret) {
            if (secret) message = message.split(secret).join('***');
        });
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
        network: options.network,
        trigger: options.trigger,
        note: options.note || '',
        publicInfo: options.publicInfo || createPublicInfo({}),
        results: options.results || [],
        updatedAt: Date.now()
    };
}

function createSkippedSnapshot(network, trigger) {
    const previous = readSnapshot();
    const previousResults = previous && Array.isArray(previous.results) ? previous.results : [];
    if (!previousResults.length) {
        return createSnapshot({
            status: 'success',
            summary: '已跳过（命中 skip_ssids）',
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
        network,
        trigger,
        note: '',
        publicInfo: previous.publicInfo || createPublicInfo({}),
        results: copyRequestResults(previousResults),
        updatedAt: Number(previous.updatedAt || 0)
    };
}

function createFailureSnapshot(error) {
    return createSnapshot({
        status: 'failure',
        summary: '失败',
        network: getNetworkInfo(),
        trigger: normalizeTrigger(rawArgs.trigger, rawArgs.mode),
        note: sanitizeAllTokens(`参数或运行错误: ${getErrorMessage(error)}`),
        results: []
    });
}

function writeSnapshot(snapshot) {
    try {
        mergeSnapshotResultsWithPrevious(snapshot, readSnapshot());
        const safeSnapshot = sanitizeSnapshotForStorage(snapshot);
        const saved = writeStoredJSON(getStoreKey('snapshot'), safeSnapshot);
        if (!saved) console.log(`[${SCRIPT_NAME}] 保存状态失败: $prefs.setValueForKey 返回 false`);
    } catch (error) {
        console.log(`[${SCRIPT_NAME}] 保存状态失败: ${sanitizeAllTokens(getErrorMessage(error))}`);
    }
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
        const requestKey = result && result.requestKey ? String(result.requestKey) : '';
        const previousResult = previousResults.find(function(candidate) {
            const candidateKey = candidate && candidate.requestKey ? String(candidate.requestKey) : '';
            if (requestKey && candidateKey) return requestKey === candidateKey;
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

function readSnapshot() {
    return normalizeSnapshotForRead(readStoredJSON(getStoreKey('snapshot')));
}

function sanitizeSnapshotForStorage(snapshot) {
    const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return {
        version: 2,
        status: String(value.status || 'failure'),
        summary: sanitizeAllTokens(value.summary || '失败'),
        network: copyNetworkInfo(value.network),
        trigger: String(value.trigger || 'event'),
        note: sanitizeAllTokens(value.note || ''),
        publicInfo: copyPublicInfo(value.publicInfo),
        results: copyRequestResults(value.results),
        updatedAt: Number(value.updatedAt || 0)
    };
}

function normalizeSnapshotForRead(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const currentResults = Array.isArray(snapshot.results) ? snapshot.results : [];
    const legacyResults = Array.isArray(snapshot.lastRequestResults) ? snapshot.lastRequestResults : [];
    const useLegacyResults = !currentResults.length && legacyResults.length > 0;
    return sanitizeSnapshotForStorage({
        status: snapshot.status,
        summary: snapshot.summary,
        network: snapshot.network,
        trigger: snapshot.trigger,
        note: snapshot.note,
        publicInfo: snapshot.publicInfo,
        results: useLegacyResults ? legacyResults : currentResults,
        updatedAt: useLegacyResults
            ? (snapshot.lastRequestUpdatedAt || snapshot.updatedAt || 0)
            : (snapshot.updatedAt || 0)
    });
}

function copyPublicInfo(publicInfo) {
    const value = publicInfo && typeof publicInfo === 'object' ? publicInfo : {};
    return createPublicInfo({
        ip: value.ip, provider: value.provider, country: value.country,
        province: value.province, city: value.city, isp: value.isp, error: value.error
    });
}

function copyNetworkInfo(network) {
    const value = network && typeof network === 'object' ? network : {};
    return {
        type: value.type === 'cellular' ? 'cellular' : 'wifi',
        ssid: value.ssid ? String(value.ssid) : '',
        interfaces: Array.isArray(value.interfaces)
            ? value.interfaces.map(function (item) { return String(item); })
            : [],
        label: value.label ? String(value.label) : '未知网络'
    };
}

function copyRequestResults(results) {
    return (Array.isArray(results) ? results : []).map(function (result) {
        const value = result && typeof result === 'object' ? result : {};
        return {
            label: sanitizeAllTokens(value.label || ''),
            requestKey: value.requestKey ? String(value.requestKey) : '',
            slot: value.slot === null || typeof value.slot === 'undefined'
                ? '?'
                : String(value.slot),
            success: Boolean(value.success),
            apiRequested: Boolean(value.apiRequested),
            cacheHit: Boolean(value.cacheHit),
            cacheComparable: value.cacheComparable !== false,
            whitelistReceived: Boolean(value.whitelistReceived),
            statusText: sanitizeAllTokens(value.statusText || ''),
            detail: sanitizeAllTokens(value.detail || ''),
            error: sanitizeAllTokens(value.error || ''),
            currentIp: value.currentIp ? String(value.currentIp) : '-',
            whitelist: Array.isArray(value.whitelist)
                ? value.whitelist.map(function (entry) {
                    return {
                        slot: entry && entry.slot !== null && typeof entry.slot !== 'undefined'
                            ? String(entry.slot)
                            : '?',
                        ip: entry && entry.ip ? String(entry.ip) : '-'
                    };
                })
                : []
        };
    });
}

function readTokenCache() {
    const stored = readStoredJSON(getStoreKey('token-cache'));
    if (stored && stored.entries && typeof stored.entries === 'object') {
        return { version: 2, entries: stored.entries };
    }
    const migrated = migrateLegacyTokenCache(readStoredJSON(getStoreKey('snapshot')));
    if (Object.keys(migrated.entries).length) writeTokenCache(migrated);
    return migrated;
}

function writeTokenCache(cache) {
    try {
        const saved = writeStoredJSON(getStoreKey('token-cache'), {
            version: 2,
            entries: cache && cache.entries && typeof cache.entries === 'object' ? cache.entries : {}
        });
        if (!saved) console.log(`[${SCRIPT_NAME}] 保存 token 缓存失败`);
        return saved;
    } catch (error) {
        console.log(`[${SCRIPT_NAME}] 保存 token 缓存失败: ${sanitizeAllTokens(getErrorMessage(error))}`);
        return false;
    }
}

function updateTokenCacheFromResults(cache, items, results) {
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
        const key = getRequestKey(item.token);
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
    if (changed) writeTokenCache(value);
}

function migrateLegacyTokenCache(snapshot) {
    const cache = { version: 2, entries: {} };
    if (!snapshot || typeof snapshot !== 'object') return cache;
    const current = Array.isArray(snapshot.results) ? snapshot.results : [];
    const history = Array.isArray(snapshot.lastUsableResults) ? snapshot.lastUsableResults : [];
    current.concat(history).forEach(function(result) {
        if (!result || !result.success || result.apiRequested !== true || result.whitelistReceived !== true ||
            result.cacheComparable === false || !hasUsableRequestData(result)) return;
        const key = result.requestKey ? String(result.requestKey) : '';
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

function readStoredJSON(key) {
    try {
        const raw = $prefs.valueForKey(key);
        if (!raw) return null;
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return value && typeof value === 'object' ? value : null;
    } catch (error) {
        return null;
    }
}

function writeStoredJSON(key, value) {
    return $prefs.setValueForKey(JSON.stringify(value), key);
}

function getStoreKey(suffix) {
    const scope = [
        String(rawArgs.host || DEFAULT_HOST)
            .trim()
            .replace(/^https?:\/\//i, '')
            .replace(/\/+$/, '')
            .toLowerCase(),
        rawArgs.cellular_tokens || '',
        rawArgs.wifi_tokens || '',
        rawArgs.skip_ssids || ''
    ].join('|');
    return `${STORE_PREFIX}:${hashString(scope)}:${suffix}`;
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
// 交互展示与通知
// ============================================================

function finishInteraction(snapshot, currentNetwork) {
    const output = renderInteraction(snapshot, currentNetwork);
    $done({
        title: output.title,
        message: output.message
    });
}

function renderInteraction(snapshot, currentNetwork) {
    const network = currentNetwork || snapshot.network || { label: '未知' };
    const lastNetwork = snapshot.network && snapshot.network.label ? snapshot.network.label : '未知';
    const publicInfo = snapshot.publicInfo && typeof snapshot.publicInfo === 'object' ? snapshot.publicInfo : {};
    const publicIP = publicInfo.ip
        ? `${publicInfo.ip}${publicInfo.provider ? `（${publicInfo.provider}）` : ''}`
        : (publicInfo.error ? '查询失败' : '-');
    const carrier = publicInfo.carrier && publicInfo.carrier !== '-' ? publicInfo.carrier : '-';
    const publicIPWithCarrier = carrier !== '-' ? `${publicIP} ${carrier}` : publicIP;
    const displayMeta = buildDisplayMeta(snapshot);
    const lines = [
        `API 请求结果: ${snapshot.summary || '失败'}`,
        `当前网络环境: ${network.label || '未知'}`,
        `公网 IP: ${publicIPWithCarrier}`
    ];

    if (network.label !== lastNetwork) lines.push(`上次请求网络: ${lastNetwork}`);
    lines.push(`触发方式: ${formatTrigger(snapshot.trigger)}`);
    lines.push(`更新时间: ${formatDate(snapshot.updatedAt)}`);
    if (displayMeta.note) lines.push(`说明: ${displayMeta.note}`);

    (snapshot.results || []).forEach(function (result) {
        lines.push('');
        lines.push(`【${result.label}】`);
        if (result.detail && !displayMeta.hiddenDetails[result.detail]) lines.push(`说明: ${result.detail}`);
        if (result.error) lines.push(`错误: ${result.error}`);
        lines.push(`当前 IP: ${result.currentIp || '-'}`);
        lines.push('白名单:');
        if (result.whitelist && result.whitelist.length) {
            result.whitelist.forEach(function (entry) {
                lines.push(`  ${entry.slot}: ${entry.ip}`);
            });
        } else {
            lines.push('  （空）');
        }
    });

    return {
        title: `PO0W 防火墙白名单 · ${snapshot.summary || '失败'}`,
        message: lines.join('\n')
    };
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
    if (trigger === 'cron') return '定时任务';
    if (trigger === 'manual') return '手动更新';
    if (trigger === 'status') return '手动查看';
    return '网络变化';
}

function notifyAutomaticFailure(snapshot) {
    try {
        const failed = (snapshot.results || []).filter(function (result) { return !result.success; });
        const details = failed.slice(0, 5).map(function (result) {
            return `${result.label}: ${result.error || '失败'}`;
        });
        const body = [
            snapshot.network && snapshot.network.label ? snapshot.network.label : '未知网络',
            snapshot.note || '',
            details.join('\n')
        ].filter(Boolean).join('\n');
        $notify(`PO0W 自动更新 · ${snapshot.summary || '失败'}`, '', body);
    } catch (error) { /* noop */ }
}

function formatDate(value) {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '-';
    const pad = function (number) { return String(number).padStart(2, '0'); };
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getErrorMessage(error) {
    return String(error && error.message ? error.message : error);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        runUpdate,
        parseArgs,
        parseSourcePath,
        parseEnvironmentVariables,
        buildConfig,
        parseBooleanArg,
        normalizeHost,
        parseTokenList,
        parseList,
        getNetworkInfo,
        getPrimaryInterfaces,
        isCellularInterface,
        hasCellularInfo,
        isIPAddress,
        getDirectInfo,
        createPublicInfo,
        formatCarrierLabel,
        findCachedRequestResult,
        getWhitelistSlotIP,
        isSameIPAddress,
        requestWhitelist,
        createRequestResult,
        createAlreadyPinnedResult,
        normalizeWhitelist,
        createSkippedSnapshot,
        renderInteraction,
        hashString
    };
}

if (typeof $done === 'function') start();
