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
        console.log(`[${SCRIPT_NAME}] ${snapshot.note}`);
        return snapshot;
    }

    if (skippedSSID) {
        console.log(`[${SCRIPT_NAME}] 手动更新忽略 skip_ssids，强制更新非蜂窝 Tokens`);
    }

    const selected = network.type === 'cellular' ? cfg.cellularTokens : cfg.wifiTokens;
    const groupName = network.type === 'cellular'
        ? '蜂窝'
        : (network.ssid ? 'Wi-Fi' : '非蜂窝');

    if (!selected.length) {
        const snapshot = createSnapshot({
            status: 'success',
            summary: '成功',
            network,
            trigger: cfg.trigger,
            note: `未配置 ${network.type === 'cellular' ? 'cellular_tokens' : 'wifi_tokens'}，无需请求`,
            results: []
        });
        writeSnapshot(snapshot);
        console.log(`[${SCRIPT_NAME}] ${snapshot.note}`);
        return snapshot;
    }

    const tasks = selected.map(function (item) {
        if (!item.valid) {
            return Promise.resolve(createRequestFailure(item, groupName, item.error));
        }
        return requestWhitelist(cfg.host, item, groupName);
    });
    const results = await Promise.all(tasks);
    const successCount = results.filter(function (result) { return result.success; }).length;
    const failureCount = results.length - successCount;
    let status = 'success';
    let summary = '成功';

    if (successCount === 0) {
        status = 'failure';
        summary = '失败';
    } else if (failureCount > 0) {
        status = 'partial';
        summary = '部分失败';
    }

    const snapshot = createSnapshot({
        status,
        summary,
        network,
        trigger: cfg.trigger,
        note: `${successCount}/${results.length} 个请求成功`,
        results
    });
    writeSnapshot(snapshot);
    console.log(`[${SCRIPT_NAME}] ${network.label}：${summary}，${snapshot.note}`);
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
        trigger: normalizeTrigger(args.trigger, args.mode)
    };
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
                ? `有线或非蜂窝网络（本地 IP: ${wiredAddress}）`
                : `Wi-Fi（SSID: ${ssid}）`
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
            ? `Wi-Fi（SSID: ${ssid}）`
            : (interfaces.length
                ? `非蜂窝网络（接口: ${interfaces.join(' / ')}）`
                : '非蜂窝网络（接口未知）')
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
    const previous = findPreviousRequestResult(item, label);
    const hasPreviousData = previous && hasUsableRequestData(previous);

    return {
        label,
        requestKey: getRequestKey(item.token),
        slot: item.slot,
        success: true,
        statusText: '已存在',
        detail: hasPreviousData
            ? '当前 IP 已存在于其他 slot；当前 IP 和白名单沿用上次结果'
            : '当前 IP 已存在于其他 slot；API 未返回当前 IP 和白名单',
        error: '',
        currentIp: hasPreviousData && previous.currentIp ? previous.currentIp : '-',
        whitelist: hasPreviousData && Array.isArray(previous.whitelist) ? previous.whitelist : []
    };
}

function findPreviousRequestResult(item, label) {
    const snapshot = readSnapshot();
    if (!snapshot) return null;

    const usableResults = collectUsableResults(snapshot);
    const requestKey = getRequestKey(item.token);
    const sameToken = usableResults.find(function (result) {
        return result.requestKey && result.requestKey === requestKey;
    });
    if (sameToken) return sameToken;

    const exact = usableResults.find(function (result) {
        return result.label === label;
    });
    return exact || usableResults[0] || null;
}

function hasUsableRequestData(result) {
    return Boolean(result) && (
        (result.currentIp && result.currentIp !== '-') ||
        (Array.isArray(result.whitelist) && result.whitelist.length > 0)
    );
}

function createRequestFailure(item, groupName, error) {
    return {
        label: formatRequestLabel(groupName, item),
        requestKey: item.token ? getRequestKey(item.token) : '',
        slot: item.slot,
        success: false,
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
        version: 3,
        status: options.status,
        summary: options.summary,
        network: options.network,
        trigger: options.trigger,
        note: options.note || '',
        results: options.results || [],
        lastRequestResults: options.lastRequestResults || [],
        lastRequestUpdatedAt: Number(options.lastRequestUpdatedAt || 0),
        lastUsableResults: options.lastUsableResults || [],
        updatedAt: Date.now()
    };
}

