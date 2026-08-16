# plugin-file-explorer 需求规格：会话/文件双 Tab + 类 VS Code 多 Tab 编辑器

> 版本：v1.0 · 2026-08-16 · 状态：评审中
> 关联代码：`plugins/plugin-file-explorer/`（host 半区 `lib/index.js`、浏览器半区 `lib/client.js`）
> 平台事实来源：`docs/dsh-client-plugin-api-report.md` + `dsh-client-ui-conversation/lib/client.js`（npm-cache 内已装包）逐行核实

---

## 1. 背景与目标

DeepSeek Harness（dsh）web 客户端默认布局：左侧为「会话」浏览区（`sidebar.workspaces`），中间为单 Tab 聊天区（`conversation.view` 默认只有 `chat`）。业务需要一个类 VS Code 的文件工作区：

- 左侧工作区在「会话列表」与「文件列表」之间切换；
- 文件列表展示当前会话工作区的全部文件，并具备常规文件操作；
- 点击文件后，中间聊天区变为多 Tab（默认 Tab「对话」不可关闭），每个文件 Tab 是一个可编辑的编辑器（VS Code 编辑区模式）。

现状：`plugins/plugin-file-explorer` 已实现主体能力。本 spec **盘点现状**并**补齐差距**，最终形态对标 VS Code 的文件树与编辑区。

---

## 2. 现状盘点（已实现，保留）

