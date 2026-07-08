// =============================================================
// Surge DDNS 动态域名解析脚本
//
// 支持阿里云 (aliyun) 与 DNSPod (dnspod)。
// 网络变化时及每 5 分钟检测公网 IP 与 DNS 记录，不一致则自动更新；
// 若 DNS 中不存在对应记录则自动创建；确认成功的 /24 网段会本地缓存 7 天。
//
// 参数 (逗号分隔的 key=value)：
//   provider : aliyun 或 dnspod
//   domain   : 主域名，例如 example.com
//   rr       : 主机记录/子域名，根域名填 @
//   id       : 阿里云 AccessKeyId 或 DNSPod Token ID
//   secret   : 阿里云 AccessKeySecret 或 DNSPod Token
//   skip_ssid: 可选，指定 Wi-Fi SSID 下跳过执行，多个 SSID 用 | 分隔
//
// [Script]
// DDNS 网络变化 = type=event,event-name=network-changed,argument="provider=aliyun,domain=example.com,rr=home,id=xxx,secret=yyy,skip_ssid=Home|Office",script-path=https://raw.githubusercontent.com/alecthw/chnlist/main/script/DDNS.js
// DDNS 定时检测 = type=cron,cronexp="*/5 * * * *",argument="provider=aliyun,domain=example.com,rr=home,id=xxx,secret=yyy,skip_ssid=Home|Office",script-path=https://raw.githubusercontent.com/alecthw/chnlist/main/script/DDNS.js
// =============================================================

const SCRIPT_NAME = 'DDNS';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const cfg = parseArgs($argument || '');
const fqdn = (cfg.rr && cfg.rr !== '@') ? `${cfg.rr}.${cfg.domain}` : cfg.domain;

if (shouldSkipSSID(cfg.skip_ssid)) {
    $done();
} else if (!cfg.provider || !cfg.domain || !cfg.id || !cfg.secret) {
    notify('参数缺失', '', '请检查 provider/domain/id/secret 是否完整');
    $done();
} else {
    run().catch(err => {
        console.log(`[${SCRIPT_NAME}] error: ${err && err.stack ? err.stack : err}`);
        notify('DDNS 失败', fqdn, String(err && err.message ? err.message : err));
        $done();
    });
}

async function run() {
    const publicIP = await getPublicIP();
    console.log(`[${SCRIPT_NAME}] ${fqdn} 当前公网 IP: ${publicIP}`);

    if (!publicIP || !isValidIP(publicIP)) {
        throw new Error('未能获取有效的公网 IP 地址');
    }

    const publicCIDR24 = ipToCIDR24(publicIP);
    if (!publicCIDR24) {
        throw new Error('未能转换公网 IP 为 /24 网段');
    }

    const cached = readIPCache(cfg);
    const cachedCIDR24 = cached && (cached.cidr24 || ipToCIDR24(cached.ip));
    if (cachedCIDR24 === publicCIDR24) {
        console.log(`[${SCRIPT_NAME}] ${fqdn} /24 网段命中 7 天缓存 (${publicCIDR24})，跳过 DNS 查询与更新`);
        $done();
        return;
    }

    const client = cfg.provider === 'dnspod' ? dnspod : aliyun;
    const record = await client.findRecord(cfg, fqdn);

    if (!record) {
        console.log(`[${SCRIPT_NAME}] 记录不存在，新建 ${fqdn} -> ${publicIP}`);
        await client.createRecord(cfg, publicIP);
        writeIPCache(cfg, publicIP);
        notify('DDNS 已创建', fqdn, `新建 A 记录 -> ${publicIP}`);
        $done();
        return;
    }

    if (record.value === publicIP) {
        console.log(`[${SCRIPT_NAME}] ${fqdn} IP 未变化 (${publicIP})，跳过更新`);
        writeIPCache(cfg, publicIP);
        $done();
        return;
    }

    console.log(`[${SCRIPT_NAME}] 更新 ${fqdn}: ${record.value} -> ${publicIP}`);
    await client.updateRecord(cfg, record, publicIP);
    writeIPCache(cfg, publicIP);
    notify('DDNS 已更新', fqdn, `${record.value} -> ${publicIP}`);
    $done();
}

