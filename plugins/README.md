# 内置插件目录（plugins/）

本目录存放项目自带的 dsh（DeepSeek Harness）内置插件。每个插件遵循
`@dsh-kit/*` 结构，启用后会被挂载到 dsh 服务的 web 界面里。

## 结构约定

每个内置插件是一个独立子目录，含以下文件：

| 文件 | 作用 |
| ---- | ---- |
| `package.json` | 包清单。`dsh.bundle.patch` 指向 `cordis.patch.yml`；`dsh.client` 声明浏览器端注入的运行时服务（`platform:"web"`、`inject:[...]`）；`exports["./client"]` 指向浏览器端 bundle。 |
| `cordis.patch.yml` | loader 补丁：`- insert: - id: <id> / name: '<@dsh-kit/包名>'`，作用：加载器安装该插件（host 端），并把它作为 `dsh.client` 行入浏览器启动集。 |
| `lib/index.js` | Host 半区（ESM）：`export { name, inject, apply(ctx) }`。可注册 `ctx.webServer` 路由、访问 host 服务（`ctx.get("sessions")`、`ctx.get("workspaceRegistry")` 等）。纯客户端插件可为空 `apply`。 |
| `lib/client.js` | 浏览器半区：`window.__ModuleLoader__.load({ id, factory: (require) => module })`，导出 `{ apply(ctx), inject }`。`ctx.slots` / `ctx.locale` / `ctx.get("sessions")` 等可用。 |
| `install.mjs` | Bootstrap 安装脚本：把插件 junction 链接进 dsh profile 并写入 profile manifest。 |

## Host 半区要点

- 服务名是 **`ctx.workspaceRegistry`**（不是 `workspaces`）；`workspaces` 是客户端侧的
  `WorkspaceRuntime`。
- 会话工作目录：**`ctx.sessions.get(sessionId).header.cwd`**（dsh-session 校验过的绝对路径），
  回退 `ctx.workspaceRegistry.list()` 按 `sessionIds` 匹配的 `path`。
- 注册 JSON 路由：`ctx.webServer.register({ kind:"exact", path, handler })`，handler 为
  `async (req, res)`（node:http）。浏览器端用**同源相对 `fetch`** 调用（不被 `/api` 兜底拦截）。

## 客户端半区要点

- 插件入口：`window.__ModuleLoader__.load({ id, factory })`，工厂内 `require` 解出
  react / 基元组件等。
- 槽位注入：`ctx.slots.inject("<slot>", () => ctx.slots.register({ name, ... }, Component))`。
- 会话当前 id：客户端无 host 侧"当前会话"；读
  `ctx.get("sessions").list.getSnapshot().current`，订阅 `.list.subscribe(fn)`。
- **单例槽的影子覆盖**：`sidebar.workspaces` 是 `kind:"single"`，默认优先级 0；
  用更低 `priority`（如 -10）注册即可覆盖它并接管渲染（替换会话浏览区，无新增 seat）。
- **中间多 Tab（类 VS Code）**：用 `conversation.view`（`kind:"list"`、`scope:"session"`）
  标签环。注册 `{ name:"conversation.view", id:<唯一>, order, label:()=>t/tab标题, locale,
  store?, inject }` 即可把一个自定义组件变成中心的一个 Tab；当注册数 >1 时显示标签栏。
  内置对话 Tab 的 `id` 是 `"chat"`（`order:0`）；文件编辑器用 `id` 如 `"file:<path>"`。
  打开/关闭文件时动态 `ctx.slots.register` / 调用其 disposer 即可增删 Tab。
- `ctx.locale.setLocale("zh")` 会整体切中文；插件还可自行注册/覆盖词典
  （`ctx.locale.register(ns, {zh, en})`）。

## 启用 / 停用（= 桌面端开关）

启用一个内置插件的操作（与 `install.mjs` 一致）：

1. 把 `plugins/<name>` junction 链接进 `~/.dsh/profiles/web/node_modules/@dsh-kit/<name>`；
2. 在 `~/.dsh/profiles/web/package.json` 里：
   - `dependencies["@dsh-kit/<name>"] = "0.1.0"`
   - `dsh.profile.bundles` 追加 `"@dsh-kit/<name>"`
3. **重启 dsh 服务**后生效。

停用则撤销第 1 步的链接并从 `bundles` / `dependencies` 移除。
桌面应用在「设置 → 内置插件」提供开关，底层即调用上述逻辑
（见 `src-tauri/src/plugins.rs` 的 `list_builtin_plugins` / `set_builtin_plugin_enabled`）。

## 现有插件

| 插件 | 说明 |
| ---- | ---- |
| `plugin-i18n-zh` | 汉化 UI：`ctx.locale.setLocale("zh")` 整体切中文 + MutationObserver DOM 兜底翻译。纯客户端。 |
| `plugin-file-explorer` | 文件列表：侧边栏工作区改「会话 / 文件」双 Tab；文件 Tab 文件树展示当前会话工作区，支持常规文件操作（新建文件/文件夹、重命名、删除、刷新、全部展开/收起，目录行 hover 快捷入口）。点击文件后，利用 dsh 的中间标签环 `conversation.view`（list/session）动态注册一个新 Tab（label=文件名），于是中间变为「对话 \| 文件A \| 文件B …」多 Tab（默认 Tab 仍是对话、不可关闭）。文件 Tab 按扩展名分派不同组件：txt/代码 → 行号 + CodeMirror 语法高亮编辑；json → 专门编辑器（实时校验、格式化/压缩、非法阻止保存）；md → 左编辑右预览分屏（内置轻量 Markdown 渲染）；html → 左编辑右实时预览分屏（iframe 沙箱、300ms 防抖）；图片/视频 → 专用媒体 webview（`/dshkit-fs/media` 流式输出、支持 Range 拖动进度，`<img>`/`<video>` 直接引用）；doc/docx/xls/xlsx/ppt/pptx/pdf 等 → 提示用系统默认应用打开（`/dshkit-fs/open` 调用 explorer/open/xdg-open）；其余二进制 → 拦截。支持 Ctrl+S 保存、Ctrl+W 关闭、脏标记与未保存确认。host 提供 `/dshkit-fs/tree\|read\|write\|create\|rename\|delete\|media\|open` 路由，列目录用 `ctx.fs.listDir`（dsh 的 `host.listDirectory` 只返回目录，故需自建路由），读/写用 `ctx.fs.readText` / `ctx.fs.writeText`，均有 node:fs 兜底。 |
| `plugin-theme-skin` | 主题换肤：`ctx.theme.overrideTokens()` 覆盖 `--dsw-alias-*` 令牌色（品牌色/底色/面板色/边框/文字/状态色/侧边栏色），即时生效；并注入固定全屏媒体层做背景，支持图片与 GIF / APNG / 动态 WebP 等动态图，以及 MP4 / WebM / OGG 等视频（自动静音循环）。开启背景时把应用表面背景令牌覆盖为半透明让背景透出，叠加可调遮罩保证可读。本地文件经 IndexedDB 持久化，远程 URL 直接引用；配置写入 `settingsScope`（host 设置文档）与 localStorage。设置入口：设置 → 主题换肤。纯客户端。 |

> 插件市场（安装新插件到本目录）由**桌面端**侧边栏的「插件市场」面板提供：
> 它在桌面应用内部扫描本目录列出/启停内置插件，并可把从 GitHub 仓库下载的
> `@dsh-kit/*` 工具解压成一个新的内置插件子目录，之后即可在「设置 → 内置插件」
> 或同一面板中启用。
