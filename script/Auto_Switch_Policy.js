/*******************************

Surge根据网络自动切换指定策略组的策略

******************
Surge配置说明
请修改argument，不要额外添加空格:
第1个参数表示需要切换的策略组名称
第2个参数表示默认的策略
第3个参数以及之后的，表示指定SSID对应的策略
******************

[Script]
自动模式切换 = type=event, event-name=network-changed, argument="Group,Default_Policy,SSID1=Policy1,SSID2=Policy2", script-path=https://raw.githubusercontent.com/alecthw/chnlist/main/script/Auto_Switch_Policy.js

*******************************/

const args = $argument.split(',')

if (args.length < 3) {
    console.log('argument error');
    $done();
}

const group = args[0];
const default_policy = args[1];
const ssid_policy = {};

for (let i = 2; i < args.length; i++) {
    const [ssid, policy] = args[i].split('=');
    ssid_policy[ssid] = policy;
}

console.log(`group: ${group}, default policy: ${default_policy}`);
console.log(`ssid policy: ${JSON.stringify(ssid_policy)}`);

function switchGroupPolicy(group, policy) {
    console.log(`Target policy: ${policy}`);

    $httpAPI('GET', `/v1/policy_groups/select?group_name=${group}`, undefined, function (curRes) {
        console.log(`Res: ${JSON.stringify(curRes)}`);

        console.log(`Current policy: ${curRes.policy}`);

        if (curRes.policy === policy) {
            console.log('Switch is not needed!');
            $done();

        } else {
            $httpAPI('POST', '/v1/policy_groups/select', { "group_name": group, policy }, function (postRes) {
                console.log(`Post Res: ${JSON.stringify(postRes)}`);

                $httpAPI('GET', `/v1/policy_groups/select?group_name=${group}`, undefined, function (switchRes) {
                    console.log(`Switched mode: ${switchRes.policy}`);

                    if (switchRes.policy === policy) {
                        console.log('Switch successful!');
                    } else {
                        console.log('Switch failed!');
                        $notification.post('自动策略切换', '', `组${group}自动切换策略${policy}失败，请检查日志。`);
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

if (ssid && ssid_policy.hasOwnProperty(ssid)) {
    switchGroupPolicy(group, ssid_policy[ssid]);
} else {
    switchGroupPolicy(group, default_policy);
}
