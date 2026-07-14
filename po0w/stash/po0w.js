// =============================================================
// Stash 原生 PO0W 防火墙白名单脚本
//
// - cron：每 30 分钟更新当前网络对应的 token 组
// - tile：自动刷新时只读取缓存，不发起 API 请求
// - tile button：手动强制更新；非蜂窝网络下忽略 skip_ssids
//
// Stash 暂无 network-changed 脚本触发类型，因此网络分类仅用于
// 定时任务和 Tile 手动更新时选择 cellular_tokens / wifi_tokens。
// =============================================================

const SCRIPT_NAME = 'PO0W';
const DEFAULT_HOST = '124.221.69.228';
const REQUEST_TIMEOUT = 10;
const PUBLIC_IP_TIMEOUT = 4;
const DEFAULT_CACHE_MAX_AGE_HOURS = 6;
const PUBLIC_IP_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const STORE_PREFIX = 'po0w:firewall:stash';
const DIRECT_HEADER = 'X-Stash-Selected-Proxy';

async function start(root) {
    const runtime = root || getGlobalRoot();
    const args = parseArgs(getArgument(runtime));
    const mode = detectMode(runtime, args);

    if (mode === 'tile') {
        return runTile(runtime, args);
    }

    const trigger = mode === 'manual' ? 'manual' : detectUpdateTrigger(runtime, args);
    try {
        const cfg = buildConfig(args, trigger);
        const snapshot = await runUpdate(runtime, args, cfg);
        if (trigger === 'manual') notifyManualResult(runtime, snapshot);
        finish(runtime);
        return snapshot;
    } catch (error) {
        const snapshot = createFailureSnapshot(runtime, args, error, trigger);
        writeSnapshot(runtime, args, snapshot);
        log(runtime, `[${SCRIPT_NAME}] ${snapshot.note}`);
        if (trigger === 'manual') notifyManualResult(runtime, snapshot);
        finish(runtime);
        return snapshot;
    }
}

async function runTile(root, args) {
    // `$trigger` 尚未出现在 Stash 官方文档中。已提供该字段的版本用
    // button 表示手动刷新；未提供该字段的版本也按手动刷新处理，避免
    // 不设 interval 的 Tile 点击后只读缓存而无法更新。
    const tileTrigger = getTileTrigger(root);
    const isManualRefresh = tileTrigger === 'button' || tileTrigger === '';

    if (!isManualRefresh) {
        try {
            buildConfig(args, 'tile');
            const snapshot = readSnapshot(root, args) || createEmptySnapshot(root);
            finishTile(root, renderTile(snapshot));
            return snapshot;
        } catch (error) {
            const snapshot = createFailureSnapshot(root, args, error, 'tile');
            finishTile(root, renderTile(snapshot));
            return snapshot;
        }
    }

    try {
        const cfg = buildConfig(args, 'manual');
        const snapshot = await runUpdate(root, args, cfg);
        notifyManualResult(root, snapshot);
        finishTile(root, renderTile(snapshot));
        return snapshot;
    } catch (error) {
        const snapshot = createFailureSnapshot(root, args, error, 'manual');
        writeSnapshot(root, args, snapshot);
        log(root, `[${SCRIPT_NAME}] ${snapshot.note}`);
        notifyManualResult(root, snapshot);
        finishTile(root, renderTile(snapshot));
        return snapshot;
    }
}

