const COMMON_DDNS_URL = 'https://raw.githubusercontent.com/alecthw/chnlist/main/ddns-nft/DDNS.js';

export default async function(ctx) {
    const argument = buildArgument(ctx.env || {});
    const result = await runCommonDDNS(ctx, argument);
    if (isWidgetMode(argument)) return renderWidget(result);
}

function buildArgument(env) {
    const pairs = [
        ['mode', env.mode || ''],
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

async function runCommonDDNS(ctx, argument) {
    const root = globalThis;
    const previous = {
        argument: root.$argument,
        network: root.$network,
        httpClient: root.$httpClient,
        persistentStore: root.$persistentStore,
        notification: root.$notification,
        done: root.$done
    };

    return new Promise(async (resolve, reject) => {
        root.$argument = argument;
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
            const response = await ctx.http.get(COMMON_DDNS_URL, { timeout: 10000, policy: 'DIRECT' });
            const code = await response.text();
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
        const response = await ctx.http[method.toLowerCase()](options.url, {
            headers: options.headers || {},
            body: options.body,
            timeout: (options.timeout || 10) * 1000,
            policy: options.policy || 'DIRECT'
        });
        callback(null, { status: response.status, headers: response.headers }, await response.text());
    } catch (e) {
        callback(e);
    }
}

function restoreGlobals(root, previous) {
    setOrDelete(root, '$argument', previous.argument);
    setOrDelete(root, '$network', previous.network);
    setOrDelete(root, '$httpClient', previous.httpClient);
    setOrDelete(root, '$persistentStore', previous.persistentStore);
    setOrDelete(root, '$notification', previous.notification);
    setOrDelete(root, '$done', previous.done);
}

function setOrDelete(root, key, value) {
    if (typeof value === 'undefined') delete root[key];
    else root[key] = value;
}

function isWidgetMode(argument) {
    return /(?:^|&)mode=panel(?:&|$)/.test(argument);
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
            { type: 'text', text: content, font: { size: 'caption' }, textColor: '#FFFFFF', opacity: 0.92 }
        ]
    };
}
