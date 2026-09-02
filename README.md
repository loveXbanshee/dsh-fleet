# dsh-harness-workbench · Harness 工作台

一个 DeepSeek Harness Web 插件:在**设置 → Harness 工作台**里用一个面板管理
多台 Harness —— 自动发现本机的 dsh web 实例、登记多台远程 Harness、统一
探活、一键打开其 Web UI、启停本机实例,**并能跨设备读取其它机器上的历史对话
记录**,让你在原会话里继续,而不是重新开始。

> 英文简介: Multi-Harness Workbench for DeepSeek Harness Web. One settings
> page keeps an eye on local `dsh web` instances (auto-discovered on ports
> 3080–3129) plus any number of remote harnesses, with health probes,
> open/copy, local start & stop — and, since v0.2, token-gated **reading of the
> conversation history stored on those other machines**, so past sessions can
> be browsed, exported, or continued in place instead of starting over.

## 它能做什么(v0.2)

### 实例管理(0.1)
- **本机实例:只列出运行中的** — 探测 127.0.0.1:3080–3129,只显示**在线且是
  DeepSeek Harness** 的实例(前端 rev、耗时;Windows 下带 PID,标记当前实例并
  自我保护)。**未运行的端口不出现**;要管理某个固定端口,用「手动添加端口」加
  一条(可配启动命令),停止后仍保留可再启动,也可移除。
- **远程登记与探活** — 添加任意数量远程 Harness(`http(s)://host:port`,可带
  会话令牌),显示在线状态、耗时、是否 Harness 页面,支持打开/复制/移除。
- **基础控制(本机)** — 「停止」终止被发现的非当前实例;「启动」用每端口保存的
  启动命令(模板 `${port}` 自动替换)以脱离终端的方式拉起。

### 跨设备读取历史会话(0.2,新增)
- 每台装了本插件的机器都是一个**会话服务端**:在它的工作台里设置一个
  `serveToken`,就能授权其它机器(经网络或 Tailscale)读取它的对话记录。
- 本机/远端都能**列会话**(自动解码 zstd 压缩的 JSONL 日志,标题、创建/更新时间、
  体积),点开任意会话**阅读全文**(用户/助手/工具调用与结果,推理文本可读),**复制
  为 Markdown** 或**复制会话 ID**。
- 令牌**恒由宿主端持有并转发**,浏览器永不接触;未配令牌的远程会提示无法读取。
- 日志可能含敏感信息(凭据/路径),请把令牌当密码对待,并优先走可信网络
  (Tailscale / https)。

### 关于“继续对话,不重新开始”
会话日志只属于产生它的那台机器。要**原地续聊**:在远程卡片点「打开」进入那台
Harness 的 Web UI,从会话列表进入原会话继续 —— 上下文、文件与历史都在,不会
重开。在本地只想引用/迁移内容时,可把会话“复制为 Markdown”粘进新会话;后续
版本计划接入 dsh-interconnect 协议做面板内直接向远端会话投递消息。

## 安装

### 方式 A:本地代码直接装(无需发布)
```sh
dsh plugin --profile web add "D:/00Software/DeepSeekHarness/dsh-harness-workbench"
```
然后把下面的行追加到 `~/.dsh/profiles/web/cordis.patch.yml`(DSH 的 HMR 约
1 秒内激活;若此前已装过旧版,改完代码后需**重启一次 `dsh web`** 让宿主
模块换新):

```yaml
- insert:
    - id: harness-workbench
      name: 'dsh-harness-workbench'
```
刷新页面 → **设置 → Harness 工作台**。

### 方式 B:发布到 GitHub 后在其它设备安装(推荐用于分发)
1. 把本项目推到你的 GitHub 仓库(仓库名建议 `dsh-harness-workbench`)。
   包已声明 `dsh.bundle.patch`,所以 CLI 安装会自动把它登记为 bundle 层,
   **不需要**再手改 `cordis.patch.yml`。
2. 在其它设备上执行(仓库为公开时):
   ```sh
   dsh plugin --profile web add github:<你的用户名>/dsh-harness-workbench
   ```
   然后**重启一次 `dsh web`**,刷新页面即可看到「Harness 工作台」。
