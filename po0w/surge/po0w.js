// =============================================================
// Surge PO0 防火墙白名单脚本
//
// - network-changed：按当前网络更新对应 token 组
// - cron：每 30 分钟执行一次
// - panel：点击刷新按钮手动更新；自动刷新只读取最近一轮结果
// - 自动更新：先查询 DIRECT 公网 IP，与缓存中当前 slot 比较，相同则跳过写入 API
// =============================================================

const SCRIPT_NAME = 'PO0W';
const DEFAULT_HOST = '124.221.69.228';
const REQUEST_TIMEOUT = 10;
const PUBLIC_IP_TIMEOUT = 4;
const DEFAULT_CACHE_MAX_AGE_HOURS = 6;
const PUBLIC_IP_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const STORE_PREFIX = 'po0w:firewall';
const NETWORK_DEBUG = false;

const rawArgs = parseArgs(getArgument());
const mode = rawArgs.mode || 'update';

function start() {
    if (mode === 'panel') {
        runPanel();
        return;
    }

    runUpdate().then(function (snapshot) {
        if (mode === 'manual') notifyManualResult(snapshot);
        $done();
    }).catch(function (error) {
        const snapshot = createFailureSnapshot(error);
        writeSnapshot(snapshot);
        console.log(`[${SCRIPT_NAME}] ${getErrorMessage(error)}`);
        if (mode === 'manual') notifyManualResult(snapshot);
        $done();
    });
}

async function runUpdate() {
    logNetworkDiagnostics();
    const cfg = buildConfig(rawArgs);
    const network = getNetworkInfo();
    const skippedSSID = network.type === 'wifi' && cfg.skipSSIDs.includes(network.ssid);

    if (skippedSSID && !isManualTrigger(cfg.trigger)) {
        const snapshot = createSkippedSnapshot(network, cfg.trigger);
        writeSnapshot(snapshot);
        console.log(`[${SCRIPT_NAME}] ${network.label}：${snapshot.summary}${snapshot.note ? `，${snapshot.note}` : ''}`);
        return snapshot;
    }

    if (skippedSSID) {
        console.log(`[${SCRIPT_NAME}] 手动更新忽略 skip_ssids，强制更新 Wi-Fi tokens`);
    }

    const selected = network.type === 'wifi' ? cfg.wifiTokens : cfg.cellularTokens;
    const groupName = network.type === 'wifi'
        ? (network.ssid ? 'Wi-Fi' : '非蜂窝')
        : '蜂窝';
    const publicInfo = await getDirectInfo();

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
        writeSnapshot(snapshot);
        console.log(`[${SCRIPT_NAME}] ${network.label}：${snapshot.summary}`);
        return snapshot;
    }

    const forceRefresh = isManualTrigger(cfg.trigger);
    const previousSnapshot = readSnapshot();
    const slotCache = readSlotCache();
    const tasks = selected.map(function (item) {
        if (!item.valid) {
            return Promise.resolve(createRequestFailure(item, groupName, item.error, false));
        }

        const label = formatRequestLabel(groupName, item);
        const cachedPrevious = findSlotCacheResult(slotCache, item);
        const previous = cachedPrevious ||
            findPreviousRequestResultInSnapshot(previousSnapshot, item, label, false);
        const cacheExpired = Boolean(cfg.cacheDiff && !forceRefresh && cachedPrevious &&
            isTokenCacheExpired(cachedPrevious.updatedAt, cfg.cacheMaxAgeHours));
        const cachedSlotIP = cachedPrevious && !cacheExpired
            ? getWhitelistSlotIP(cachedPrevious, item.slot)
            : '';
        if (cfg.cacheDiff && !forceRefresh && publicInfo.ip && isSameIPAddress(publicInfo.ip, cachedSlotIP)) {
            return Promise.resolve(createCachedMatchResult(item, groupName, previous));
        }
        return requestWhitelist(cfg.host, item, groupName).then(function(result) {
            return markCacheExpiredResult(result, cacheExpired);
        });
    });
    const results = await Promise.all(tasks);
    updateSlotCacheFromResults(slotCache, selected, results);
    const successCount = results.filter(function (result) { return result.success; }).length;
    const failureCount = results.length - successCount;
    const expiredCacheCount = results.filter(function (result) { return result.cacheExpired; }).length;
    let status = 'success';
    let summary = '成功';
    let style = 'good';
    const allCacheHits = results.length > 0 && results.every(function(result) { return result && result.cacheHit; });

    if (allCacheHits) {
        summary = '未请求（IP 未变化）';
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
    if (!cfg.cacheDiff && !forceRefresh) notes.push('缓存比较已关闭');
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
    writeSnapshot(snapshot);
    console.log(`[${SCRIPT_NAME}] ${network.label}：${summary}${snapshot.note ? `，${snapshot.note}` : ''}`);
    return snapshot;
}

