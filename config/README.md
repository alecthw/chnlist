
# 订阅和分流的配置文件

本配置设计的重点是无需订阅转换，面向支持配置节点远程订阅的客户端。

## 如何使用

一句话：在客户端内下载配置，然后将配置里的 `Subscribe` 修改成你自己的订阅，即可使用。

### Surge

1. `首页` 左上角点开，`导入 - 从 URL 下载配置`，填入 `https://rawstatic.com/alecthw/chnlist/main/config/Surge.conf`
2. `代理` 策略组拖到最下面，找到 `Subscribe` 策略组，长按选择 `编辑策略组`，拖到最下面，将 `外部代理列表` 里的 URL 改成你的订阅链接
3. Enjoy

### Loon

1. `配置` 往下拖，找到 `所有配置文件`，点击右上角加号添加，填入  `https://rawstatic.com/alecthw/chnlist/main/config/Loon.conf`
2. `配置` 最上面 `所有节点`，找到 `Subscribe` 长按选择 `编辑`，将 `URL` 改成你的订阅链接
3. Enjoy

### Stash

1. `首页` 左上角点开，`导入 - 从 URL 下载`，填入 `https://rawstatic.com/alecthw/chnlist/main/config/Stash.yaml`
2. 返回找到 `可视化编辑器` （还是在 `首页` 左上角点开里），找到远程代理集，点击 `Subscribe` 进入编辑，将 `URL` 改成你的订阅链接
3. Enjoy

### QuantumultX

**`QuantumultX 尚未支持 Anytls`**

1. 点击右下角图标，往下拖找到 `下载配置`，填入 `https://rawstatic.com/alecthw/chnlist/main/config/QuantumultX.conf`
2. 返回，最上面找到 `节点资源` （还是点击右下角图标点开后），点击 `Subscribe` 进入编辑，将 `资源路径` 改成你的订阅链接
3. Enjoy

### Shadowrocket

需要同时下载两个配置：

- `https://rawstatic.com/alecthw/chnlist/main/config/Shadowrocket_NodeGroup.conf`
- `https://rawstatic.com/alecthw/chnlist/main/config/Shadowrocket.conf`

小火箭的分流配置逻辑有点绕，建议用简单国内外配置即可：

- `https://rawstatic.com/alecthw/chnlist/main/config/Shadowrocket_CN.conf`
