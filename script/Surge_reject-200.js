/*******************************

QuantumultX 重写转换 Surge 重写时

匹配 QuantumultX 的reject-200 规则

{name} = type=http-request,pattern={pattern},script-path=https://raw.githubusercontent.com/alecthw/chnlist/main/script/Surge_reject-200.js
*******************************/

$done({ response: { status: 200 } });