| 需求点 | 现状实现 | 位置 |
| --- | --- | --- |
| 左侧双 Tab（会话/文件） | 影子覆盖 `sidebar.workspaces`（`priority:-10`），渲染 `SidebarWorkspacesTabs` | [client.js](file:///d:/work/mgc/deepseek-harness-kit/plugins/plugin-file-explorer/lib/client.js) `SidebarWorkspacesTabs` |
| 会话列表 | 读 `sessions.list` 按 mtime 倒序，点击 `sessions.open(id)` | 同上 `SessionsTab` |
| 文件树 | `/dshkit-fs/tree` 递归构建（depth≤12，跳过 `.git`/`node_modules`），`TreeNode` 展开/收起，点击文件派发 `dshkit:openfile` | `FilesTab` / `TreeNode`；host `lib/index.js` `/tree` |
| 中间多 Tab | 动态 `ctx.slots.register` 进 `conversation.view`（`id:"file:<path>"`，`order:1000`，label=文件名）；重复打开幂等（`fileEntryDisposers` Map）；关闭即 dispose 注册 | `registerFileView` / `unregisterFileView` |
| 默认 Tab 不可关闭 | `chat`（`id:"chat"`，`order:0`）为 ui-conversation 内置注册，`DEFAULT_VIEW_ID="chat"`；插件不触碰，天然不可关 | ui-conversation `viewTabs`/`resolveActiveView` |
| 文件编辑 | `FileEditorTab`：textarea + 保存/关闭按钮，经 `/dshkit-fs/read`、`/write` 读写 | `FileEditorTab`；host `/read`、`/write` |
| 安全基线 | host 路由 trusted-host 校验（127.0.0.1/localhost）+ `safeResolve` 防路径逃逸 | `lib/index.js` `isTrustedRequest` / `safeResolve` |
| 宿主能力 | 工作目录解析：`session.header.cwd` → `workspaceRegistry` 匹配；`ctx.fs`（listDir/readText/writeText）+ `node:fs` 兜底 | `lib/index.js` `resolveSessionDir` 等 |

---

## 3. 平台约束（实测，影响设计取舍）

1. **`sidebar.workspaces` 是 single 槽位**，只能整块影子覆盖，无法在「会话」旁新增原生 seat → 双 Tab 由插件自绘。
2. **`conversation.view` 标签环只渲染 `label` 文本**（`viewTabs()` 里 `label: resolveSlotLabel(entry.options.label)`），按钮内容为纯文本，**无法内嵌 × 关闭按钮**（ui-conversation `ConversationSessionHeader` L6998-7007）。关闭文件的入口只能是：编辑器内容区内的关闭按钮、快捷键。
3. **active 文件 Tab 被 dispose 后自动回落**：`resolveActiveView(tabs, selectedId)` 在请求 id 不在 `tabs` 时回退 `DEFAULT_VIEW_ID="chat"`（L6916-6919）→ 关闭当前文件后回到对话，无需插件处理 active 重置。
4. **Tab label thunk 仅在「槽位注册变化 / 会话 `s.view` 变化」时重求值**（标签环由 `useSyncExternalStore(views.subscribe, views.version)` 驱动）→ 实时脏标记（`●`）放 Tab label 不可靠，应放在编辑器内容区自绘的 chrome 上。
5. **插件 bundle 无打包步骤，`require` 仅解出 10 个 seed 模块**（react、ui-primitives 等，见 API 报告 §1.3）→ 无法在插件内 npm 引入 CodeMirror 等编辑器库；语法高亮只能「CDN 按需加载」或「轻量自研」，且须有离线回退。
6. **host 半区通过 `ctx.webServer.register` 提供同源 JSON 路由**，浏览器端相对路径 `fetch` 调用；`ctx.fs.listDir` 只列目录，列文件需 `ctx.fs.listDir` + 兜底或直接 `node:fs`（现状已处理）。
7. 会话维度：槽位组件在无会话时不渲染（strict session scope），文件树/编辑器需以 `sessionId` 为数据源，切换会话时清空文件 Tab。

---

## 4. 功能需求

### FR1 侧边栏双 Tab（保持现状）
- 左侧工作区顶部两个 Tab：「会话」「文件」，切换即显示对应面板。

### FR2 文件树（增强 → 常规文件操作）
- FR2.1 展示当前会话工作区全量文件（目录优先、按名排序、深度≤12、跳过 `.git`/`node_modules`），目录可展开/收起。
- FR2.2 **新建**：支持在任一目录下新建文件 / 新建文件夹（输入名称，默认当前展开目录，空/非法名提示）。
- FR2.3 **重命名**：文件或目录均可重命名（行内输入或弹窗输入，校验重名/非法字符）。
- FR2.4 **删除**：文件或目录均可删除（目录递归删除，二次确认弹窗）。
- FR2.5 **刷新**：手动刷新整棵树（重新请求 `/tree`）。
- FR2.6 **全部展开 / 全部收起**：工具栏一键操作。
- FR2.7 操作入口：树根工具栏（新建文件/文件夹、刷新、全部展开/收起）+ 树行 hover 操作按钮（重命名、删除）；所有操作失败有 toast/行内错误提示。

### FR3 中间多 Tab 编辑器（增强 → VS Code 编辑区模式）
- FR3.1 **打开**：点击文件树中的文件 → 中间标签环出现该文件 Tab（label=文件名）；重复点击已打开文件 → 激活已有 Tab（不重复注册）。非文本文件（图片/二进制）走 FR5 预览。
- FR3.2 **默认 Tab**：初始只有「对话」（`chat`，order 0），不可关闭。
- FR3.3 **关闭**：编辑器内关闭按钮 或 `Ctrl+W`；关闭后若为 active，标签环自动回落「对话」或相邻文件 Tab；有未保存修改时弹确认。
- FR3.4 **编辑器 chrome**（编辑器内容区顶部自绘，标签环之外的区域）：文件名 + 脏标记（未保存 `●`）+ 保存按钮 + 关闭按钮。
- FR3.5 **编辑体验**：
  - 行号 gutter（可点击跳转或仅展示）；
  - `Tab` 键插入 4 空格缩进（不丢失焦点）；
  - `Ctrl+S` 保存、`Ctrl+W` 关闭、`Ctrl+Z/Y` 撤销重做（浏览器原生）；
  - 保存成功/失败的状态提示；
  - 加载失败展示错误并可重试。
- FR3.6 **语法高亮（可选增强）**：CDN 按需加载 CodeMirror 6（或同等库），加载失败自动回退纯文本 textarea；高亮语言按扩展名映射（js/ts/py/json/md/html/css/…）。

### FR4 会话列表（保持现状）
- 会话 Tab 列出 profile 会话（mtime 倒序），点击切换当前会话；当前会话高亮；文件树随当前会话切换。

### FR5 非文本文件只读预览（可选增强）
- 扩展名白名单判定：图片（png/jpg/gif/webp/svg 等）渲染 `<img>`（base64 data URL，大小上限如 2MB）；其余二进制提示「二进制文件，不支持编辑」；超大文本（>512KB）只读。

---

## 5. 架构设计

```
┌────────────────────────────── dsh web 客户端 ──────────────────────────────┐
│ 浏览器半区 plugin-file-explorer/lib/client.js（__ModuleLoader__ bundle）      │
│  ├─ SidebarWorkspacesTabs ── 影子覆盖 sidebar.workspaces（priority:-10）      │
│  │    ├─ SessionsTab：sessions.list 订阅                                   │
│  │    └─ FilesTab：/tree 拉树 → TreeNode（展开/收起/操作按钮）               │
│  ├─ FileEditorTab ── conversation.view 条目（id:"file:<path>"，order:1000）  │
│  │    └─ 编辑器 chrome（脏标记/保存/关闭）+ 行号 gutter + textarea/CodeMirror │
│  ├─ 事件总线：dshkit:openfile / dshkit:closefile / dshkit:fschanged         │
│  └─ viewStore（defineStore）：openFiles[]、active、dirtyByPath                │
│                    │ 同源相对 fetch
│  ┌─────────────────┴────────────── dsh host ───────────────────────────────┐
│  │ host 半区 plugin-file-explorer/lib/index.js（cordis plugin）             │
│  │  ├─ GET  /dshkit-fs/tree?session=&dir=    ← 已实现                       │
│  │  ├─ GET  /dshkit-fs/read?session=&path=   ← 已实现                       │
│  │  ├─ POST /dshkit-fs/write                 ← 已实现                       │
│  │  ├─ POST /dshkit-fs/create   （FR2.2）新增                               │
│  │  ├─ POST /dshkit-fs/rename   （FR2.3）新增                               │
│  │  ├─ POST /dshkit-fs/delete   （FR2.4）新增                               │
│  │  └─ 通用：resolveSessionDir / safeResolve / trusted-host / node:fs 兜底  │
│  └──────────────────────────────────────────────────────────────────────────┘
└──────────────────────────────────────────────────────────────────────────────┘
```

### 数据流
1. **打开文件**：FilesTab 点击 → `window.dispatchEvent(dshkit:openfile {path,name,sessionId})` → apply 内 `registerFileView` → `ctx.slots.inject("conversation.view", …register…)`（幂等 Map）→ 标签环出现新 Tab；FileEditorTab 挂载后 `fetch /read` 加载内容。
2. **保存**：FileEditorTab `Ctrl+S`/按钮 → `fetch /write` → 成功清 dirty、toast；失败保留 dirty 并提示。
3. **文件操作**：FilesTab 发 `/create|rename|delete` → 成功后派发 `dshkit:fschanged {sessionId,path}` → 树重载；若操作对象正被打开（重命名/删除），联动更新/关闭对应文件 Tab。
4. **关闭**：编辑器内关闭/Ctrl+W → dirty 则确认 → `unregisterFileView(path)`（dispose 注册）→ 标签环移除该 Tab，active 自动回落。

---

## 6. 接口设计（host 路由）

统一约定：同源相对 fetch；响应 `{ ok:boolean, ...data, error? }`；所有路由先过 `isTrustedRequest`；所有 path 经 `safeResolve(root, rel)`，越权返回 `{ok:false,error:"invalid path"}`。

### 已实现（保持不变）
| 路由 | 方法 | 参数 | 返回 |
| --- | --- | --- | --- |
| `/dshkit-fs/tree` | GET | `session`, `dir`(可选，相对根，默认"") | `{ok, root, tree}` |
| `/dshkit-fs/read` | GET | `session`, `path` | `{ok, content}` |
| `/dshkit-fs/write` | POST | body `{session, path, content}` | `{ok}` |

### 新增
| 路由 | 方法 | 参数 | 返回 | 语义 |
| --- | --- | --- | --- | --- |
| `/dshkit-fs/create` | POST | `{session, dir, name, kind:"file"\|"dir", content?}` | `{ok, path}` | 在 `dir` 下创建文件/文件夹；重名或名称为空/含 `/\0` 报错 |
| `/dshkit-fs/rename` | POST | `{session, path, name}` | `{ok, path}` | 重命名文件/目录；目标重名报错 |
| `/dshkit-fs/delete` | POST | `{session, path}` | `{ok}` | 删除文件；目录递归删除（host 侧确认存在性） |

响应错误码：`invalid path`（越权）/ `exists`（重名）/ `not found` / 系统错误透传 message。

---

## 7. 边界与风险

| # | 风险/边界 | 处理 |
| --- | --- | --- |
| 1 | 标签环无法内嵌 × 关闭按钮（平台约束） | 关闭入口=编辑器 chrome 关闭按钮 + Ctrl+W；spec 明确告知用户此限制 |
| 2 | 实时脏标记放 Tab label 不可靠 | 脏标记放编辑器 chrome；Tab label 保持纯文件名 |
| 3 | 关闭文件的确认：文件 Tab 仅 active 时可见其 chrome | 关闭动作必然发生在 active 文件上（非 active 文件的关闭走 Ctrl+W 需要 active 化后触发），确认逻辑集中在编辑器内即可 |
| 4 | 二进制/超大文件 utf8 读取乱码或卡顿 | host `/read` 加大小上限（如 5MB）+ 二进制嗅探（NUL 字节）；浏览器端按扩展名白名单分流 FR5 |
| 5 | 语法高亮 CDN 依赖网络 | 加载失败/超时回退纯 textarea；CDN 地址做成常量便于替换 |
| 6 | 切换会话后文件 Tab 残留 | 订阅 `sessions.list`，current 变化时 dispose 全部文件 Tab 并清空 viewStore |
| 7 | 目录递归删除误删 | 删除前二次确认；host 限制仅允许删工作区根之下 |
| 8 | `/tree` 深度 12 截断 | 保持现状（防大目录卡死），工具栏提供「加载更多/进入子目录」不在本期范围 |

---

## 8. 非功能需求

- **零构建**：沿用 `__ModuleLoader__` 手写 bundle + ESM host 半区，不引入打包步骤（保持 plugins/README 约定）。
- **无新 npm 依赖**：host 侧仅 node:fs/path 内置；浏览器侧仅 seed 模块。
- **i18n**：中文为主，词典注册进独立 NS（`file-explorer`），界面文案集中管理。
- **安全性**：所有 host 路由 trusted-host + safeResolve；删除/写入仅在解析出的工作区根内。
- **性能**：树按需展开（现状整棵拉取 depth≤12，可接受）；文件读取按需、一次性。