function createSkippedSnapshot(network, trigger) {
    const previous = readSnapshot();
    const note = '命中 SKIP，已跳过';
    const previousRequest = getPreviousRequestDisplay(previous);
    if (!previousRequest) {
        return createSnapshot({
            status: 'success',
            summary: '成功',
            network,
            trigger,
            note: `${note}；暂无上一次请求结果`,
            results: []
        });
    }

    return Object.assign({}, previous, {
        network,
        trigger,
        note: `${note}；请求结果沿用上一次`,
        results: previousRequest.results,
        updatedAt: previousRequest.updatedAt
    });
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
        const previous = readSnapshot();
        const currentResults = Array.isArray(snapshot.results) ? snapshot.results : [];
        const previousRequest = getPreviousRequestDisplay(previous);
        snapshot.version = 3;

        if (currentResults.length > 0) {
            snapshot.lastRequestResults = copyRequestResults(currentResults);
            snapshot.lastRequestUpdatedAt = Number(snapshot.updatedAt || Date.now());
        } else {
            snapshot.lastRequestResults = previousRequest
                ? copyRequestResults(previousRequest.results)
                : [];
            snapshot.lastRequestUpdatedAt = previousRequest ? previousRequest.updatedAt : 0;
        }

        snapshot.lastUsableResults = mergeUsableResultHistory(snapshot, previous);
        const safeSnapshot = sanitizeSnapshotForStorage(snapshot);
        const saved = $prefs.setValueForKey(JSON.stringify(safeSnapshot), getStoreKey('snapshot'));
        if (!saved) console.log(`[${SCRIPT_NAME}] 保存状态失败: $prefs.setValueForKey 返回 false`);
    } catch (error) {
        console.log(`[${SCRIPT_NAME}] 保存状态失败: ${sanitizeAllTokens(getErrorMessage(error))}`);
    }
}

function readSnapshot() {
    try {
        const raw = $prefs.valueForKey(getStoreKey('snapshot'));
        if (!raw) return null;
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return value && typeof value === 'object' ? value : null;
    } catch (error) {
        return null;
    }
}

function sanitizeSnapshotForStorage(snapshot) {
    const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return {
        version: 3,
        status: String(value.status || 'failure'),
        summary: sanitizeAllTokens(value.summary || '失败'),
        network: copyNetworkInfo(value.network),
        trigger: String(value.trigger || 'event'),
        note: sanitizeAllTokens(value.note || ''),
        results: copyRequestResults(value.results),
        lastRequestResults: copyRequestResults(value.lastRequestResults),
        lastRequestUpdatedAt: Number(value.lastRequestUpdatedAt || 0),
        lastUsableResults: copyRequestResults(value.lastUsableResults),
        updatedAt: Number(value.updatedAt || 0)
    };
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

function getPreviousRequestDisplay(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const current = Array.isArray(snapshot.results) ? snapshot.results : [];
    if (current.length > 0) {
        return {
            results: copyRequestResults(current),
            updatedAt: Number(snapshot.updatedAt || 0)
        };
    }

    const stored = Array.isArray(snapshot.lastRequestResults)
        ? snapshot.lastRequestResults
        : [];
    if (!stored.length) return null;
    return {
        results: copyRequestResults(stored),
        updatedAt: Number(snapshot.lastRequestUpdatedAt || snapshot.updatedAt || 0)
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

function collectUsableResults(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return [];
    const current = Array.isArray(snapshot.results) ? snapshot.results : [];
    const history = Array.isArray(snapshot.lastUsableResults)
        ? snapshot.lastUsableResults
        : [];
    return current.filter(function (result) {
        return result && result.success && hasUsableRequestData(result);
    }).concat(history.filter(hasUsableRequestData));
}

function mergeUsableResultHistory(snapshot, previous) {
    const current = Array.isArray(snapshot.results)
        ? snapshot.results.filter(function (result) {
            return result && result.success && hasUsableRequestData(result);
        })
        : [];
    const previousResults = collectUsableResults(previous);
    const merged = [];
    const seen = new Set();

    current.concat(previousResults).forEach(function (result) {
        const key = getHistoryResultKey(result);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push({
            label: result.label || '',
            requestKey: result.requestKey || '',
            slot: result.slot === null || typeof result.slot === 'undefined'
                ? '?'
                : String(result.slot),
            success: true,
            statusText: result.statusText || '成功',
            detail: result.detail || '',
            error: '',
            currentIp: result.currentIp || '-',
            whitelist: Array.isArray(result.whitelist) ? result.whitelist : []
        });
    });

    return copyRequestResults(merged.slice(0, 50));
}

function getHistoryResultKey(result) {
    const value = result && typeof result === 'object' ? result : {};
    if (value.requestKey) return `token:${value.requestKey}`;
    return `${String(value.label || '')}|${String(value.slot || '?')}`;
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
    const lines = [
        `API 请求结果: ${snapshot.summary || '失败'}`,
        `当前网络环境: ${network.label || '未知'}`
    ];

    if (network.label !== lastNetwork) lines.push(`上次请求网络: ${lastNetwork}`);
    lines.push(`触发方式: ${formatTrigger(snapshot.trigger)}`);
    lines.push(`更新时间: ${formatDate(snapshot.updatedAt)}`);
    if (snapshot.note) lines.push(`说明: ${snapshot.note}`);

    (snapshot.results || []).forEach(function (result) {
        lines.push('');
        lines.push(`【${result.label}】`);
        lines.push(`请求结果: ${result.statusText || (result.success ? '成功' : '失败')}`);
        if (result.detail) lines.push(`说明: ${result.detail}`);
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
        parseArgs,
        parseSourcePath,
        parseEnvironmentVariables,
        buildConfig,
        normalizeHost,
        parseTokenList,
        parseList,
        getNetworkInfo,
        getPrimaryInterfaces,
        isCellularInterface,
        hasCellularInfo,
        isIPAddress,
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
