# Site-2中央路由系统

一个纯静态的服务入口页面。页面启动后读取 `services.yaml`，运行适配器检测环境变量，再按服务链接优先级和 `when` 条件确定入口。

主页以列表展示服务。每个服务默认显示自动推荐的入口，点击“进入”直接跳转；点击“展开”后同时列出校内和公网入口，供手动选择。校内网络下两条入口都可进入；检测为公网时，校内入口会禁用。页头“管理登录 / 退出”会跳转到统一鉴权服务的退出页面。

## 运行

```bash
python3 -m http.server 4173
```

然后访问：

```text
http://localhost:4173/
```

不要直接用 `file://` 打开 `index.html`，浏览器通常会阻止页面读取 `services.yaml`。

## 自动跳转参数

页面打开时带以下任一参数会自动匹配并跳转：

```text
?id=jwms
?name=教务管理系统
?url=https://jwms.bit.edu.cn/
?link=jwms.bit.edu.cn
?target=jwms
?to=jwms
?jwms
#jwms
```

匹配顺序是服务 `id`、服务 `name`、`aliases`、服务链接。链接匹配会兼容有无协议、有无尾斜杠、同域名、路径前缀和包含关系。

## 配置

`services.yaml` 顶层包含 `site`、`adapters` 和 `services`：

```yaml
site:
  title: Site-2中央路由系统
  mark: TECLAB
  loading:
    minDuration: 2000
    status: 正在检测网络环境

adapters:
  - id: schoolNetwork
    name: 校园网检测
    mode: https-probe
    variable: isSchoolNetwork
    config:
      url: https://jwms.bit.edu.cn/
      timeout: 2500

services:
  - id: jwms
    name: 教务管理系统
    aliases: [教务, jw]
    links:
      - label: 校内入口
        url: https://jwms.bit.edu.cn/
        when: isSchoolNetwork
      - label: VPN 入口
        url: https://webvpn.bit.edu.cn/example
        when: "!isSchoolNetwork"
```

`site.loading.minDuration` 控制启动预检层的最短展示时间，单位是毫秒。默认示例是 `2000`，可以避免网络检测太快时界面闪一下。

当前内置适配器模式：

- `https-probe`：用 `fetch(..., { method: "HEAD", mode: "no-cors" })` 探测指定 URL，支持 `timeout`、`successValue`、`failureValue`、`successText`、`failureText`。
- `constant`：返回固定值，适合配置默认可用条件。

`when` 支持变量名、`!`、`&&`、`||` 和括号，例如：

```yaml
when: isSchoolNetwork
when: "!isSchoolNetwork"
when: "isSchoolNetwork || always"
```