// ============================================================
// 参数解析
// ============================================================

function parseArgs(arg) {
    const result = {};
    if (!arg) return result;
    arg.split(',').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx > 0) {
            const k = pair.substring(0, idx).trim();
            const v = pair.substring(idx + 1).trim();
            if (k) result[k] = v;
        }
    });
    return result;
}

function notify(title, subtitle, body) {
    try {
        $notification.post(`${SCRIPT_NAME} - ${title}`, subtitle || '', body || '');
    } catch (e) { /* noop */ }
}

function shouldSkipSSID(value) {
    const skipSSIDs = parseSSIDList(value);
    if (!skipSSIDs.length) return false;

    const ssid = getCurrentSSID();
    if (!ssid) return false;

    if (skipSSIDs.includes(ssid)) {
        console.log(`[${SCRIPT_NAME}] 当前 Wi-Fi SSID 为 ${ssid}，命中 skip_ssid，跳过执行`);
        return true;
    }
    return false;
}

function parseSSIDList(value) {
    if (!value) return [];
    return String(value).split('|').map(item => item.trim()).filter(Boolean);
}

function getCurrentSSID() {
    try {
        return $network && $network.wifi && $network.wifi.ssid ? String($network.wifi.ssid) : '';
    } catch (e) {
        return '';
    }
}

function readIPCache(cfg) {
    if (!hasPersistentStore()) return null;

    try {
        const raw = $persistentStore.read(getIPCacheKey(cfg));
        if (!raw) return null;

        const data = JSON.parse(raw);
        if (!data || !data.updatedAt) return null;
        if (!data.cidr24 && !data.ip) return null;
        if (Date.now() - Number(data.updatedAt) > CACHE_TTL_MS) return null;
        return data;
    } catch (e) {
        return null;
    }
}

function writeIPCache(cfg, ip) {
    if (!hasPersistentStore()) return;

    try {
        const cidr24 = ipToCIDR24(ip);
        if (!cidr24) return;

        const data = JSON.stringify({ ip, cidr24, updatedAt: Date.now() });
        $persistentStore.write(data, getIPCacheKey(cfg));
    } catch (e) { /* noop */ }
}

function getIPCacheKey(cfg) {
    return `${SCRIPT_NAME}:last_ip:${cfg.provider}:${cfg.domain}:${cfg.rr || '@'}`;
}

function hasPersistentStore() {
    return typeof $persistentStore !== 'undefined' &&
        $persistentStore &&
        typeof $persistentStore.read === 'function' &&
        typeof $persistentStore.write === 'function';
}

function ipToCIDR24(ip) {
    if (!isValidIP(ip)) return '';

    const parts = String(ip).split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function isValidIP(ip) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
}

// ============================================================
// 公网 IP 获取
// ============================================================

async function getPublicIP() {
    const url = 'https://myip.ipip.net';
    const res = await httpGet(url, { Accept: 'text/plain', 'User-Agent': 'curl/8.0' });
    const ip = ((res.body || '').match(/\b(\d{1,3}\.){3}\d{1,3}\b/) || [])[0];
    if (ip && isValidIP(ip)) return ip;
    throw new Error(`获取公网 IP 失败: ${(res.body || '').slice(0, 80)}`);
}

// ============================================================
// HTTP 客户端 (Promise 封装)
//   所有请求强制走 DIRECT 策略，避免经过代理影响 DDNS 准确性
// ============================================================

function httpGet(url, headers) {
    return new Promise((resolve, reject) => {
        $httpClient.get({ url, headers: headers || {}, timeout: 10, policy: 'DIRECT' }, (err, resp, body) => {
            if (err) return reject(new Error(String(err)));
            if (!resp || resp.status >= 400) return reject(new Error(`HTTP ${resp && resp.status}: ${body}`));
            resolve({ status: resp.status, headers: resp.headers, body });
        });
    });
}

