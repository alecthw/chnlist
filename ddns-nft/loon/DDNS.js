const COMMON_DDNS_URL = 'https://raw.githubusercontent.com/alecthw/chnlist/main/ddns-nft/DDNS.js';

(function() {
    const root = getGlobalRoot();
    const previous = {
        argument: root.$argument,
        network: root.$network,
        httpClient: root.$httpClient,
        done: root.$done
    };

    const nativeHttpClient = root.$httpClient;
    const nativeDone = root.$done;

    root.$argument = buildArgument(parseMode(previous.argument));
    root.$network = { wifi: { ssid: getSSID() } };
    root.$httpClient = wrapHttpClient(nativeHttpClient);
    root.$done = value => {
        restoreGlobals(root, previous);
        if (typeof nativeDone === 'function') nativeDone(value);
    };

    nativeHttpClient.get({ url: COMMON_DDNS_URL, timeout: 10000 }, (err, resp, body) => {
        if (err) {
            restoreGlobals(root, previous);
            console.log(`[DDNS] load common script failed: ${err}`);
            if (typeof nativeDone === 'function') nativeDone();
            return;
        }

        try {
            eval(body);
        } catch (e) {
            restoreGlobals(root, previous);
            console.log(`[DDNS] eval common script failed: ${e && e.stack ? e.stack : e}`);
            if (typeof nativeDone === 'function') nativeDone();
        }
    });
})();

function buildArgument(mode) {
    const pairs = [
        ['mode', mode],
        ['provider', readSetting('provider') || 'aliyun'],
        ['domain', readSetting('domain')],
        ['rr', readSetting('rr') || 'mobile'],
        ['id', readSetting('id')],
        ['secret', readSetting('secret')],
        ['skip_ssid', readSetting('skip_ssid')]
    ];
    return pairs
        .filter(pair => pair[1])
        .map(pair => `${pair[0]}=${encodeURIComponent(pair[1])}`)
        .join('&');
}

function parseMode(argument) {
    const text = String(argument || '');
    const match = text.match(/(?:^|&)mode=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

function readSetting(key) {
    try {
        const value = $persistentStore.read(key);
        return value ? String(value).trim() : '';
    } catch (e) {
        return '';
    }
}

function getSSID() {
    try {
        if (typeof $config !== 'undefined' && $config && typeof $config.getConfig === 'function') {
            const cfg = JSON.parse($config.getConfig() || '{}');
            return cfg.ssid ? String(cfg.ssid) : '';
        }
    } catch (e) { /* noop */ }
    return '';
}

function wrapHttpClient(client) {
    return {
        get(options, callback) { client.get(normalizeRequest(options), callback); },
        post(options, callback) { client.post(normalizeRequest(options), callback); }
    };
}

function normalizeRequest(options) {
    const req = Object.assign({}, options || {});
    if (typeof req.timeout === 'number' && req.timeout > 0 && req.timeout < 1000) {
        req.timeout = req.timeout * 1000;
    }
    return req;
}

function restoreGlobals(root, previous) {
    setOrDelete(root, '$argument', previous.argument);
    setOrDelete(root, '$network', previous.network);
    setOrDelete(root, '$httpClient', previous.httpClient);
    setOrDelete(root, '$done', previous.done);
}

function setOrDelete(root, key, value) {
    if (typeof value === 'undefined') delete root[key];
    else root[key] = value;
}

function getGlobalRoot() {
    if (typeof globalThis !== 'undefined') return globalThis;
    return Function('return this')();
}
