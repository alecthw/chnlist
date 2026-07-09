const COMMON_DDNS_URL = 'https://raw.githubusercontent.com/alecthw/chnlist/main/ddns-nft/DDNS.js';
const COMMON_DDNS_CACHE_KEY = 'DDNS:egern:common_script';

export default async function(ctx) {
    const argument = buildArgument(ctx);
    log(ctx, `[DDNS] Egern wrapper start: ${argument || 'no arguments'}`);
    try {
        const result = await runCommonDDNS(ctx, argument);
        if (isWidgetMode(argument)) return renderWidget(result);
    } catch (e) {
        const message = getErrorMessage(e);
        log(ctx, `[DDNS] egern wrapper error: ${message}`);
        if (isWidgetMode(argument)) return renderWidget({
            title: 'DDNS 失败',
            content: message,
            style: 'error'
        });
        try {
            ctx.notify({ title: 'DDNS - 失败', body: message });
        } catch (_) { /* noop */ }
    }
}

function buildArgument(ctx) {
    const env = ctx.env || {};
    const pairs = [
        ['mode', env.mode || (ctx.widgetFamily ? 'panel' : '')],
        ['provider', env.provider || 'aliyun'],
        ['domain', env.domain || ''],
        ['rr', env.rr || ''],
        ['id', env.id || ''],
        ['secret', env.secret || ''],
        ['skip_ssid', env.skip_ssid || '']
    ];
    return pairs
        .filter(pair => pair[1] !== '')
        .map(pair => `${pair[0]}=${encodeURIComponent(pair[1])}`)
        .join('&');
}

async function loadCommonDDNSCode(ctx) {
    try {
        const response = await ctx.http.get(COMMON_DDNS_URL, {
            timeout: 10000,
            redirect: 'follow',
            credentials: 'omit'
        });
        const code = await response.text();
        if (!isUsableCommonCode(code)) throw new Error('通用 DDNS 脚本内容无效');
        writeStorage(ctx, COMMON_DDNS_CACHE_KEY, code);
        return code;
    } catch (e) {
        const cached = readStorage(ctx, COMMON_DDNS_CACHE_KEY);
        if (isUsableCommonCode(cached)) {
            log(ctx, `[DDNS] 加载通用脚本失败，使用 Egern 本地缓存: ${getErrorMessage(e)}`);
            return cached;
        }
        throw e;
    }
}

function isUsableCommonCode(code) {
    return typeof code === 'string' && /function\s+start\s*\(/.test(code) && /start\s*\(\s*\)\s*;?/.test(code);
}

function readStorage(ctx, key) {
    try {
        return ctx.storage.get(key);
    } catch (_) {
        return null;
    }
}

function writeStorage(ctx, key, value) {
    try {
        ctx.storage.set(key, value);
    } catch (_) { /* noop */ }
}

async function runCommonDDNS(ctx, argument) {
    const root = globalThis;
    const previous = {
        argument: root.$argument,
        network: root.$network,
        httpClient: root.$httpClient,
        persistentStore: root.$persistentStore,
        notification: root.$notification,
        done: root.$done,
        console: root.console
    };

    return new Promise(async (resolve, reject) => {
        root.$argument = argument;
        root.console = makeConsole(ctx, previous.console);
        root.$network = { wifi: { ssid: ctx.device && ctx.device.wifi ? ctx.device.wifi.ssid : '' } };
        root.$httpClient = makeHttpClient(ctx);
        root.$persistentStore = {
            read(key) { return ctx.storage.get(key); },
            write(value, key) { ctx.storage.set(key, value); return true; }
        };
        root.$notification = {
            post(title, subtitle, body) {
                ctx.notify({ title: title || '', subtitle: subtitle || '', body: body || '' });
            }
        };
        root.$done = value => {
            restoreGlobals(root, previous);
            resolve(value || {});
        };

        try {
            const code = await loadCommonDDNSCode(ctx);
            eval(code);
        } catch (e) {
            restoreGlobals(root, previous);
            reject(e);
        }
    });
}

function makeHttpClient(ctx) {
    return {
        get(options, callback) {
            request(ctx, 'GET', options, callback);
        },
        post(options, callback) {
            request(ctx, 'POST', options, callback);
        }
    };
}

async function request(ctx, method, options, callback) {
    try {
        options = options || {};
        const requestOptions = buildRequestOptions(method, options);
        const response = await ctx.http[method.toLowerCase()](options.url, requestOptions);
        callback(null, { status: response.status, headers: headersToObject(response.headers) }, await response.text());
    } catch (e) {
        callback(e);
    }
}

function buildRequestOptions(method, options) {
    const requestOptions = {
        timeout: normalizeTimeout(options.timeout),
        redirect: 'follow',
        credentials: 'omit'
    };

    const headers = normalizeHeaders(options.headers);
    if (Object.keys(headers).length) requestOptions.headers = headers;

    if (typeof options.body !== 'undefined' && method !== 'GET') requestOptions.body = options.body;
    if (options.policy) requestOptions.policy = options.policy;
    return requestOptions;
}

function normalizeHeaders(headers) {
    const result = {};
    Object.keys(headers || {}).forEach(key => {
        result[key] = headers[key];
    });
    return result;
}

function headersToObject(headers) {
    const result = {};
    if (!headers) return result;

    if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => {
            result[key] = value;
        });
        return result;
    }

    Object.keys(headers).forEach(key => {
        const value = typeof headers.get === 'function' ? headers.get(key) : headers[key];
        if (value !== null && typeof value !== 'undefined') result[key] = value;
    });
    return result;
}