function httpPostForm(url, form, extraHeaders) {
    const body = Object.keys(form).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(form[k])}`).join('&');
    const headers = Object.assign({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
    }, extraHeaders || {});
    return new Promise((resolve, reject) => {
        $httpClient.post({ url, headers, body, timeout: 10, policy: 'DIRECT' }, (err, resp, respBody) => {
            if (err) return reject(new Error(String(err)));
            if (!resp || resp.status >= 400) return reject(new Error(`HTTP ${resp && resp.status}: ${respBody}`));
            resolve({ status: resp.status, headers: resp.headers, body: respBody });
        });
    });
}

// ============================================================
// 阿里云 DNS
// ============================================================

const aliyun = {
    endpoint: 'https://alidns.aliyuncs.com/',

    async call(cfg, params) {
        const common = {
            Format: 'JSON',
            Version: '2015-01-09',
            AccessKeyId: cfg.id,
            SignatureMethod: 'HMAC-SHA1',
            Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
            SignatureVersion: '1.0',
            SignatureNonce: Math.random().toString(36).slice(2) + Date.now().toString(36)
        };
        const all = Object.assign({}, common, params);
        const sortedKeys = Object.keys(all).sort();
        const canonical = sortedKeys.map(k => `${aliPercent(k)}=${aliPercent(all[k])}`).join('&');
        const stringToSign = `GET&${aliPercent('/')}&${aliPercent(canonical)}`;
        const sig = bytesToBase64(hmacSha1(cfg.secret + '&', stringToSign));
        const url = `${this.endpoint}?Signature=${aliPercent(sig)}&${canonical}`;

        const res = await httpGet(url);
        let json;
        try { json = JSON.parse(res.body); } catch (e) { throw new Error(`阿里云响应解析失败: ${res.body}`); }
        if (json.Code) throw new Error(`阿里云 ${json.Code}: ${json.Message}`);
        return json;
    },

    async findRecord(cfg, fqdn) {
        const data = await this.call(cfg, {
            Action: 'DescribeDomainRecords',
            DomainName: cfg.domain,
            RRKeyWord: cfg.rr || '@',
            TypeKeyWord: 'A'
        });
        const records = (data.DomainRecords && data.DomainRecords.Record) || [];
        const match = records.find(r => r.RR === (cfg.rr || '@') && r.Type === 'A');
        return match ? { id: match.RecordId, value: match.Value } : null;
    },

    async createRecord(cfg, ip) {
        await this.call(cfg, {
            Action: 'AddDomainRecord',
            DomainName: cfg.domain,
            RR: cfg.rr || '@',
            Type: 'A',
            Value: ip
        });
    },

    async updateRecord(cfg, record, ip) {
        await this.call(cfg, {
            Action: 'UpdateDomainRecord',
            RecordId: record.id,
            RR: cfg.rr || '@',
            Type: 'A',
            Value: ip
        });
    }
};

// 阿里云 RFC3986 编码
function aliPercent(str) {
    return encodeURIComponent(String(str))
        .replace(/!/g, '%21')
        .replace(/\*/g, '%2A')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
}

// ============================================================
// DNSPod (腾讯云国内版 API)
// ============================================================

const dnspod = {
    endpoint: 'https://dnsapi.cn',

    async call(cfg, action, params) {
        const form = Object.assign({
            login_token: `${cfg.id},${cfg.secret}`,
            format: 'json',
            lang: 'cn',
            error_on_empty: 'no'
        }, params);
        const res = await httpPostForm(`${this.endpoint}/${action}`, form, {
            'User-Agent': 'Surge-DDNS/1.0 (alecthw@github)'
        });
        let json;
        try { json = JSON.parse(res.body); } catch (e) { throw new Error(`DNSPod 响应解析失败: ${res.body}`); }
        if (!json.status || json.status.code !== '1') {
            const code = json.status && json.status.code;
            const msg = json.status && json.status.message;
            throw new Error(`DNSPod ${code}: ${msg}`);
        }
        return json;
    },

    async findRecord(cfg, fqdn) {
        try {
            const data = await this.call(cfg, 'Record.List', {
                domain: cfg.domain,
                sub_domain: cfg.rr || '@',
                record_type: 'A'
            });
            const records = data.records || [];
            const match = records.find(r => r.name === (cfg.rr || '@') && r.type === 'A');
            return match ? { id: match.id, value: match.value, line: match.line, line_id: match.line_id } : null;
        } catch (e) {
            // code 10 = 记录列表为空
            if (/DNSPod 10:/.test(e.message)) return null;
            throw e;
        }
    },

    async createRecord(cfg, ip) {
        await this.call(cfg, 'Record.Create', {
            domain: cfg.domain,
            sub_domain: cfg.rr || '@',
            record_type: 'A',
            record_line: '默认',
            value: ip
        });
    },

    async updateRecord(cfg, record, ip) {
        await this.call(cfg, 'Record.Ddns', {
            domain: cfg.domain,
            record_id: record.id,
            sub_domain: cfg.rr || '@',
            record_line: record.line || '默认',
            value: ip
        });
    }
};

// ============================================================
// 纯 JS 实现 SHA-1 / HMAC-SHA1 / Base64 (用于阿里云签名)
// ============================================================

function utf8Bytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) {
            bytes.push(0xC0 | (c >> 6));
            bytes.push(0x80 | (c & 0x3F));
        } else if (c < 0xD800 || c >= 0xE000) {
            bytes.push(0xE0 | (c >> 12));
            bytes.push(0x80 | ((c >> 6) & 0x3F));
            bytes.push(0x80 | (c & 0x3F));
        } else {
            i++;
            const c2 = str.charCodeAt(i);
            c = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
            bytes.push(0xF0 | (c >> 18));
            bytes.push(0x80 | ((c >> 12) & 0x3F));
            bytes.push(0x80 | ((c >> 6) & 0x3F));
            bytes.push(0x80 | (c & 0x3F));
        }
    }
    return bytes;
}

function sha1(input) {
    const bytes = typeof input === 'string' ? utf8Bytes(input) : input.slice();
    const origLen = bytes.length;

    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const bitLenHi = Math.floor(origLen / 0x20000000);
    const bitLenLo = (origLen * 8) >>> 0;
    bytes.push((bitLenHi >>> 24) & 0xFF, (bitLenHi >>> 16) & 0xFF, (bitLenHi >>> 8) & 0xFF, bitLenHi & 0xFF);
    bytes.push((bitLenLo >>> 24) & 0xFF, (bitLenLo >>> 16) & 0xFF, (bitLenLo >>> 8) & 0xFF, bitLenLo & 0xFF);

    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const W = new Array(80);

    for (let off = 0; off < bytes.length; off += 64) {
        for (let i = 0; i < 16; i++) {
            W[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
                    (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
        }
        for (let i = 16; i < 80; i++) {
            const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16];
            W[i] = ((x << 1) | (x >>> 31)) >>> 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4;
        for (let i = 0; i < 80; i++) {
            let f, k;
            if (i < 20)      { f = (b & c) | ((~b) & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d;             k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else             { f = b ^ c ^ d;             k = 0xCA62C1D6; }
            const t = (((a << 5) | (a >>> 27)) + f + e + k + W[i]) >>> 0;
            e = d; d = c;
            c = ((b << 30) | (b >>> 2)) >>> 0;
            b = a; a = t;
        }
        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
    }
    const out = [];
    [h0, h1, h2, h3, h4].forEach(h => {
        out.push((h >>> 24) & 0xFF, (h >>> 16) & 0xFF, (h >>> 8) & 0xFF, h & 0xFF);
    });
    return out;
}

function hmacSha1(key, msg) {
    const BLOCK = 64;
    let kBytes = typeof key === 'string' ? utf8Bytes(key) : key.slice();
    if (kBytes.length > BLOCK) kBytes = sha1(kBytes);
    while (kBytes.length < BLOCK) kBytes.push(0);
    const oPad = kBytes.map(b => b ^ 0x5C);
    const iPad = kBytes.map(b => b ^ 0x36);
    const mBytes = typeof msg === 'string' ? utf8Bytes(msg) : msg;
    return sha1(oPad.concat(sha1(iPad.concat(mBytes))));
}

function bytesToBase64(bytes) {
    const C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b1 = bytes[i];
        const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += C[b1 >> 2];
        out += C[((b1 & 0x03) << 4) | (b2 >> 4)];
        out += i + 1 < bytes.length ? C[((b2 & 0x0F) << 2) | (b3 >> 6)] : '=';
        out += i + 2 < bytes.length ? C[b3 & 0x3F] : '=';
    }
    return out;
}
