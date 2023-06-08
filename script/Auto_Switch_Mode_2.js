/*******************************

Surge根据网络自动切换出站模式

默认规则模式，指定SSID切换为直连模式，指定SSID切换为全局代理

适用场景举例：
切换为 Direct：家里路由器已配置了科学上网，此时适用直连
切换为 Proxy：一般用于公司审查个人上网的情况，配合国内中转节点使用，避免流量被公司审查

******************
Surge配置说明
请修改argument中的SSID为需要自动切换模式的SSID，多个SSID之间以竖线'|'分隔，不要额外添加空格
******************

[Script]
自动模式切换 = type=event, event-name=network-changed, argument="direct=SSID1|SSID2|SSID3,proxy=SSID4|SSID5", script-path=https://raw.githubusercontent.com/alecthw/chnlist/main/script/Auto_Switch_Mode_2.js

*******************************/

const direct_ssids = [];

const proxy_ssids = [];

$argument.trim().split(',').forEach(cfg => {
    const [mode, ssidStr] = cfg.split('=');

    const ssids = ssidStr.split('|');

    if (mode === 'direct') {
        direct_ssids.push(...ssids);

    } else if (mode === 'proxy') {
        proxy_ssids.push(...ssids);
    }
});

console.log($argument);
console.log(`direct ssids: ${JSON.stringify(direct_ssids)}`);
console.log(`proxy ssids: ${JSON.stringify(proxy_ssids)}`);

function switchOutbound(mode) {
    console.log(`Target mode: ${mode}`);

    $httpAPI('GET', '/v1/outbound', undefined, function (curRes) {
        console.log(`Current mode: ${curRes.mode}`);

        if (curRes.mode === mode) {
            console.log('Switch is not needed!');
            $done();

        } else {
            $httpAPI('POST', '/v1/outbound', { mode }, function (postRes) {
                console.log(`Post Res: ${JSON.stringify(postRes)}`);

                $httpAPI('GET', '/v1/outbound', undefined, function (switchRes) {
                    console.log(`Switched mode: ${switchRes.mode}`);

                    if (switchRes.mode === mode) {
                        console.log('Switch successful!');
                    } else {
                        console.log('Switch failed!');
                        $notification.post('自动模式切换', '', '自动出站模式切换失败，请检查日志。');
                    }

                    $done();
                }
                );
            });
        }
    });
}

console.log(`Network Change: ${JSON.stringify($network)}`);

const ssid = $network.wifi.ssid;

if (ssid && direct_ssids.includes(ssid)) {
    switchOutbound('direct');
} else if (ssid && proxy_ssids.includes(ssid)) {
    switchOutbound('proxy');
} else {
    switchOutbound('rule');
}