function normalizeTimeout(value) {
    const n = Number(value || 10);
    return n > 0 && n < 1000 ? n * 1000 : n;
}

function restoreGlobals(root, previous) {
    setOrDelete(root, '$argument', previous.argument);
    setOrDelete(root, '$network', previous.network);
    setOrDelete(root, '$httpClient', previous.httpClient);
    setOrDelete(root, '$persistentStore', previous.persistentStore);
    setOrDelete(root, '$notification', previous.notification);
    setOrDelete(root, '$done', previous.done);
    setOrDelete(root, 'console', previous.console);
}

function makeConsole(ctx, previousConsole) {
    const result = {};
    ['log', 'info', 'warn', 'error'].forEach(level => {
        result[level] = (...args) => writeLog(ctx, previousConsole, level, args);
    });
    return result;
}

function writeLog(ctx, previousConsole, level, args) {
    const message = args.map(formatLogArg).join(' ');

    try {
        if (ctx && typeof ctx.log === 'function') ctx.log(message);
    } catch (_) { /* noop */ }

    try {
        if (previousConsole && typeof previousConsole[level] === 'function') {
            previousConsole[level].apply(previousConsole, args);
        } else if (previousConsole && typeof previousConsole.log === 'function') {
            previousConsole.log.apply(previousConsole, args);
        }
    } catch (_) { /* noop */ }
}

function formatLogArg(value) {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch (_) {
        return String(value);
    }
}

function log(ctx, message) {
    writeLog(ctx, typeof console !== 'undefined' ? console : null, 'log', [message]);
}

function setOrDelete(root, key, value) {
    if (typeof value === 'undefined') delete root[key];
    else root[key] = value;
}

function isWidgetMode(argument) {
    return /(?:^|&)mode=panel(?:&|$)/.test(argument);
}

function getErrorMessage(err) {
    return String(err && err.message ? err.message : err);
}

function renderWidget(result) {
    const title = result.title || 'DDNS';
    const content = result.content || '';
    const style = result.style || 'info';
    const color = style === 'good' ? '#2D6A4F' : (style === 'alert' || style === 'error' ? '#9D2A2A' : '#2B5C8A');

    return {
        type: 'widget',
        backgroundColor: color,
        padding: 16,
        gap: 8,
        children: [
            { type: 'text', text: title, font: { size: 'headline', weight: 'semibold' }, textColor: '#FFFFFF' },
            { type: 'text', text: content, font: { size: 'caption2' }, textColor: '#FFFFFFCC' }
        ]
    };
}
