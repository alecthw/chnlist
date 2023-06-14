/*******************************

QuantumultX重写转换Surge重写时

匹配QuantumultX的reject-200规则

{name} = type=http-request,pattern={pattern},requires-body=1,script-path=https://raw.githubusercontent.com/alecthw/chnlist/main/script/Surge_reject-200.js,argument=reject-200

*******************************/

if ($argument == "reject-array") {
  $done({ response: { status: 200, body: [] } });
} else if ($argument == "reject-dict") {
  $done({ response: { status: 200, body: {} } });
} else {
  $done({ response: { status: 200 } });
}
