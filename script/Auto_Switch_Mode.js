/*******************************

Surge根据网络自动切换出站模式

默认规则模式，指定SSID切换为直连模式

当模式为全局代理的时候，不会触发切换

******************
Surge配置说明
请修改argument中的SSID为需要自动切换到直接连接模式的SSID，以逗号','分隔
******************

[Script]
自动模式切换 = type=event, event-name=network-changed, argument="SSID1,SSID2,SSID3", script-path=https://raw.githubusercontent.com/alecthw/chnlist/main/script/Auto_Switch_Mode.js

*******************************/



const direct_ssids = [];

$argument.split(',').forEach(item => {
    direct_ssids.push(item.trim())
});

console.log($argument);
console.log(JSON.stringify(direct_ssids));

function switchOutbound(mode) {
    console.log(`Target mode: ${mode}`);

    $httpAPI('GET', '/v1/outbound', undefined, function (curRes) {
        console.log(`Current mode: ${curRes.mode}`);

        if (curRes.mode === mode || curRes.mode === 'proxy') {
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
                        $notification.post('自动策略切换', '', '自动出站模式切换失败，请检查日志。');
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
} else {
    switchOutbound('rule');
}
