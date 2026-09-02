# dsh-fleet · Harness Fleet

> **Punica Studio** 出品 · 曾用名 `dsh-harness-workbench`
> 一艘 Harness "舰队"的指挥台:本机与远端每一艘 Harness,都在一个面板里瞭望、调度、续接。

一个 DeepSeek Harness Web 插件:在**设置 → Harness Fleet** 里用一个面板统管
多台 Harness —— 只显示运行中的本机实例(需要时手动固定端口)、登记多台远程
Harness、统一探活、一键打开/启停,**并能跨设备读取其它机器上的历史对话记录**,
让旧会话可以原地续聊而不是重新开始。

> English: dsh-fleet by Punica Studio. A fleet console for your DeepSeek
> Harness instances — running local ones auto-listed, remote harnesses
> registered and probed, local start/stop — plus, since v0.2, token-gated
> **reading of conversation history stored on other machines**, so past
> sessions can be browsed, exported, or continued in place.

## 它能做什么(v0.4)

### 实例管理
- **本机实例只列出运行中的** — 自动探测 127.0.0.1:3080–3129,仅显示**在线且是
  DeepSeek Harness** 的实例(前端 rev、耗时;Windows 带 PID、标记当前实例并
  自我保护)。**未运行的端口不出现**;需要管理固定端口时用「手动添加端口」加一条
  (可配启动命令),停止后仍保留、可再启动,也可移除。
- **远程登记与探活** — 添加任意数量远程 Harness(`http(s)://host:port`,可带会话
  令牌),显示在线状态、耗时、是否 Harness 页面,支持打开/复制/移除。
- **基础控制(本机)** — 「停止」终止被发现的非当前实例;「启动」用保存的启动命令
  (模板 `${port}` 自动替换)以脱离终端方式拉起。

### 跨设备读取历史会话
- 每台装了本插件的机器都是**会话服务端**:设置一个 `serveToken`,即可授权其它
  机器(经网络或 Tailscale)读取它的对话记录。
- 本机/远端都能**列会话**(自动解码 zstd 压缩 JSONL,含标题、创建/更新时间、
  体积),点开**读全文**(用户/助手/推理/工具调用与结果),**复制 Markdown** 或
  **复制会话 ID**。
- 令牌**恒由宿主端持有并转发**,浏览器永不接触;日志含敏感信息,令牌请当密码,
  优先走可信网络(Tailscale/https)。

### 关于"继续对话,不重新开始"
会话日志只属于产生它的那台机器。要**原地续聊**:在远程卡片点「打开」进入那台
Harness 的 Web UI,从会话列表进入原会话继续 —— 上下文、文件与历史都在。
要本地引用/迁移内容,可把会话"复制为 Markdown"粘进新会话。

## 安装

### 方式 A:本地代码直接装(开发/自用)
```sh
dsh plugin --profile web add "D:/00Software/DeepSeekHarness/dsh-fleet"
```
然后(若未走 CLI bundle 自动登记)把下行追加到
`~/.dsh/profiles/web/cordis.patch.yml`:
```yaml
- insert:
    - id: harness-fleet
      name: 'dsh-fleet'
```
刷新页面 → **设置 → Harness Fleet**。宿主代码改动后需**重启一次 `dsh web`**。

### 方式 B:从 GitHub 分发(推荐)
仓库:https://github.com/loveXbanshee/dsh-fleet

```sh
dsh plugin --profile web add github:loveXbanshee/dsh-fleet
```
然后**重启一次 `dsh web`**。包声明了 `dsh.bundle`,CLI 会自动登记为 bundle 层,
无需手改 yml。更新版本:重跑同一条命令(或上架市场后用市场更新)。

> 注意:补丁行形态与 bundle 形态二选一 —— 已用「方式 A」补丁行时不要再跑
> `dsh plugin add`,否则重启后重复插入。

## 跨设备读取的设置步骤
1. 在目标机器(装有本插件)设置一个共享令牌 → 状态显示"会话服务已开启"
   (写入 `~/.dsh/dsh-fleet.json`;旧版配置会自动迁移)。
2. 在工作台所在机器「远程 Harness」添加对方地址,会话令牌填**同一个令牌**。
3. 点该远程卡片的「会话」→ 列出对方全部会话(可"加载全部标题"),展开读全文 /
   复制 Markdown / 在对方 Web UI 里继续该会话。

## 安全模型
- 变更类接口:仅**同源 + 回环** POST;本机会话内容接口仅回环;
- 对外服务接口(`/api/sessions`、`/api/session-content`)必须携带匹配
  `serveToken` 的令牌,否则 403;未设置令牌时默认关闭;
- 远程令牌只存宿主配置、响应不回传;内容按量截断并给出"过长已截断"标记。

## API(宿主注册,前缀 `/dsh-fleet/api`)
| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/state` | GET | 实例快照(含 serveSessions) |
| `/scan` | POST | 重新扫描 |
| `/add-remote` | POST | `{ name?, origin, token? }` |
| `/remove-remote` | POST | `{ id }` |
| `/stop-local` `/start-local` | POST | `{ port }`(start 可带 `startCommand`) |
| `/set-start-command` | POST | `{ port, command }` |
| `/set-serve-token` | POST | `{ token }`(留空=关闭) |
| `/local-sessions` `/local-session-content` | GET | 本机会话索引(`includeTitles=1`)/全文 `?id=` |
| `/remote-sessions` `/remote-session-content` | GET | 代理远程(本机用) |
| `/sessions` `/session-content` | GET | **对外服务**(需 `?token=`) |

## 配置示例(`~/.dsh/dsh-fleet.json`)
```json
{
  "range": { "start": 3080, "end": 3129 },
  "serveToken": "在此设置共享令牌,留空=禁止外部读取",
  "remotes": [
    { "id": "r_abc123", "name": "办公室服务器", "origin": "http://192.168.1.20:3080", "token": "与对方 serveToken 相同" }
  ],
  "startCommands": { "3081": "dsh --profile workbench1 web" }
}
```

## 实现说明
- 会话存在 `<DSH_HOME>/sessions/<工作区>/session-<uuid>/session.jsonl.zstd`
  (兼容明文 `.jsonl`);zstd 多帧用 Node 内置 `node:zlib` 按帧魔数解压,零第三方
  依赖;重建对话只消费 `user/message`、`assistant/message`、`tool/call`、
  `tool/result`、`session/title` 完整行,跳过增量分块行。
- 事件转纯 JSON 叶子字段,不触碰内部 live 对象;宿主路由用 `ctx.inject` 等
  webServer 就绪后挂载(否则全新启动会静默失效)。

## 参考与致谢
- `webServer` 路由、同源防护与客户端 `settings.section`/`__ModuleLoader__`
  模式参考 [dsh-market](https://github.com/dsh-market/dsh-market);
- 本机多开列表思路参考 [dsh-instance-manager](https://github.com/xswt442-cmd/dsh-instance-manager);
- 跨实例协议(后续方向)参考 [dsh-interconnect](https://github.com/Chinesezjc/dsh-interconnect)。

## License
MIT · © 2026 Punica Studio
