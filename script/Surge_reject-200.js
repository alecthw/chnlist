/*******************************

QuantumultX重写转换Surge重写时

匹配QuantumultX的reject-200规则

{name} = type=http-request,pattern={pattern},script-path=https://raw.githubusercontent.com/alecthw/chnlist/main/script/Surge_reject-200.js
*******************************/

$done({ response: { status: 200 } });