3. 想让它出现在插件市场里:到
   [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
   提一条收录 PR,注明 GitHub 地址即可(通常一天内自动上架)。
4. 版本更新走 Git tag/commit:设备上再次 `dsh plugin --profile web add github:<用户名>/dsh-harness-workbench`
   即可拉取最新版(或等市场收录后用市场更新)。

> 注意:本机若按「方式 A」以补丁行方式运行,`dsh plugin` 命令会把包自动加进
> bundles(因为现在声明了 `dsh.bundle`),导致重启后与补丁行**重复插入**。两种
> 形态任选其一:要么保持补丁行(就不要再跑 `dsh plugin add`),要么改走 bundle
> 形态(删掉补丁行、把包加进 `dsh.profile.bundles` 后重启)。

## 跨设备读取的设置步骤

1. 在**本机**(要读取的目标机器,已装本插件)的工作台最下方设置并保存一个
   共享令牌 → 状态显示“会话服务已开启”。这台机器上的 `serveToken` 写入
   `~/.dsh/dsh-harness-workbench.json`。
2. 在**工作台所在机器**(发起读取的机器)「远程 Harness」里添加对方地址,并在
   “会话令牌”一栏填**同一个令牌** → 卡片出现“会话令牌已配置”。
3. 点该远程卡片的「会话」→ 列出对方设备上的全部会话(可“加载全部标题”),
   点会话展开全文,复制 Markdown / 会话 ID,或在对方 Web UI 里继续该会话。

## 安全模型

- 变更类接口(添加/删除/启停/设令牌/启动命令):只接受**同源 + 环回** POST。
- 本机会话内容接口:只回环地址;内容端点在浏览器同源下经宿主代理读取。
- **对外服务接口**(`/api/sessions`、`/api/session-content`):必须携带与
  `serveToken` 匹配的令牌,否则 403;未设置令牌时默认 403 关闭。
- 远程令牌只保存在宿主配置里,响应中不回传;会话内容按量截断(工具结果、助手
  文本等均设上限)并支持“过长已截断”标记。

## API(宿主注册的同源路由)

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-harness-workbench/api/state` | GET | 实例快照(含 serveSessions 状态) |
| `/dsh-harness-workbench/api/scan` | POST | 重新扫描 |
| `/dsh-harness-workbench/api/add-remote` | POST | `{ name?, origin, token? }` |
| `/dsh-harness-workbench/api/remove-remote` | POST | `{ id }` |
| `/dsh-harness-workbench/api/stop-local` | POST | `{ port }` |
| `/dsh-harness-workbench/api/start-local` | POST | `{ port }` |
| `/dsh-harness-workbench/api/set-start-command` | POST | `{ port, command }` |
| `/dsh-harness-workbench/api/set-serve-token` | POST | `{ token }`(留空=关闭) |
| `/dsh-harness-workbench/api/local-sessions` | GET | 本机会话索引(`includeTitles=1` 加载标题) |
| `/dsh-harness-workbench/api/local-session-content` | GET | 本机会话全文 `?id=` |
| `/dsh-harness-workbench/api/remote-sessions` | GET | 代理远程索引 `?remote=&includeTitles=` |
| `/dsh-harness-workbench/api/remote-session-content` | GET | 代理远程全文 `?remote=&session=` |
| `/dsh-harness-workbench/api/sessions` | GET | **对外服务**(需 `?token=`)：索引 |
| `/dsh-harness-workbench/api/session-content` | GET | **对外服务**(需 `?token=`)：全文 `?id=` |

## 配置示例(`~/.dsh/dsh-harness-workbench.json`)

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

## 会话日志读取的实现说明

- 会话存在 `<DSH_HOME>/sessions/<工作区>/session-<uuid>/session.jsonl.zstd`
  (也兼容明文 `.jsonl`);zstd 文件是多帧写入,宿主用 Node 内置 `node:zlib`
  按帧魔数逐帧解压,不依赖任何第三方解码器。
- 重建对话只消费 `user/message`、`assistant/message`、`tool/call`、
  `tool/result`、`session/title` 等完整行,跳过增量分块行 —— 免去了对
  私有 `decodeStorageRecord` 的依赖,跨 dsh 版本更稳。
- 事件转换为纯 JSON 叶子字段(文本、角色、时间、工具名/参数/结果预览),不触碰
  内部 live 对象。

## 参考与致谢

- 宿主 `webServer` 路由、同源防护与客户端 `settings.section`/`__ModuleLoader__`
  模式参考 [dsh-market](https://github.com/dsh-market/dsh-market);
- 本机多开列表面板思路参考 [dsh-instance-manager](https://github.com/xswt442-cmd/dsh-instance-manager);
- 跨实例消息/续聊协议(后续接入方向)参考 [dsh-interconnect](https://github.com/Chinesezjc/dsh-interconnect)。

## License

MIT
