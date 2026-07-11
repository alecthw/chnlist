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

    if (network.type === 'unknown') {
        const snapshot = createUnknownNetworkSnapshot(ctx, env, network, cfg.trigger);
        writeSnapshot(ctx, env, snapshot);
        log(ctx, `[${SCRIPT_NAME}] ${snapshot.note}`);
        return snapshot;
    }

    const skippedSSID = network.type === 'wifi' && cfg.skipSSIDs.includes(network.ssid);

    if (skippedSSID && cfg.trigger !== 'manual') {
        const snapshot = createSkippedSnapshot(ctx, env, network, cfg.trigger);
        writeSnapshot(ctx, env, snapshot);
        log(ctx, `[${SCRIPT_NAME}] ${snapshot.note}`);
        return snapshot;
    }

    if (skippedSSID) {
        log(ctx, `[${SCRIPT_NAME}] 手动更新忽略 skip_ssids，强制更新 Wi-Fi tokens`);
    }

    const selected = network.type === 'wifi' ? cfg.wifiTokens : cfg.cellularTokens;
    const groupName = network.type === 'wifi' ? 'Wi-Fi' : '蜂窝';

    if (!selected.length) {
        const snapshot = createSnapshot({
            status: 'success',
            summary: '成功',
            style: 'info',
            network,
            trigger: cfg.trigger,
            note: `未配置 ${network.type === 'wifi' ? 'wifi_tokens' : 'cellular_tokens'}，无需请求`,
            results: []
        });
        writeSnapshot(ctx, env, snapshot);
        log(ctx, `[${SCRIPT_NAME}] ${snapshot.note}`);
        return snapshot;
    }

    const tasks = selected.map(function(item) {
        if (!item.valid) {
            return Promise.resolve(createRequestFailure(item, groupName, item.error));
        }
        return requestWhitelist(ctx, env, cfg.host, item, groupName);
    });
    const results = await Promise.all(tasks);
    const successCount = results.filter(function(result) { return result.success; }).length;
    const failureCount = results.length - successCount;
    let status = 'success';
    let summary = '成功';
    let style = 'good';

    if (successCount === 0) {
        status = 'failure';
        summary = '失败';
        style = 'error';
    } else if (failureCount > 0) {
        status = 'partial';
        summary = '部分失败';
        style = 'alert';
    }

    const snapshot = createSnapshot({
        status,
        summary,
        style,
        network,
        trigger: cfg.trigger,
        note: `${successCount}/${results.length} 个请求成功`,
        results
    });
    writeSnapshot(ctx, env, snapshot);
    log(ctx, `[${SCRIPT_NAME}] ${network.label}：${summary}，${snapshot.note}`);
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
        skip_ssids: String(env.skip_ssids || '')
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
        trigger: normalizeTrigger(env.trigger, env.mode)
    };
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
    const cellular = device.cellular || {};
    const ssid = wifi.ssid === null || typeof wifi.ssid === 'undefined' ? '' : String(wifi.ssid);

    if (ssid.trim()) {
        return { type: 'wifi', ssid, label: `Wi-Fi（SSID: ${ssid}）` };
    }

    const ipv4Interface = device.ipv4 && device.ipv4.interface ? String(device.ipv4.interface) : '';
    const ipv6Interface = device.ipv6 && device.ipv6.interface ? String(device.ipv6.interface) : '';
    const interfaceNames = [ipv4Interface, ipv6Interface].filter(Boolean);
    const hasCellular = Boolean(
        cellular.carrier ||
        cellular.radio ||
        interfaceNames.some(function(name) { return /^pdp_ip\d+$/i.test(name); })
    );
    if (hasCellular) {
        return { type: 'cellular', ssid: '', label: '蜂窝网络' };
    }

    const interfaceLabel = interfaceNames.length ? `（接口: ${interfaceNames.join(' / ')}）` : '';
    return { type: 'unknown', ssid: '', label: `未知网络${interfaceLabel}` };
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
    const previous = findPreviousRequestResult(ctx, env, item, label);
    const hasPreviousData = hasUsableRequestData(previous);

    return {
        label,
        tokenKey: getTokenKey(item.token),
        slot: item.slot,
        success: true,
        statusText: '已存在',
        detail: hasPreviousData
            ? '当前 IP 已存在于其他 slot；IP 和白名单沿用上一次结果'
            : '当前 IP 已存在于其他 slot；未返回当前 IP 和白名单',
        error: '',
        currentIp: hasPreviousData && previous.currentIp ? previous.currentIp : '-',
        whitelist: hasPreviousData && Array.isArray(previous.whitelist) ? previous.whitelist : []
    };
}

