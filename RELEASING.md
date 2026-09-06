# dsh-fleet — 发布手册 (Release Guide)

> Punica Studio · 每次发布都按本手册走,保证:
> `git tag` 与 GitHub Release、仓库文件三者一致,任何用户都能稳定安装/更新。

---

## 0. 发布前必读

- **仓库**: https://github.com/loveXbanshee/dsh-fleet (public)
- **主分支**: `main` —— 发布 = 给 `main` 当前提交打 tag + 建 Release
- **自更新源**: 插件内「更新」从 `api.github.com`(权威)→ raw → jsDelivr 拉文件。
  只要 `main` 分支文件是新的,各机器点「检查更新/更新并重启」即可升级。
- **本机发版限制**: 这台机器 `git push` 经常失败(github.com 直连不稳定),
  因此仓库同步走 **GitHub Contents API**(逐文件 PUT),tag/release 用
  **GitHub REST API** 创建 —— 两者都只需 HTTPS + PAT,不需要 git 协议。

> ✅ 永远不要提交或推送 `.gh-token.md` / 任何令牌文件。令牌只在本机本地使用。

---

## 1. 版本号(语义化)

`package.json` 的 `version` 与 `lib/index.js` 的 `VERSION` 必须一致。

| 变更类型 | 示例 |
|---|---|
| 修复 bug / 小优化(不改接口) | `0.13.9 → 0.13.10` |
| 新增功能(向后兼容) | `0.13.x → 0.14.0` |
| 破坏性变更(端点/行为不兼容) | `1.0.0` 起 |

发版前:
```sh
cd D:\00Software\DeepSeekHarness\dsh-fleet
npm run check      # node --check 两个文件 + BOM/JSON 扫描,必须全绿
```

---

## 2. 完整发布流程(每次发版)

### Step 1 · 本地更新版本号

编辑两处为同一个新版本号,例如 `0.14.0`:
- `package.json` → `"version": "0.14.0"`
- `lib/index.js` → `const VERSION = '0.14.0';`

然后:
```sh
npm run check
```

### Step 2 · 同步本机运行副本(可选,本机要立即生效才做)

```powershell
robocopy D:\00Software\DeepSeekHarness\dsh-fleet `
         C:\Users\loveXbanshee\.dsh\profiles\web\node_modules\dsh-fleet `
         /MIR /NFL /NDL /NJH /NJS /NP /XD .git
# 之后重启 dsh web:Start-Process powershell -ArgumentList '-File C:\Users\loveXbanshee\.dsh\relaunch-dsh-web.ps1' -WindowStyle Hidden
```

### Step 3 · 提交本地 git(仓库留痕)

```sh
git -C D:\00Software\DeepSeekHarness\dsh-fleet -c http.proxy= -c https.proxy= add -A
git -C D:\00Software\DeepSeekHarness\dsh-fleet -c http.proxy= -c https.proxy= `
    -c user.name="Punica Studio" -c user.email="punica@dsh-fleet.dev" `
    commit -m "chore: release v0.14.0 — <一句话说明>"
```

> 本地 `git push` 常失败——**不需要** push。仓库文件同步走 Step 4。

### Step 4 · 同步 8 个文件到 GitHub main(Contents API)

```powershell
$tok = ((Get-Content C:\Users\loveXbanshee\.dsh\gh-token.md -Raw) -split "`n" | % { $_.Trim() } | ? { $_ -match '^ghp_' } | Select-Object -First 1)
$env:GH_TOKEN = $tok
node "$env:TEMP\gh-sync-contents.mjs"     # 读取 .gh-token.md,PUT 8 个文件到 main
```

同步的文件: `package.json README.md LICENSE .gitignore cordis.patch.yml
client/client.js lib/index.js scripts/check-files.mjs`

> 这个脚本是"仓库文件同步器",它本身不建 tag/release。

### Step 5 · 打 tag + 建 GitHub Release

**推荐:用仓库内脚本 `scripts/release.mjs`**(自动:校验版本 → 拿 main HEAD
→ 建 `refs/tags/v<版本>` → 建 Release,附你提供的 Notes 文本)。

```powershell
node D:\00Software\DeepSeekHarness\dsh-fleet\scripts\release.mjs "v0.14.0"
```

> 可选参数:
> - `--notes-file <path>`: 从一个 markdown 文件读 Release Notes
> - 不带 notes 时脚本会打印模板提示,建议先准备 Notes(见 §3)

脚本内部(等价于手点 GitHub Web):
1. GET `repos/loveXbanshee/dsh-fleet/git/ref/heads/main` → 拿 HEAD sha
2. 若 tag 不存在:POST `/git/refs` `{ ref: "refs/tags/v0.14.0", sha }`
3. POST `/releases` `{ tag_name, name, body, draft: false }`

**不跑脚本、改走 Web 也行**:GitHub 页面 → `Releases` → `Draft a new release`
→ 选/建 tag `v0.14.0` → 粘贴 Notes → Publish。(Web 方式无需令牌,适合
首次或偶尔发布。)

### Step 6 · 验证发布

- 仓库页能看到 Release `v0.14.0` 与 tag;
- 下载/校验关键文件确实带新版本号:
  ```powershell
  curl.exe --noproxy "*" -s https://raw.githubusercontent.com/loveXbanshee/dsh-fleet/main/package.json
  # version 应为 0.14.0
  ```
- 可选:清 CDN 缓存(jsDelivr 只是第三兜底源,非必须):
  `POST https://purge.jsdelivr.net/  { "url": [...] }`(422 常表示无缓存,可忽略)

