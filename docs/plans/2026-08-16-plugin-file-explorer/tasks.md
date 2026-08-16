# plugin-file-explorer 实施任务分解（tasks.md）

> 前置：`docs/plans/2026-08-16-plugin-file-explorer/spec.md` 已评审通过。
> 全部改动集中在 `plugins/plugin-file-explorer/` 两个文件：host `lib/index.js`、浏览器 `lib/client.js`。
> 每任务完成后按 `checklist.md` 对应条目自测；全部完成跑一遍 E 组稳定性项。
> 提交粒度：一个任务一个 commit（`feat: …`），消息带具体业务词（文件树/编辑器/Tab）。

## T1 host 路由：/create /rename /delete（FR2.2-2.4）

**文件**：`plugins/plugin-file-explorer/lib/index.js`（修改，在 `/write` 注册后追加）

- [ ] 1.1 新增通用 `safeResolve`（已存在）复用；新增 host 侧 `ensureNoEscape` 校验与重名检查辅助。
- [ ] 1.2 注册 `/dshkit-fs/create`：POST body `{session, dir, name, kind, content?}`；`dir` 相对工作区根解析；重名返回 `{ok:false,error:"exists"}`；名称校验（非空、不含 `/\`、不含 `\0`）；kind=file 时可带 `content` 初始内容，kind=dir 忽略 content。
- [ ] 1.3 注册 `/dshkit-fs/rename`：POST body `{session, path, name}`；目标路径重名返回 `exists`；文件/目录统一 `rename`。
- [ ] 1.4 注册 `/dshkit-fs/delete`：POST body `{session, path}`；目录 `rm(dir,{recursive:true,force:false})`（不存在返回 `not found`）。
- [ ] 1.5 三路由统一 `isTrustedRequest` 门禁 + 异常兜底 `{ok:false,error}`；`/read` 增加大小上限（>5MB 拒绝）与二进制嗅探（内容含 NUL 返回 `{ok:false,error:"binary"}`）。

关键片段（create handler 骨架）：

```js
async function createEntry(ctx, root, dir, name, kind, content) {
  const parent = safeResolve(root, dir || ".");
  if (!parent) return { ok: false, error: "invalid path" };
  if (!name || /[\\/\0]/.test(name)) return { ok: false, error: "invalid name" };
  const target = resolve(parent, name);
  const relCheck = relative(root, target);
  if (relCheck.startsWith("..")) return { ok: false, error: "invalid path" };
  try { await fsStat(target); return { ok: false, error: "exists" }; }
  catch { /* not exist, proceed */ }
  if (kind === "dir") await fsMkdir(target, { recursive: false });
  else await writeFileWithFallback(ctx, target, content ?? "");
  return { ok: true, path: relative(root, target).split(sep).join("/") };
}
```

- [ ] 1.6 自测：curl 同源/越权/重名/二进制各一例，返回符合 spec §6。
- [ ] 1.7 commit：`feat: 文件树新增新建/重命名/删除 host 路由并加读取大小与二进制防护`

## T2 文件树操作 UI（FR2.2-2.7）

**文件**：`plugins/plugin-file-explorer/lib/client.js`（修改 `FilesTab` / `TreeNode`）

- [ ] 2.1 `FilesTab` 顶部加工具栏：`新建文件` `新建文件夹` `刷新` `全部展开` `全部收起`；新建走输入框（`prompt` 或内联 input，内联优先）。
- [ ] 2.2 记录当前展开目录集合（`expandedPaths:Set`）与根；新建默认落在最近展开的目录；`全部展开/收起` 维护该集合。
- [ ] 2.3 `TreeNode` 行 hover 显示操作按钮（重命名、删除）；目录行再加「新建文件/文件夹在此」；按钮点击 `stopPropagation`。
- [ ] 2.4 文件操作请求封装：`api(method, url, body)` 统一 JSON 处理；成功后派发 `dshkit:fschanged {sessionId, path}` 触发树重载。
- [ ] 2.5 删除目录用 `confirm` 二次确认；重命名/新建用内联 input（预填原名、Enter 提交、Esc 取消）。
- [ ] 2.6 操作结果失败在树顶部状态行展示（复用 `dfx-status`）。
- [ ] 2.7 订阅 `dshkit:fschanged`：树重载 + 若操作的是已打开文件（重命名→更新 Tab 标题与 store path；删除→关闭 Tab）。

关键片段（TreeNode 行操作按钮）：

```jsx
jsxs("button", { className: "dfx-treeRow", ...,
  children: [
    jsx("span", { className: "dfx-treeIcon", children: isDir ? (open ? "▾" : "▸") : "•" }),
    jsx("span", { className: "dfx-treeName", children: node.name }),
    hover && jsxs("span", { className: "dfx-treeOps", onClick: (e) => e.stopPropagation(),
      children: [
        jsx("button", { onClick: () => renameNode(node) }, "✎"),
        jsx("button", { onClick: () => removeNode(node) }, "🗑"),
      ] }),
  ] })