async function runUpdate(root, args, cfg) {
    const network = getNetworkInfo(root);
    const skippedSSID = network.type === 'wifi'
        && Boolean(network.ssid)
        && cfg.skipSSIDs.includes(network.ssid);

    if (skippedSSID && cfg.trigger !== 'manual') {
        const snapshot = createSkippedSnapshot(root, args, network, cfg.trigger);
        writeSnapshot(root, args, snapshot);
        log(root, `[${SCRIPT_NAME}] ${network.label}：${snapshot.summary}${snapshot.note ? `，${snapshot.note}` : ''}`);
        return snapshot;
    }

    if (skippedSSID) {
        log(root, `[${SCRIPT_NAME}] 手动更新忽略 skip_ssids，强制更新 Wi-Fi tokens`);
    }

    const selected = network.type === 'cellular' ? cfg.cellularTokens : cfg.wifiTokens;
    const groupName = network.type === 'cellular'
        ? '蜂窝'
        : (network.ssid ? 'Wi-Fi' : '非蜂窝');
    const publicInfo = await getDirectInfo(root);

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
        writeSnapshot(root, args, snapshot);
        log(root, `[${SCRIPT_NAME}] ${network.label}：${snapshot.summary}`);
        return snapshot;
    }

    const forceRefresh = cfg.trigger === 'manual';
    const tokenCache = readTokenCache(root, args);
    const tasks = selected.map(function(item) {
        if (!item.valid) {
            return Promise.resolve(createRequestFailure(item, groupName, item.error, false));
        }
        const previous = findCachedRequestResult(tokenCache, item);
        const cacheExpired = Boolean(cfg.cacheDiff && !forceRefresh && previous &&
            isTokenCacheExpired(previous.updatedAt, cfg.cacheMaxAgeHours));
        const cacheMatched = Boolean(cfg.cacheDiff && !forceRefresh && publicInfo.ip &&
            previous && !cacheExpired && (cfg.cacheDiffOnlyCurrentSlot
                ? isSameIPAddress(publicInfo.ip, getWhitelistSlotIP(previous, item.slot))
                : hasWhitelistIPAddress(previous, publicInfo.ip)));
        if (cacheMatched) {
            const cacheStatus = cfg.cacheDiffOnlyCurrentSlot ? 'IP 未变化' : 'IP 已存在';
            return Promise.resolve(createCachedMatchResult(item, groupName, previous, cacheStatus));
        }
        return requestWhitelist(root, args, cfg.host, item, groupName).then(function(result) {
            return markCacheExpiredResult(result, cacheExpired);
        });
    });
    const results = await Promise.all(tasks);
    updateTokenCacheFromResults(root, args, tokenCache, selected, results);
    const successCount = results.filter(function(result) { return result.success; }).length;
    const failureCount = results.length - successCount;
    const expiredCacheCount = results.filter(function(result) { return result.cacheExpired; }).length;
    let status = 'success';
    let summary = '成功';
    let style = 'good';
    const allCacheHits = results.length > 0 && results.every(function(result) { return result && result.cacheHit; });

    if (allCacheHits) {
        summary = cfg.cacheDiffOnlyCurrentSlot ? '未请求（IP 未变化）' : '未请求（IP 已存在）';
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
    writeSnapshot(root, args, snapshot);
    log(root, `[${SCRIPT_NAME}] ${network.label}：${summary}${snapshot.note ? `，${snapshot.note}` : ''}`);
    return snapshot;
}

// ============================================================
// 参数与运行模式
// ============================================================

function getArgument(root) {
    try {
        return root && typeof root.$argument !== 'undefined'
            ? String(root.$argument || '')
            : '';
    } catch (error) {
        return '';
    }
}

