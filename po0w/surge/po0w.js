// =============================================================
// Surge PO0 防火墙白名单脚本
//
// - network-changed：按当前网络更新对应 token 组
// - cron：每 30 分钟执行一次
// - panel：点击刷新按钮手动更新；自动刷新只读取最近一轮结果
// =============================================================

const SCRIPT_NAME = 'PO0W';
const DEFAULT_HOST = '124.221.69.228';
const REQUEST_TIMEOUT = 10;
const STORE_PREFIX = 'po0w:firewall';

const rawArgs = parseArgs(getArgument());
const mode = rawArgs.mode || 'update';

function start() {
    if (mode === 'panel') {
        runPanel();
        return;
    }

    runUpdate().then(function () {
        $done();
    }).catch(function (error) {
        const snapshot = createFailureSnapshot(error);
        writeSnapshot(snapshot);
        console.log(`[${SCRIPT_NAME}] ${getErrorMessage(error)}`);
        $done();
    });
}

async function runUpdate() {
    const cfg = buildConfig(rawArgs);
    const network = getNetworkInfo();

    if (network.type === 'wifi' && cfg.skipSSIDs.includes(network.ssid)) {
        const snapshot = createSnapshot({
            status: 'success',
            summary: '成功',
            style: 'info',
            network,
            trigger: cfg.trigger,
            note: `SSID ${network.ssid} 命中 skip_ssids，已跳过`,
            results: []
        });
        writeSnapshot(snapshot);
        console.log(`[${SCRIPT_NAME}] ${snapshot.note}`);
        return snapshot;
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
    writeSnapshot(snapshot);
    console.log(`[${SCRIPT_NAME}] ${network.label}：${summary}，${snapshot.note}`);
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
        trigger: args.trigger === 'cron' ? 'cron' : (args.trigger === 'panel' ? 'panel' : 'event')
    };
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

function getNetworkInfo() {
    const ssid = getCurrentSSID();
    if (ssid) {
        return { type: 'wifi', ssid, label: `Wi-Fi（SSID: ${ssid}）` };
    }
    return { type: 'cellular', ssid: '', label: '蜂窝网络' };
}

function getCurrentSSID() {
    try {
        if (typeof $network !== 'undefined' && $network && $network.wifi && $network.wifi.ssid) {
            return String($network.wifi.ssid);
        }
        if (typeof $environment !== 'undefined' && $environment) {
            if ($environment.ssid) return String($environment.ssid);
            if ($environment.wifi && $environment.wifi.ssid) {
                return String($environment.wifi.ssid);
            }
        }
    } catch (error) { /* noop */ }
    return '';
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
            if (status < 200 || status >= 300) {
                resolve(createRequestFailure(item, groupName, `HTTP ${status || '未知状态'}`));
                return;
            }

            let data;
            try {
                data = JSON.parse(String(body || ''));
            } catch (parseError) {
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
        slot: item.slot,
        success: !error,
        error,
        currentIp: hasCurrentIP ? data.currentIp.trim() : '-',
        whitelist
    };
}

function createRequestFailure(item, groupName, error) {
    return {
        label: formatRequestLabel(groupName, item),
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
            if (secret.length >= 4) message = message.split(secret).join('***');
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

function createSnapshot(options) {
    return {
        version: 1,
        status: options.status,
        summary: options.summary,
        style: options.style,
        network: options.network,
        trigger: options.trigger,
        note: options.note || '',
        results: options.results || [],
        updatedAt: Date.now()
    };
}

function createFailureSnapshot(error, trigger) {
    return createSnapshot({
        status: 'failure',
        summary: '失败',
        style: 'error',
        network: getNetworkInfo(),
        trigger: trigger || (rawArgs.trigger === 'cron' ? 'cron' : (rawArgs.trigger === 'panel' ? 'panel' : 'event')),
        note: `参数或运行错误: ${getErrorMessage(error)}`,
        results: []
    });
}

function writeSnapshot(snapshot) {
    try {
        const saved = writeStore(JSON.stringify(snapshot), getStoreKey('snapshot'));
        if (!saved) console.log(`[${SCRIPT_NAME}] 保存 Panel 结果失败: persistentStore.write 返回 false`);
    } catch (error) {
        console.log(`[${SCRIPT_NAME}] 保存 Panel 结果失败: ${getErrorMessage(error)}`);
    }
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
            : (snapshot.trigger === 'panel-auto' ? 'Panel 自动刷新' : '网络变化'));
    const lines = [
        `API 请求结果: ${snapshot.summary || '失败'}`,
        `当前网络环境: ${snapshot.network && snapshot.network.label ? snapshot.network.label : '未知'}`,
        `触发方式: ${triggerLabel}`,
        `更新时间: ${formatDate(snapshot.updatedAt)}`
    ];

    if (snapshot.note) lines.push(`说明: ${snapshot.note}`);

    (snapshot.results || []).forEach(function (result) {
        lines.push('');
        lines.push(`【${result.label}】`);
        lines.push(`请求结果: ${result.success ? '成功' : '失败'}`);
        if (result.error) lines.push(`错误: ${result.error}`);
        lines.push(`currentIp: ${result.currentIp || '-'}`);
        lines.push('whitelist:');
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
        parseArgs,
        buildConfig,
        normalizeHost,
        parseTokenList,
        parseList,
        getNetworkInfo,
        createRequestResult,
        normalizeWhitelist,
        renderPanel,
        hashString
    };
}

if (typeof $done === 'function') start();