```

- [ ] 2.8 自测：对照 checklist B1-B8。
- [ ] 2.9 commit：`feat: 文件树工具栏与行操作（新建/重命名/删除/刷新/展开收起）`

## T3 编辑器增强：行号、缩进、快捷键、脏标记、未保存确认（FR3.3-3.5）

**文件**：`plugins/plugin-file-explorer/lib/client.js`（修改 `FileEditorTab`，新增 chrome）

- [ ] 3.1 编辑器改为「行号 gutter + textarea」双栏布局（CSS flex）；行号由内容分行计算，滚动同步（textarea `onScroll` 更新 gutter `scrollTop`）。
- [ ] 3.2 `onKeyDown`：Tab → 插入 4 空格并 `preventDefault`；Ctrl+S → 保存；Ctrl+W → 触发关闭确认。
- [ ] 3.3 脏标记：`dirty` 状态 + chrome 显示 `● 未保存`；保存成功清除。
- [ ] 3.4 关闭确认：dirty 时 `confirm("文件尚未保存，确定关闭？")`；确认后派发 `dshkit:closefile {path}`。
- [ ] 3.5 chrome 布局：文件名（左）+ 状态/脏标记（中）+ `关闭` `保存` 按钮（右），位于 textarea 上方。
- [ ] 3.6 会话切换联动：订阅 `sessions.list`，current 变化 → 派发 `dshkit:closeallfiles`（apply 侧 dispose 全部文件 Tab 并清 store）。

关键片段（Tab 缩进）：

```js
const onKeyDown = (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const el = e.currentTarget;
    const s = el.selectionStart, en = el.selectionEnd;
    const next = content.slice(0, s) + "    " + content.slice(en);
    setContent(next); setDirty(true);
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 4; });
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault(); save();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
    e.preventDefault(); requestClose();
  }
};
```

- [ ] 3.7 自测：对照 checklist C1-C9。
- [ ] 3.8 commit：`feat: 编辑器行号/缩进/Ctrl+S/Ctrl+W 与脏标记及未保存确认`

## T4 语法高亮与图片/二进制预览（FR3.6 / FR5，可选，可拆两个 commit）

**文件**：`plugins/plugin-file-explorer/lib/client.js`（修改 `FileEditorTab`）

- [ ] 4.1 扩展名→语言映射表（js/ts/jsx/tsx/py/json/md/html/css/yml/sql/…）。
- [ ] 4.2 CDN 按需加载 CodeMirror 6（`<script>` 注入 + Promise 封装，超时 6s 回退）：成功 → CodeMirror 编辑（`basicSetup` + 语言包），失败 → 现有 textarea。
- [ ] 4.3 图片预览：扩展名白名单 + `/read` 返回 `{ok, base64}`（host `/read` 对图片走 `fs.readFile` buffer → base64，加 2MB 上限）；渲染 `<img src="data:image/...;base64,...">` 只读。
- [ ] 4.4 其他二进制：host `/read` 已返回 `binary` 错误 → 编辑器显示「二进制文件，不支持编辑」。
- [ ] 4.5 自测：对照 checklist D1-D2、C3 回退路径。
- [ ] 4.6 commit：`feat: 编辑器语法高亮（CDN 按需，离线回退）与图片/二进制只读预览`

## T5 收尾与验收

- [ ] 5.1 全量自测：checklist A-E 逐项过一遍（需真实 dsh 环境 + 启用的插件）。
- [ ] 5.2 检查控制台无插件报错；卸载插件后界面恢复默认（checklist E4）。
- [ ] 5.3 更新 `plugins/README.md` 的插件说明表（补充文件操作与编辑器能力描述）。
- [ ] 5.4 commit：`docs: 更新文件列表插件说明`（若 README 有改动）；最终确认全部改动已提交。

## 参考

- 槽位/服务事实：`docs/dsh-client-plugin-api-report.md` §2、§3.4（`sidebar.workspaces`、`conversation.view`）、§6
- 标签环 active 回落：ui-conversation `resolveActiveView`（`DEFAULT_VIEW_ID="chat"`）
- 现状实现：`plugins/plugin-file-explorer/lib/client.js`、`lib/index.js`