function parseArgs(argument) {
    const result = {};
    if (!argument) return result;

    String(argument).split('&').forEach(function(pair) {
        const index = pair.indexOf('=');
        if (index <= 0) return;
        const key = pair.substring(0, index).trim();
        const value = decodeArgValue(pair.substring(index + 1).trim());
        if (key) result[key] = value;
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

function detectMode(root, args) {
    const requested = String(args.mode || '').trim().toLowerCase();
    if (requested === 'tile') return 'tile';
    if (requested === 'manual') return 'manual';
    if (requested === 'update') return 'update';
    return getScriptType(root) === 'tile' ? 'tile' : 'update';
}

function detectUpdateTrigger(root, args) {
    const requested = String(args.trigger || '').trim().toLowerCase();
    if (requested === 'manual') return 'manual';
    if (requested === 'cron' || requested === 'schedule') return 'cron';
    return getScriptType(root) === 'cron' ? 'cron' : 'update';
}

function getScriptType(root) {
    try {
        const script = root && root.$script && typeof root.$script === 'object'
            ? root.$script
            : {};
        return String(script.type || '').trim().toLowerCase();
    } catch (error) {
        return '';
    }
}

function getTileTrigger(root) {
    try {
        return root && typeof root.$trigger !== 'undefined'
            ? String(root.$trigger || '').trim().toLowerCase()
            : '';
    } catch (error) {
        return '';
    }
}

function buildConfig(args, trigger) {
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
        cacheDiff: parseBooleanArg(args.cache_diff, true, 'cache_diff'),
        cacheDiffOnlyCurrentSlot: parseBooleanArg(
            args.cache_diff_only_current_slot,
            true,
            'cache_diff_only_current_slot'
        ),
        cacheMaxAgeHours: parsePositiveNumberArg(args.cache_max_age_hours, DEFAULT_CACHE_MAX_AGE_HOURS),
        trigger: trigger || 'update'
    };
}

function parseBooleanArg(value, defaultValue, name) {
    const text = cleanText(value).toLowerCase();
    if (!text) return Boolean(defaultValue);
    if (text === 'true') return true;
    if (text === 'false') return false;
    throw new Error(`${name || 'cache_diff'} 必须是 true 或 false`);
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

// ============================================================
// 网络环境
// ============================================================

function getNetworkInfo(root) {
    const network = getNetwork(root);
    const interfaces = getPrimaryInterfaces(network);
    const ssid = getCurrentSSID(root, network);
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

function getNetwork(root) {
    try {
        return root && root.$network && typeof root.$network === 'object'
            ? root.$network
            : {};
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

    candidates.forEach(function(candidate) {
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

function getCurrentSSID(root, network) {
    try {
        const value = network && typeof network === 'object' ? network : {};
        if (value.wifi && value.wifi.ssid) {
            return String(value.wifi.ssid).trim();
        }

        const environment = root && root.$environment && typeof root.$environment === 'object'
            ? root.$environment
            : {};
        if (environment.ssid) return String(environment.ssid).trim();
        if (environment.wifi && environment.wifi.ssid) {
            return String(environment.wifi.ssid).trim();
        }
    } catch (error) { /* noop */ }
    return '';
}

// ============================================================
// DIRECT 公网 IP 与运营商查询
// ============================================================

async function getDirectInfo(root) {
    const providers = [
        { name: '126', url: 'https://ipservice.ws.126.net/locate/api/getLocByIp', parse: parse126PublicInfo },
        { name: 'BILI', url: 'https://api.bilibili.com/x/web-interface/zone', parse: parseBilibiliPublicInfo },
        { name: 'IPIP', url: 'https://myip.ipip.net/json', parse: parseIPIPPublicInfo }
    ];
    const errors = [];
    for (let index = 0; index < providers.length; index++) {
        const provider = providers[index];
        try {
            const data = await requestPublicInfo(root, provider.url);
            const parsed = provider.parse(data);
            if (!parsed || !isValidIPAddress(parsed.ip)) throw new Error('响应中缺少有效公网 IP');
            const info = createPublicInfo(Object.assign({}, parsed, { provider: provider.name }));
            log(root, `[${SCRIPT_NAME}] 公网 IP: ${info.ip}（${info.provider}），运营商: ${info.carrier || '-'}`);
            return info;
        } catch (error) {
            const message = getErrorMessage(error);
            errors.push(`${provider.name}: ${message}`);
            log(root, `[${SCRIPT_NAME}] ${provider.name} 公网 IP 查询失败: ${message}`);
        }
    }
    return createPublicInfo({ error: errors.join('；') || '公网 IP 查询失败' });
}

function requestPublicInfo(root, url) {
    return new Promise(function(resolve, reject) {
        const client = root && root.$httpClient;
        if (!client || typeof client.get !== 'function') {
            reject(new Error('Stash $httpClient 不可用'));
            return;
        }
        client.get({
            url,
            headers: {
                Accept: 'application/json',
                'User-Agent': PUBLIC_IP_USER_AGENT,
                [DIRECT_HEADER]: encodeURIComponent('DIRECT')
            },
            timeout: PUBLIC_IP_TIMEOUT
        }, function(error, response, body) {
            if (error) {
                reject(new Error(getErrorMessage(error)));
                return;
            }
            const status = response && Number(response.status || response.statusCode || 0);
            if (status < 200 || status >= 300) {
                reject(new Error(`HTTP ${status || '未知状态'}`));
                return;
            }
            const parsed = parseResponseJSON(body);
            if (!parsed.ok) {
                reject(new Error('响应不是有效 JSON'));
                return;
            }
            resolve(parsed.data);
        });
    });
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

function requestWhitelist(root, args, host, item, groupName) {
    const url = `https://${host}/api/firewall/${encodeURIComponent(item.token)}/add?slot=${encodeURIComponent(item.slot)}`;
    const options = {
        url,
        headers: {
            Accept: 'application/json',
            [DIRECT_HEADER]: encodeURIComponent('DIRECT')
        },
        timeout: REQUEST_TIMEOUT
    };

    return new Promise(function(resolve) {
        const client = root && root.$httpClient;
        if (!client || typeof client.get !== 'function') {
            resolve(createRequestFailure(item, groupName, 'Stash $httpClient 不可用'));
            return;
        }

        try {
            client.get(options, function(error, response, body) {
                if (error) {
                    resolve(createRequestFailure(
                        item,
                        groupName,
                        sanitizeRequestError(error, item.token)
                    ));
                    return;
                }

                const status = response && Number(response.status || response.statusCode || 0);
                const parsed = parseResponseJSON(body);
                const data = parsed.data;

                if (isAlreadyPinnedResponse(data)) {
                    resolve(createAlreadyPinnedResult(root, args, item, groupName));
                    return;
                }

                if (status < 200 || status >= 300) {
                    const responseMessage = data && (data.message || data.error);
                    const detail = responseMessage
                        ? `: ${sanitizeRequestError(formatServerError(responseMessage), item.token)}`
                        : '';
                    resolve(createRequestFailure(
                        item,
                        groupName,
                        `HTTP ${status || '未知状态'}${detail}`
                    ));
                    return;
                }

                if (!parsed.ok) {
                    resolve(createRequestFailure(item, groupName, 'API 响应不是有效 JSON'));
                    return;
                }

                resolve(createRequestResult(item, groupName, data));
            });
        } catch (error) {
            resolve(createRequestFailure(
                item,
                groupName,
                sanitizeRequestError(error, item.token)
            ));
        }
    });
}

function parseResponseJSON(body) {
    if (body && typeof body === 'object') {
        return { ok: true, data: body };
    }
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
    return Number(data.code) === 403
        && /^IP is already pinned to another slot\.?$/i.test(message);
}

function createAlreadyPinnedResult(root, args, item, groupName) {
    const label = formatRequestLabel(groupName, item);
    const strictPrevious = findCachedRequestResult(readTokenCache(root, args), item);
    const snapshot = readSnapshot(root, args);
    const previous = strictPrevious || findPreviousRequestResultInSnapshot(snapshot, args, item, label, true);
    const hasPreviousData = hasUsableRequestData(previous);

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
        whitelist: hasPreviousData && Array.isArray(previous.whitelist)
            ? previous.whitelist
            : []
    };
}

function createCachedMatchResult(item, groupName, previous, statusText) {
    return {
        label: formatRequestLabel(groupName, item),
        requestKey: getRequestKey(item.token),
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

function findPreviousRequestResultInSnapshot(snapshot, args, item, label, allowFallback) {
    if (!snapshot) return null;

    const usableResults = (Array.isArray(snapshot.results) ? snapshot.results : []).filter(hasUsableRequestData);
    const exact = usableResults.find(function(result) {
        return result.label === label;
    });
    if (exact) return exact;

    const equivalentLabels = getEquivalentRequestLabels(args, item.token);
    const equivalent = usableResults.find(function(result) {
        return equivalentLabels.includes(result.label);
    });
    if (equivalent) return equivalent;

    const sameSlot = usableResults.find(function(result) {
        return String(result.slot) === String(item.slot);
    });
    return sameSlot || (allowFallback ? usableResults[0] : null) || null;
}

function getEquivalentRequestLabels(args, token) {
    const labels = [];
    [
        { value: args.cellular_tokens, type: 'cellular', groupNames: ['蜂窝'] },
        { value: args.wifi_tokens, type: 'wifi', groupNames: ['Wi-Fi', '非蜂窝'] }
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
        (result.currentIp && result.currentIp !== '-')
        || (Array.isArray(result.whitelist) && result.whitelist.length > 0)
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
        requestKey: item.token ? getRequestKey(item.token) : '',
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

function getRequestKey(token) {
    return hashString(`token:${String(token || '')}`);
}

function normalizeWhitelist(whitelist) {
    return whitelist.map(function(entry) {
        const value = entry && typeof entry === 'object' ? entry : {};
        return {
            slot: value.slot === null || typeof value.slot === 'undefined'
                ? '?'
                : String(value.slot),
            ip: value.ip === null || typeof value.ip === 'undefined' || value.ip === ''
                ? '-'
                : String(value.ip)
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
    return truncateMessage(message);
}

function sanitizeAllTokens(value, args) {
    let message = getErrorMessage(value);
    collectRawTokens(args).forEach(function(token) {
        message = sanitizeRequestError(message, token);
    });
    return truncateMessage(message);
}

function collectRawTokens(args) {
    const tokens = [];
    [args.cellular_tokens, args.wifi_tokens].forEach(function(value) {
        String(value || '').split('|').forEach(function(part) {
            const trimmed = part.trim();
            const separator = trimmed.lastIndexOf('@');
            const token = separator >= 0 ? trimmed.substring(0, separator).trim() : '';
            if (token && !tokens.includes(token)) tokens.push(token);
        });
    });
    return tokens;
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
    return truncateMessage(String(text || 'API 返回失败').replace(/\s+/g, ' ').trim());
}

function truncateMessage(value) {
    const text = String(value || '');
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

function createEmptySnapshot(root) {
    return {
        version: 2,
        status: 'empty',
        summary: '暂无',
        style: 'info',
        network: getNetworkInfo(root),
        trigger: 'tile',
        note: '等待定时任务，或点击 Tile 刷新按钮手动更新',
        publicInfo: createPublicInfo({}),
        results: [],
        updatedAt: 0
    };
}

function createSkippedSnapshot(root, args, network, trigger) {
    const previous = readSnapshot(root, args);
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
        results: copyRequestResults(previousResults, args),
        updatedAt: Number(previous.updatedAt || 0)
    };
}

function createFailureSnapshot(root, args, error, trigger) {
    return createSnapshot({
        status: 'failure',
        summary: '失败',
        style: 'error',
        network: getNetworkInfo(root),
        trigger: trigger || 'update',
        note: `参数或运行错误: ${sanitizeAllTokens(error, args)}`,
        results: []
    });
}

function readSnapshot(root, args) {
    return normalizeSnapshotForRead(readStoredJSON(root, getStoreKey(args, 'snapshot')), args);
}

function writeSnapshot(root, args, snapshot) {
    try {
        mergeSnapshotResultsWithPrevious(snapshot, readSnapshot(root, args), args);
        const safeSnapshot = sanitizeSnapshotForStorage(snapshot, args);
        const saved = writeStoredJSON(root, getStoreKey(args, 'snapshot'), safeSnapshot);
        if (saved === false) {
            log(root, `[${SCRIPT_NAME}] 保存状态失败: persistentStore.write 返回 false`);
        }
        return saved !== false;
    } catch (error) {
        log(root, `[${SCRIPT_NAME}] 保存状态失败: ${sanitizeAllTokens(error, args)}`);
        return false;
    }
}

function mergeSnapshotResultsWithPrevious(snapshot, previous, args) {
    const previousResults = previous && Array.isArray(previous.results) ? previous.results : [];
    if (!previousResults.length) return snapshot;
    const currentResults = snapshot && Array.isArray(snapshot.results) ? snapshot.results : [];
    if (!currentResults.length) {
        snapshot.results = copyRequestResults(previousResults, args);
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

function sanitizeSnapshotForStorage(snapshot, args) {
    const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return {
        version: 2,
        status: String(value.status || 'failure'),
        summary: sanitizeAllTokens(value.summary || '失败', args),
        style: String(value.style || 'error'),
        network: copyNetworkInfo(value.network),
        trigger: String(value.trigger || 'update'),
        note: sanitizeAllTokens(value.note || '', args),
        publicInfo: copyPublicInfo(value.publicInfo),
        results: copyRequestResults(value.results, args),
        updatedAt: Number(value.updatedAt || 0)
    };
}

function normalizeSnapshotForRead(snapshot, args) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const currentResults = Array.isArray(snapshot.results) ? snapshot.results : [];
    const legacyResults = Array.isArray(snapshot.lastRequestResults) ? snapshot.lastRequestResults : [];
    const useLegacyResults = !currentResults.length && legacyResults.length > 0;
    return sanitizeSnapshotForStorage({
        status: snapshot.status,
        summary: snapshot.summary,
        style: snapshot.style,
        network: snapshot.network,
        trigger: snapshot.trigger,
        note: snapshot.note,
        publicInfo: snapshot.publicInfo,
        results: useLegacyResults ? legacyResults : currentResults,
        updatedAt: useLegacyResults
            ? (snapshot.lastRequestUpdatedAt || snapshot.updatedAt || 0)
            : (snapshot.updatedAt || 0)
    }, args);
}

function copyPublicInfo(publicInfo) {
    const value = publicInfo && typeof publicInfo === 'object' ? publicInfo : {};
    return createPublicInfo({
        ip: value.ip,
        provider: value.provider,
        country: value.country,
        province: value.province,
        city: value.city,
        isp: value.isp,
        error: value.error
    });
}

function copyNetworkInfo(network) {
    const value = network && typeof network === 'object' ? network : {};
    return {
        type: value.type === 'cellular' ? 'cellular' : 'wifi',
        ssid: value.ssid ? String(value.ssid) : '',
        interfaces: Array.isArray(value.interfaces)
            ? value.interfaces.map(function(item) { return String(item); })
            : [],
        label: value.label ? String(value.label) : '未知网络'
    };
}

function copyRequestResults(results, args) {
    return (Array.isArray(results) ? results : []).map(function(result) {
        const value = result && typeof result === 'object' ? result : {};
        return {
            label: sanitizeAllTokens(value.label || '', args || {}),
            requestKey: value.requestKey ? String(value.requestKey) : '',
            slot: value.slot === null || typeof value.slot === 'undefined'
                ? '?'
                : String(value.slot),
            success: Boolean(value.success),
            apiRequested: Boolean(value.apiRequested),
            cacheHit: Boolean(value.cacheHit),
            cacheComparable: value.cacheComparable !== false,
            whitelistReceived: Boolean(value.whitelistReceived),
            statusText: sanitizeAllTokens(value.statusText || '', args || {}),
            detail: sanitizeAllTokens(value.detail || '', args || {}),
            error: sanitizeAllTokens(value.error || '', args || {}),
            currentIp: value.currentIp ? String(value.currentIp) : '-',
            whitelist: Array.isArray(value.whitelist)
                ? value.whitelist.map(function(entry) {
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

function readTokenCache(root, args) {
    const stored = readStoredJSON(root, getStoreKey(args, 'token-cache'));
    if (stored && stored.entries && typeof stored.entries === 'object') {
        return { version: 2, entries: stored.entries };
    }
    const migrated = migrateLegacyTokenCache(readStoredJSON(root, getStoreKey(args, 'snapshot')));
    if (Object.keys(migrated.entries).length) writeTokenCache(root, args, migrated);
    return migrated;
}

function writeTokenCache(root, args, cache) {
    try {
        const saved = writeStoredJSON(root, getStoreKey(args, 'token-cache'), {
            version: 2,
            entries: cache && cache.entries && typeof cache.entries === 'object' ? cache.entries : {}
        });
        if (saved === false) log(root, `[${SCRIPT_NAME}] 保存 token 缓存失败`);
        return saved !== false;
    } catch (error) {
        log(root, `[${SCRIPT_NAME}] 保存 token 缓存失败: ${sanitizeAllTokens(error, args)}`);
        return false;
    }
}

function updateTokenCacheFromResults(root, args, cache, items, results) {
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
    if (changed) writeTokenCache(root, args, value);
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

function readStoredJSON(root, key) {
    try {
        const store = root && root.$persistentStore;
        if (!store || typeof store.read !== 'function') return null;
        const raw = store.read(key);
        if (!raw) return null;
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return value && typeof value === 'object' ? value : null;
    } catch (error) {
        return null;
    }
}

function writeStoredJSON(root, key, value) {
    const store = root && root.$persistentStore;
    if (!store || typeof store.write !== 'function') return false;
    return store.write(JSON.stringify(value), key);
}

function getStoreKey(args, suffix) {
    const value = args && typeof args === 'object' ? args : {};
    const scope = [
        String(value.host || DEFAULT_HOST)
            .trim()
            .replace(/^https?:\/\//i, '')
            .replace(/\/+$/, '')
            .toLowerCase(),
        String(value.cellular_tokens || ''),
        String(value.wifi_tokens || ''),
        String(value.skip_ssids || '')
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
// Tile 与通知
// ============================================================

function renderTile(snapshot) {
    const style = snapshot.style || 'info';
    const backgroundColor = style === 'good'
        ? '#2D6A4F'
        : (style === 'alert'
            ? '#9A6700'
            : (style === 'error' ? '#9D2A2A' : '#2B5C8A'));

    return {
        title: `PO0W 防火墙白名单 · ${snapshot.summary || '失败'}`,
        content: formatTileContent(snapshot),
        icon: 'shield.lefthalf.filled',
        backgroundColor
    };
}

function formatTileContent(snapshot) {
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
    if (trigger === 'cron') return '定时任务';
    if (trigger === 'manual') return 'Tile 手动更新';
    if (trigger === 'tile') return 'Tile 状态读取';
    return '自动更新';
}

function notifyManualResult(root, snapshot) {
    try {
        const notification = root && root.$notification;
        if (!notification || typeof notification.post !== 'function') return;
        const requestLines = (snapshot.results || []).slice(0, 5).map(function(result) {
            return `${result.label}: ${result.statusText || (result.success ? '成功' : '失败')}`;
        });
        const body = [
            snapshot.network && snapshot.network.label ? snapshot.network.label : '未知网络',
            snapshot.note || '',
            requestLines.join('\n')
        ].filter(Boolean).join('\n');
        notification.post(
            `PO0W 白名单 · ${snapshot.summary || '失败'}`,
            '',
            body
        );
    } catch (error) { /* noop */ }
}

function finishTile(root, result) {
    finish(root, {
        title: result.title,
        content: result.content,
        icon: result.icon,
        backgroundColor: result.backgroundColor
    });
}

function finish(root, value) {
    try {
        if (root && typeof root.$done === 'function') root.$done(value);
    } catch (error) { /* noop */ }
}

function formatDate(value) {
    if (!value) return '-';
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '-';
    const pad = function(number) { return String(number).padStart(2, '0'); };
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function log(root, message) {
    try {
        const logger = root && root.console ? root.console : console;
        if (logger && typeof logger.log === 'function') logger.log(String(message));
    } catch (error) { /* noop */ }
}

function getErrorMessage(error) {
    return String(error && error.message ? error.message : error);
}

function getGlobalRoot() {
    if (typeof globalThis !== 'undefined') return globalThis;
    return Function('return this')();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        start,
        runUpdate,
        parseArgs,
        buildConfig,
        parseBooleanArg,
        normalizeHost,
        parseTokenList,
        parseList,
        detectMode,
        detectUpdateTrigger,
        getNetworkInfo,
        getPrimaryInterfaces,
        isCellularInterface,
        getDirectInfo,
        createPublicInfo,
        formatCarrierLabel,
        findCachedRequestResult,
        getWhitelistSlotIP,
        isSameIPAddress,
        parseResponseJSON,
        createRequestResult,
        isAlreadyPinnedResponse,
        normalizeWhitelist,
        renderTile,
        formatTileContent,
        hashString,
        getStoreKey
    };
}

const AUTO_ROOT = getGlobalRoot();
if (AUTO_ROOT && typeof AUTO_ROOT.$done === 'function') {
    start(AUTO_ROOT);
}