function findPreviousRequestResult(ctx, env, item, label) {
    const snapshot = readSnapshot(ctx, env);
    if (!snapshot) return null;

    const usableResults = collectUsableResults(snapshot);
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
    return sameToken || usableResults[0] || null;
}

function getEquivalentRequestLabels(env, token) {
    const labels = [];
    [
        { value: env.cellular_tokens, type: 'cellular', groupName: '蜂窝' },
        { value: env.wifi_tokens, type: 'wifi', groupName: 'Wi-Fi' }
    ].forEach(function(group) {
        parseTokenList(group.value, group.type).forEach(function(item) {
            if (item.valid && item.token === token) {
                labels.push(formatRequestLabel(group.groupName, item));
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

function createRequestFailure(item, groupName, error) {
    return {
        label: formatRequestLabel(groupName, item),
        tokenKey: getTokenKey(item.token),
        slot: item.slot,
        success: false,
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
        version: 3,
        status: options.status,
        summary: options.summary,
        style: options.style,
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

function createEmptySnapshot(ctx) {
    return {
        version: 3,
        status: 'empty',
        summary: '暂无',
        style: 'info',
        network: getNetworkInfo(ctx),
        trigger: 'widget',
        note: '运行“PO0 手动更新”，或等待网络变化和定时任务',
        results: [],
        lastRequestResults: [],
        lastRequestUpdatedAt: 0,
        lastUsableResults: [],
        updatedAt: 0
    };
}

function createUnknownNetworkSnapshot(ctx, env, network, trigger) {
    const previous = readSnapshot(ctx, env);
    const note = '无法识别当前网络，未发起 API 请求';
    const previousRequest = getPreviousRequestDisplay(previous);
    if (!previousRequest) {
        return createSnapshot({
            status: 'failure',
            summary: '失败',
            style: 'error',
            network,
            trigger,
            note,
            results: []
        });
    }

    return Object.assign({}, previous, {
        network,
        trigger,
        results: previousRequest.results,
        updatedAt: previousRequest.updatedAt,
        note: `${note}；请求结果沿用上一次`
    });
}

function createSkippedSnapshot(ctx, env, network, trigger) {
    const previous = readSnapshot(ctx, env);
    const note = `SSID ${network.ssid} 命中 skip_ssids，已跳过`;
    const previousRequest = getPreviousRequestDisplay(previous);
    if (!previousRequest) {
        return createSnapshot({
            status: 'success',
            summary: '成功',
            style: 'info',
            network,
            trigger,
            note: `${note}；暂无上一次请求结果`,
            results: []
        });
    }

    return Object.assign({}, previous, {
        network,
        trigger,
        results: previousRequest.results,
        updatedAt: previousRequest.updatedAt,
        note: `${note}；请求结果沿用上一次`
    });
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
    try {
        const key = getStoreKey(env);
        if (ctx.storage && typeof ctx.storage.getJSON === 'function') {
            const value = ctx.storage.getJSON(key);
            return value && typeof value === 'object' ? value : null;
        }
        const raw = ctx.storage && typeof ctx.storage.get === 'function' ? ctx.storage.get(key) : null;
        if (!raw) return null;
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? value : null;
    } catch (error) {
        return null;
    }
}

function writeSnapshot(ctx, env, snapshot) {
    try {
        const key = getStoreKey(env);
        const previous = readSnapshot(ctx, env);
        const currentResults = Array.isArray(snapshot.results) ? snapshot.results : [];
        const previousRequest = getPreviousRequestDisplay(previous);
        snapshot.version = 3;
        if (currentResults.length > 0) {
            snapshot.lastRequestResults = copyRequestResults(currentResults);
            snapshot.lastRequestUpdatedAt = Number(snapshot.updatedAt || Date.now());
        } else {
            snapshot.lastRequestResults = previousRequest ? copyRequestResults(previousRequest.results) : [];
            snapshot.lastRequestUpdatedAt = previousRequest ? previousRequest.updatedAt : 0;
        }
        snapshot.lastUsableResults = mergeUsableResultHistory(snapshot, previous);
        if (ctx.storage && typeof ctx.storage.setJSON === 'function') {
            ctx.storage.setJSON(key, snapshot);
            return true;
        }
        if (ctx.storage && typeof ctx.storage.set === 'function') {
            ctx.storage.set(key, JSON.stringify(snapshot));
            return true;
        }
    } catch (error) {
        log(ctx, `[${SCRIPT_NAME}] 保存状态失败: ${getErrorMessage(error)}`);
    }
    return false;
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

    const stored = Array.isArray(snapshot.lastRequestResults) ? snapshot.lastRequestResults : [];
    if (!stored.length) return null;
    return {
        results: copyRequestResults(stored),
        updatedAt: Number(snapshot.lastRequestUpdatedAt || snapshot.updatedAt || 0)
    };
}

function copyRequestResults(results) {
    return (Array.isArray(results) ? results : []).map(function(result) {
        return {
            label: result && result.label ? String(result.label) : '',
            tokenKey: result && result.tokenKey ? String(result.tokenKey) : '',
            slot: result && result.slot !== null && typeof result.slot !== 'undefined' ? String(result.slot) : '?',
            success: Boolean(result && result.success),
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

function collectUsableResults(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return [];
    const current = Array.isArray(snapshot.results) ? snapshot.results : [];
    const history = Array.isArray(snapshot.lastUsableResults) ? snapshot.lastUsableResults : [];
    return current.filter(function(result) {
        return result && result.success && hasUsableRequestData(result);
    }).concat(history.filter(hasUsableRequestData));
}

function mergeUsableResultHistory(snapshot, previous) {
    const current = Array.isArray(snapshot.results)
        ? snapshot.results.filter(function(result) {
            return result && result.success && hasUsableRequestData(result);
        })
        : [];
    const previousResults = collectUsableResults(previous);
    const merged = [];
    const seen = new Set();

    current.concat(previousResults).forEach(function(result) {
        const key = getHistoryResultKey(result);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push({
            label: result.label || '',
            tokenKey: result.tokenKey || '',
            slot: result.slot === null || typeof result.slot === 'undefined' ? '?' : String(result.slot),
            success: true,
            statusText: result.statusText || '成功',
            detail: result.detail || '',
            error: '',
            currentIp: result.currentIp || '-',
            whitelist: Array.isArray(result.whitelist) ? result.whitelist : []
        });
    });

    return merged.slice(0, 50);
}

function getHistoryResultKey(result) {
    if (result && result.tokenKey) return `token:${result.tokenKey}`;
    return `label:${result && result.label ? result.label : ''}`;
}

function getTokenKey(token) {
    return token ? hashString(`token:${String(token)}`) : '';
}

function getStoreKey(env) {
    const scope = [
        env.host || DEFAULT_HOST,
        env.cellular_tokens || '',
        env.wifi_tokens || '',
        env.skip_ssids || ''
    ].join('|');
    return `${STORE_PREFIX}:${hashString(scope)}:snapshot`;
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
    const lines = [
        `API 请求结果: ${snapshot.summary || '失败'}`,
        `当前网络环境: ${snapshot.network && snapshot.network.label ? snapshot.network.label : '未知'}`,
        `触发方式: ${formatTrigger(snapshot.trigger)}`,
        `更新时间: ${formatDate(snapshot.updatedAt)}`
    ];

    if (snapshot.note) lines.push(`说明: ${snapshot.note}`);

    (snapshot.results || []).forEach(function(result) {
        lines.push('');
        lines.push(`【${result.label}】`);
        lines.push(`请求结果: ${result.statusText || (result.success ? '成功' : '失败')}`);
        if (result.detail) lines.push(`说明: ${result.detail}`);
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