async function runPanel() {
    const isButton = getScriptTrigger() === 'button';
    try {
        if (isButton) {
            const snapshot = await runUpdate();
            finishPanel(renderPanel(snapshot));
            return;
        }

        buildConfig(rawArgs);
        const snapshot = readSnapshot();
        if (!snapshot) {
            const network = getNetworkInfo();
            finishPanel({
                title: 'PO0 防火墙白名单',
        content: [
                    'API 请求结果: 暂无',
                    `当前网络环境: ${network.label}`,
                    '公网 IP: 暂无',
                    '点击刷新按钮可手动更新'
                ].join('\n'),
                style: 'info'
            });
            return;
        }
        finishPanel(renderPanel(snapshot));
    } catch (error) {
        const snapshot = createFailureSnapshot(error, isButton ? 'panel' : 'panel-auto');
        if (isButton) writeSnapshot(snapshot);
        finishPanel(renderPanel(snapshot));
    }
}

// ============================================================
// 参数与网络环境
// ============================================================

function getArgument() {
    try {
        return typeof $argument !== 'undefined' ? String($argument || '') : '';
    } catch (error) {
        return '';
    }
}

function parseArgs(argument) {
    const result = {};
    if (!argument) return result;

    String(argument).split('&').forEach(function (pair) {
        const index = pair.indexOf('=');
        if (index <= 0) return;
        const key = pair.substring(0, index).trim();
        const value = decodeArgValue(pair.substring(index + 1).trim());
        result[key] = value;
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
        trigger: args.trigger === 'cron'
            ? 'cron'
            : (args.trigger === 'panel' ? 'panel' : (args.trigger === 'manual' ? 'manual' : 'event'))
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

function isManualTrigger(trigger) {
    return trigger === 'panel' || trigger === 'manual';
}

function getScriptTrigger() {
    try {
        return typeof $trigger !== 'undefined' ? String($trigger || '') : '';
    } catch (error) {
        return '';
    }
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

function logNetworkDiagnostics() {
    if (!NETWORK_DEBUG) return;

    let networkValue;
    let environmentValue;

    try {
        networkValue = typeof $network === 'undefined' ? '<undefined>' : $network;
    } catch (error) {
        networkValue = `<读取失败: ${getErrorMessage(error)}>`;
    }

    try {
        const environment = typeof $environment === 'undefined' || !$environment ? {} : $environment;
        environmentValue = {
            system: environment.system || '',
            surgeVersion: environment['surge-version'] || '',
            surgeBuild: environment['surge-build'] || '',
            deviceModel: environment['device-model'] || ''
        };
    } catch (error) {
        environmentValue = `<读取失败: ${getErrorMessage(error)}>`;
    }

    console.log(`[${SCRIPT_NAME}][network-debug] environment=${safeJSONStringify(environmentValue)}`);
    console.log(`[${SCRIPT_NAME}][network-debug] $network=${safeJSONStringify(networkValue)}`);
}

function safeJSONStringify(value) {
    try {
        const result = JSON.stringify(value);
        return typeof result === 'undefined' ? String(value) : result;
    } catch (error) {
        return `<JSON 序列化失败: ${getErrorMessage(error)}>`;
    }
}

function getNetworkInfo() {
    const network = getSurgeNetwork();
    const interfaces = getPrimaryInterfaces(network);
    const ssid = getCurrentSSID(network);
    const cellular = interfaces.length > 0 && interfaces.every(isCellularInterface);

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

function getSurgeNetwork() {
    try {
        return typeof $network !== 'undefined' && $network ? $network : {};
    } catch (error) {
        return {};
    }
}

function getPrimaryInterfaces(network) {
    const value = network && typeof network === 'object' ? network : {};
    const candidates = [
        value.v4 && value.v4.primaryInterface,
        value.v6 && value.v6.primaryInterface
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

function getCurrentSSID(network) {
    try {
        const value = network && typeof network === 'object' ? network : getSurgeNetwork();
        if (value.wifi && value.wifi.ssid) {
            return String(value.wifi.ssid).trim();
        }
        if (typeof $environment !== 'undefined' && $environment) {
            if ($environment.ssid) return String($environment.ssid).trim();
            if ($environment.wifi && $environment.wifi.ssid) {
                return String($environment.wifi.ssid).trim();
            }
        }
    } catch (error) { /* noop */ }
    return '';
}

// ============================================================
// DIRECT 公网 IP 与运营商查询
// ============================================================

async function getDirectInfo() {
    const providers = [
        {
            name: '126',
            url: 'https://ipservice.ws.126.net/locate/api/getLocByIp',
            parse: parse126PublicInfo
        },
        {
            name: 'BILI',
            url: 'https://api.bilibili.com/x/web-interface/zone',
            parse: parseBilibiliPublicInfo
        },
        {
            name: 'IPIP',
            url: 'https://myip.ipip.net/json',
            parse: parseIPIPPublicInfo
        }
    ];
    const errors = [];

    for (let index = 0; index < providers.length; index++) {
        const provider = providers[index];
        try {
            const data = await requestPublicInfo(provider.url);
            const parsed = provider.parse(data);
            if (!parsed || !isValidIPAddress(parsed.ip)) {
                throw new Error('响应中缺少有效公网 IP');
            }

            const info = createPublicInfo({
                ip: parsed.ip,
                provider: provider.name,
                country: parsed.country,
                province: parsed.province,
                city: parsed.city,
                isp: parsed.isp
            });
            console.log(`[${SCRIPT_NAME}] 公网 IP: ${info.ip}（${info.provider}），运营商: ${info.carrier || '-'}`);
            return info;
        } catch (error) {
            const message = getErrorMessage(error);
            errors.push(`${provider.name}: ${message}`);
            console.log(`[${SCRIPT_NAME}] ${provider.name} 公网 IP 查询失败: ${message}`);
        }
    }

    return createPublicInfo({
        error: errors.join('；') || '公网 IP 查询失败'
    });
}

function requestPublicInfo(url) {
    return new Promise(function (resolve, reject) {
        $httpClient.get({
            url,
            headers: {
                Accept: 'application/json',
                'User-Agent': PUBLIC_IP_USER_AGENT
            },
            timeout: PUBLIC_IP_TIMEOUT,
            policy: 'DIRECT'
        }, function (error, response, body) {
            if (error) {
                reject(new Error(getErrorMessage(error)));
                return;
            }

            const status = response && Number(response.status || response.statusCode || 0);
            if (status < 200 || status >= 300) {
                reject(new Error(`HTTP ${status || '未知状态'}`));
                return;
            }

            try {
                const data = JSON.parse(String(body || ''));
                resolve(data);
            } catch (parseError) {
                reject(new Error('响应不是有效 JSON'));
            }
        });
    });
}

function parse126PublicInfo(body) {
    const result = body && typeof body === 'object' ? body.result || {} : {};
    return {
        ip: result.ip,
        country: result.country,
        province: result.province,
        city: result.city,
        isp: result.operator || result.company
    };
}

function parseBilibiliPublicInfo(body) {
    const data = body && typeof body === 'object' ? body.data || {} : {};
    return {
        ip: data.addr,
        country: data.country,
        province: data.province,
        city: data.city,
        isp: data.isp
    };
}

function parseIPIPPublicInfo(body) {
    const data = body && typeof body === 'object' ? body.data || {} : {};
    const location = Array.isArray(data.location) ? data.location : [];
    return {
        ip: data.ip,
        country: location[0],
        province: location[1],
        city: location[2],
        isp: location[4]
    };
}

function createPublicInfo(options) {
    const value = options || {};
    const country = cleanText(value.country);
    const province = normalizeLocationPart(value.province);
    const city = normalizeLocationPart(value.city);
    const isp = normalizeISP(value.isp);
    return {
        ip: cleanText(value.ip),
        provider: cleanText(value.provider),
        country,
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

    if (normalizedCity && normalizedCity !== normalizedProvince) {
        location += normalizedCity;
    } else if (!location) {
        location = normalizedCity;
    }

    if (location && normalizedISP) return `${location}${normalizedISP}`;
    if (normalizedISP) return normalizedISP;
    if (location) return `${location}（运营商未知）`;
    return '-';
}

function normalizeLocationPart(value) {
    return cleanText(value)
        .replace(/^中国/, '')
        .replace(/\s+/g, '')
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
    return parts.length === 4 && parts.every(function (part) {
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

function requestWhitelist(host, item, groupName) {
    const url = `https://${host}/api/firewall/${encodeURIComponent(item.token)}/add?slot=${encodeURIComponent(item.slot)}`;
    const options = {
        url,
        headers: { Accept: 'application/json' },
        timeout: REQUEST_TIMEOUT,
        policy: 'DIRECT'
    };

    return new Promise(function (resolve) {
        $httpClient.get(options, function (error, response, body) {
            if (error) {
                resolve(createRequestFailure(item, groupName, sanitizeRequestError(error, item.token)));
                return;
            }

            const status = response && Number(response.status || response.statusCode || 0);
            let data = null;
            try {
                data = JSON.parse(String(body || ''));
            } catch (parseError) { /* handled below */ }

            if (isAlreadyPinnedResponse(data)) {
                resolve(createAlreadyPinnedResult(item, groupName));
                return;
            }

            if (status < 200 || status >= 300) {
                const responseMessage = data && (data.message || data.error);
                const detail = responseMessage
                    ? `: ${sanitizeRequestError(formatServerError(responseMessage), item.token)}`
                    : '';
                resolve(createRequestFailure(item, groupName, `HTTP ${status || '未知状态'}${detail}`));
                return;
            }

            if (!data) {
                resolve(createRequestFailure(item, groupName, 'API 响应不是有效 JSON'));
                return;
            }

            resolve(createRequestResult(item, groupName, data));
        });
    });
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
        tokenKey: getSlotCacheEntryKey(item),
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
    const strictPrevious = findSlotCacheResult(readSlotCache(), item);
    const snapshot = readSnapshot();
    const previous = strictPrevious ||
        findPreviousRequestResultInSnapshot(snapshot, item, label, false) ||
        findPreviousRequestResultInSnapshot(snapshot, item, label, true);
    const hasPreviousData = previous && (
        (previous.currentIp && previous.currentIp !== '-') ||
        (Array.isArray(previous.whitelist) && previous.whitelist.length > 0)
    );

    return {
        label,
        tokenKey: getSlotCacheEntryKey(item),
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
        tokenKey: getSlotCacheEntryKey(item),
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

function findPreviousRequestResultInSnapshot(snapshot, item, label, allowFallback) {
    if (!snapshot || !Array.isArray(snapshot.results)) return null;

    const usableResults = snapshot.results.filter(hasUsableRequestData);
    const exact = usableResults.find(function (result) {
        return result.label === label;
    });
    if (exact) return exact;

    const equivalentLabels = getEquivalentRequestLabels(item.token);
    const sameToken = usableResults.find(function (result) {
        return equivalentLabels.includes(result.label);
    });
    return sameToken || (allowFallback ? usableResults[0] : null) || null;
}

function getEquivalentRequestLabels(token) {
    const labels = [];
    [
        { value: rawArgs.cellular_tokens, type: 'cellular', groupNames: ['蜂窝'] },
        { value: rawArgs.wifi_tokens, type: 'wifi', groupNames: ['Wi-Fi', '非蜂窝'] }
    ].forEach(function (group) {
        parseTokenList(group.value, group.type).forEach(function (item) {
            if (item.valid && item.token === token) {
                group.groupNames.forEach(function (groupName) {
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
    const entry = result.whitelist.find(function (item) {
        return item && String(item.slot) === targetSlot;
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
        tokenKey: getSlotCacheEntryKey(item),
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
    return message.length > 200 ? `${message.substring(0, 197)}...` : message;
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

function readSlotCache() {
    try {
        const tokenCacheKey = getStoreKey('token-cache');
        const tokenCacheRaw = readStore(tokenCacheKey);
        const raw = tokenCacheRaw || readStore(getStoreKey('slot-cache'));
        if (!raw) return { version: 2, entries: {} };
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object') return { version: 2, entries: {} };
        const cache = {
            version: 2,
            entries: value.entries && typeof value.entries === 'object' ? value.entries : {}
        };
        if (!tokenCacheRaw) writeStore(JSON.stringify(cache), tokenCacheKey);
        return cache;
    } catch (error) {
        return { version: 2, entries: {} };
    }
}

function findSlotCacheResult(cache, item) {
    const entries = cache && cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
    const entry = findSlotCacheEntry(entries, item);
    if (!entry || !isValidWhitelistCIDR(entry.ip)) return null;
    const whitelist = Array.isArray(entry.whitelist) && entry.whitelist.length
        ? normalizeWhitelist(entry.whitelist)
        : [{ slot: String(item.slot), ip: String(entry.ip) }];
    return {
        currentIp: entry.currentIp || '-',
        whitelist,
        cacheComparable: true,
        updatedAt: Number(entry.updatedAt || 0)
    };
}

function updateSlotCacheFromResults(cache, items, results) {
    const value = cache && typeof cache === 'object' ? cache : { version: 2, entries: {} };
    value.version = 2;
    if (!value.entries || typeof value.entries !== 'object') value.entries = {};
    let changed = false;

    items.forEach(function (item, index) {
        const result = results[index];
        if (!item || !item.valid || !result || !result.success || result.apiRequested !== true ||
            result.cacheComparable === false || result.whitelistReceived !== true) return;
        const slotIP = getWhitelistSlotIP(result, item.slot);
        if (!isValidWhitelistCIDR(slotIP)) return;
        const key = getSlotCacheEntryKey(item);
        const legacyPrefix = `${key}:`;
        Object.keys(value.entries).forEach(function (entryKey) {
            if (entryKey.indexOf(legacyPrefix) !== 0) return;
            delete value.entries[entryKey];
            changed = true;
        });
        if (result.cacheHit && value.entries[key]) return;
        value.entries[key] = {
            slot: String(item.slot),
            ip: slotIP,
            currentIp: result.currentIp || '-',
            whitelist: Array.isArray(result.whitelist) ? result.whitelist : [],
            updatedAt: Date.now()
        };
        changed = true;
    });

    if (!changed) return;
    try {
        const saved = writeStore(JSON.stringify(value), getStoreKey('token-cache'));
        if (!saved) console.log(`[${SCRIPT_NAME}] 保存 token 缓存失败: persistentStore.write 返回 false`);
    } catch (error) {
        console.log(`[${SCRIPT_NAME}] 保存 token 缓存失败: ${getErrorMessage(error)}`);
    }
}

function getSlotCacheEntryKey(item) {
    return hashString(item && item.token ? item.token : '');
}

function findSlotCacheEntry(entries, item) {
    const key = getSlotCacheEntryKey(item);
    if (entries[key]) return entries[key];

    const legacyPrefix = `${key}:`;
    const legacyEntries = Object.keys(entries).filter(function (entryKey) {
        return entryKey.indexOf(legacyPrefix) === 0;
    }).map(function (entryKey) {
        return entries[entryKey];
    }).filter(Boolean);
    if (!legacyEntries.length) return null;

    const targetSlot = String(item && item.slot !== undefined ? item.slot : '?');
    return legacyEntries.find(function (entry) {
        return Array.isArray(entry.whitelist) && entry.whitelist.some(function (whitelistItem) {
            return whitelistItem && String(whitelistItem.slot) === targetSlot;
        });
    }) || legacyEntries[0];
}

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

function createSkippedSnapshot(network, trigger) {
    const previous = readSnapshot();
    const hasPreviousResults = previous && Array.isArray(previous.results) && previous.results.length > 0;
    if (!hasPreviousResults) {
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

    return Object.assign({}, previous, {
        status: 'success',
        summary: '已跳过（命中 skip_ssids）',
        style: 'info',
        network,
        trigger,
        note: ''
    });
}

function createFailureSnapshot(error, trigger) {
    return createSnapshot({
        status: 'failure',
        summary: '失败',
        style: 'error',
        network: getNetworkInfo(),
        trigger: trigger || (rawArgs.trigger === 'cron'
            ? 'cron'
            : (rawArgs.trigger === 'panel' ? 'panel' : (rawArgs.trigger === 'manual' ? 'manual' : 'event'))),
        note: `参数或运行错误: ${getErrorMessage(error)}`,
        results: []
    });
}

function writeSnapshot(snapshot) {
    try {
        mergeSnapshotResultsWithPrevious(snapshot, readSnapshot());
        const saved = writeStore(JSON.stringify(snapshot), getStoreKey('snapshot'));
        if (!saved) console.log(`[${SCRIPT_NAME}] 保存 Panel 结果失败: persistentStore.write 返回 false`);
    } catch (error) {
        console.log(`[${SCRIPT_NAME}] 保存 Panel 结果失败: ${getErrorMessage(error)}`);
    }
}

function mergeSnapshotResultsWithPrevious(snapshot, previous) {
    const previousResults = previous && Array.isArray(previous.results) ? previous.results : [];
    if (!previousResults.length) return snapshot;

    const currentResults = snapshot && Array.isArray(snapshot.results) ? snapshot.results : [];
    if (!currentResults.length) {
        snapshot.results = copySnapshotResults(previousResults);
        snapshot.note = appendFallbackNote(snapshot.note);
        return snapshot;
    }

    snapshot.results = currentResults.map(function(result) {
        if (result && result.success && result.apiRequested && result.whitelistReceived === true) return result;
        const tokenKey = getSnapshotResultTokenKey(result);
        const previousResult = previousResults.find(function(candidate) {
            const candidateKey = getSnapshotResultTokenKey(candidate);
            if (tokenKey && candidateKey) return tokenKey === candidateKey;
            return candidate && result && candidate.label === result.label;
        });
        if (!previousResult) return result;
        return Object.assign({}, result, {
            detail: appendFallbackDetail(result),
            currentIp: previousResult.currentIp || '-',
            whitelist: copySnapshotWhitelist(previousResult.whitelist)
        });
    });
    return snapshot;
}

function getSnapshotResultTokenKey(result) {
    if (result && result.tokenKey) return String(result.tokenKey);
    const label = result && result.label ? String(result.label) : '';
    let tokenKey = '';
    [
        { value: rawArgs.cellular_tokens, type: 'cellular', groupNames: ['蜂窝'] },
        { value: rawArgs.wifi_tokens, type: 'wifi', groupNames: ['Wi-Fi', '非蜂窝'] }
    ].some(function(group) {
        return parseTokenList(group.value, group.type).some(function(item) {
            if (!item.valid) return false;
            const matched = group.groupNames.some(function(groupName) {
                return formatRequestLabel(groupName, item) === label;
            });
            if (matched) tokenKey = getSlotCacheEntryKey(item);
            return matched;
        });
    });
    return tokenKey;
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

function copySnapshotResults(results) {
    return (Array.isArray(results) ? results : []).map(function(result) {
        return Object.assign({}, result, { whitelist: copySnapshotWhitelist(result && result.whitelist) });
    });
}

function copySnapshotWhitelist(whitelist) {
    return (Array.isArray(whitelist) ? whitelist : []).map(function(entry) {
        return { slot: entry.slot, ip: entry.ip };
    });
}

function readSnapshot() {
    try {
        const raw = readStore(getStoreKey('snapshot'));
        if (!raw) return null;
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? value : null;
    } catch (error) {
        return null;
    }
}

function getStoreKey(suffix) {
    const scope = [
        rawArgs.host || DEFAULT_HOST,
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

function readStore(key) {
    try {
        if (typeof $persistentStore === 'undefined' || !$persistentStore) return null;
        return $persistentStore.read(key);
    } catch (error) {
        return null;
    }
}

function writeStore(value, key) {
    try {
        if (typeof $persistentStore === 'undefined' || !$persistentStore) return false;
        return $persistentStore.write(String(value), key);
    } catch (error) {
        return false;
    }
}

// ============================================================
// Panel
// ============================================================

function renderPanel(snapshot) {
    const triggerLabel = snapshot.trigger === 'cron'
        ? '定时任务'
        : (snapshot.trigger === 'panel'
            ? 'Panel 手动刷新'
            : (snapshot.trigger === 'manual'
                ? '手动更新'
                : (snapshot.trigger === 'panel-auto' ? 'Panel 自动刷新' : '网络变化')));
    const publicInfo = snapshot.publicInfo && typeof snapshot.publicInfo === 'object'
        ? snapshot.publicInfo
        : {};
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
        `触发方式: ${triggerLabel}`,
        `更新时间: ${formatDate(snapshot.updatedAt)}`
    ];

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
        title: `PO0 防火墙白名单 · ${snapshot.summary || '失败'}`,
        content: lines.join('\n'),
        style: snapshot.style || 'info'
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

function notifyManualResult(snapshot) {
    try {
        if (typeof $notification === 'undefined' || !$notification || typeof $notification.post !== 'function') return;
        const requestLines = (snapshot.results || []).slice(0, 5).map(function (result) {
            return `${result.label}: ${result.statusText || (result.success ? '成功' : '失败')}`;
        });
        const body = [
            snapshot.network && snapshot.network.label ? snapshot.network.label : '未知网络',
            snapshot.note || '',
            requestLines.join('\n')
        ].filter(Boolean).join('\n');
        $notification.post(`PO0W 白名单 · ${snapshot.summary || '失败'}`, '', body);
    } catch (error) { /* noop */ }
}

function finishPanel(result) {
    $done({
        title: result.title,
        content: result.content,
        style: result.style || 'info'
    });
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
        buildConfig,
        parseBooleanArg,
        normalizeHost,
        parseTokenList,
        parseList,
        getNetworkInfo,
        getPrimaryInterfaces,
        isCellularInterface,
        getDirectInfo,
        parse126PublicInfo,
        parseBilibiliPublicInfo,
        parseIPIPPublicInfo,
        createPublicInfo,
        formatCarrierLabel,
        normalizeLocationPart,
        normalizeISP,
        isValidIPAddress,
        createRequestResult,
        createCachedMatchResult,
        findPreviousRequestResultInSnapshot,
        getWhitelistSlotIP,
        isSameIPAddress,
        readSlotCache,
        findSlotCacheResult,
        updateSlotCacheFromResults,
        getSlotCacheEntryKey,
        normalizeWhitelist,
        renderPanel,
        hashString
    };
}

if (typeof $done === 'function') start();