---

## 3. Release Notes 模板

```markdown
## ✨ 新增
- …

## 🐛 修复
- …

## 🔧 改进
- …

## ⚠️ 升级须知
- 请在各设备点「设置 → Harness Fleet → 更新并重启」;
  被控端(managed)机器同样更新后才会暴露新端点。

**安装**:`dsh plugin --profile web add github:loveXbanshee/dsh-fleet`
**文档**:[README.md](https://github.com/loveXbanshee/dsh-fleet/blob/main/README.md)
```

把笔记存成 `release-notes.md` 再执行:
```powershell
node scripts\release.mjs v0.14.0 --notes-file release-notes.md
```

---

## 4. 首发 / 补历史 tag(一次性)

当前仓库还没有任何 tag。第一次正式发布建议:

1. 确认 `main` 文件 = 最新版本(Step 4 已同步);
2. 直接执行 Step 5 建首个 tag(例如 `v0.13.11`),Notes 里简述 v0.2→v0.13 能力;
3. 之后每版按 §2 常规走。

> 说明:Contents API 同步产生的是"逐文件 sync"提交,历史不是本地 git 提交线;
> 首次建 tag 会指向 `main` 当前 HEAD,后续 release 均以"当前 main HEAD"为准,
> 文件内容与版本号一致即可,不必担心提交线样式。

---

## 5. 用户侧安装 / 更新(写给使用者,也可贴进 Release)

```sh
# 安装
dsh plugin --profile web add github:loveXbanshee/dsh-fleet

# 更新(在任一台装有本插件的机器)
# 设置 → Harness Fleet → 关于 · 测试期更新 → 检查更新 → 更新并重启
```

- 更新后 **重启 dsh web** 才加载新 host 代码(设置页按钮已做;
  旧版本在 Linux 上可能只更文件不自动重启,需手动重启一次);
- 遇到远程自签证书被 iframe 拦截:远程卡 →「证书」→ 按平台装受信任证书
  (见 README「证书助手」)。

---

## 6. 常见问题(FAQ)

**Q1 为什么 `git push` 失败?**
本机到 github.com 的 git 协议不稳。同步文件一律用 Contents API(§2 Step 4),
建 tag/release 用 REST API(Step 5),不依赖 git 协议。

**Q2 改了文件但远程「更新」后还是旧版本?**
多半是文件已更新但 dsh web 进程没重启(旧版 Linux 自动重启不可用)。
手动重启一次进程即可;`/api/state` 的 `version` 来自运行中进程。

**Q3 需要先建 Release 才能让用户更新吗?**
不需要——用户更新读的是 `main` 分支文件(Contents API 已同步即生效)。
Release/tag 的意义是**正式发布记录 + 稳定引用 + 市场准入**。

**Q4 上架插件市场?**
准备好 Release 后,可按市场要求提交(例如 dsh-market 类)。建议保留
`dsh.bundle` 声明与 `cordis.patch.yml`,市场/CLI 依赖它们自动登记。

---

## 7. 命令速查(本机)

```powershell
# 版本检查 + BOM 扫描
npm run check

# 同步文件到 GitHub main(Contents API)
$env:GH_TOKEN = (…从 .gh-token.md 取…)
node "$env:TEMP\gh-sync-contents.mjs"

# 建 tag + Release(REST API,需 GH_TOKEN 环境变量)
node scripts\release.mjs v0.14.0 --notes-file release-notes.md
```

> 令牌来源: `C:\Users\loveXbanshee\.dsh\gh-token.md` 或仓库根 `.gh-token.md`
> (仅本机使用,勿提交)。
