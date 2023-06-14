/*******************************

QuantumultX重写转换Surge重写时

匹配QuantumultX的reject-200规则

{name} = type=http-request,pattern={pattern},requires-body=1,script-path=https://raw.githubusercontent.com/alecthw/chnlist/main/script/Surge_reject-200.js,argument=reject-200

*******************************/

response_map = {
  "reject-array": {
    status: 200,
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify([]),
  },
  "reject-dict": {
    status: 200,
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({}),
  },
  "reject-img": { status: 200 },
  "reject-200": { status: 200 },
};

$done({ response: response_map[$argument] });
