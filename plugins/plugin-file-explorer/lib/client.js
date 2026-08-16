// @dsh-kit/plugin-file-explorer — browser half.
// 文件列表插件：
//   1. 侧边栏工作区：把默认会话浏览区替换成「会话 / 文件」两个 Tab。
//      - 「会话」：列出当前 profile 的会话（按时间倒序），点击打开当前会话。
//      - 「文件」：以文件树展示当前会话工作区目录，点击文件在中间打开编辑。
//   2. 中间多 Tab 编辑器：利用 dsh 的 `conversation.view` 中间标签环。默认只有
//      「对话」这个 Tab；打开某个文件后动态注册一个新的 `conversation.view` 条目
//      （label=文件名），于是中间出现「对话 | 文件A | 文件B …」多 Tab，
//      每个文件 Tab 都是一个可编辑的文本编辑器（可保存、关闭）。类似 VS Code。
//
// 与 @dsh-kit/plugin-market 同构：__ModuleLoader__ 手写 bundle，无构建步骤。

window.__ModuleLoader__.load({
  id: "@dsh-kit/plugin-file-explorer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");
    let runtimectx = require("@deepseek-ai/dsh-client-runtime/client");

    const { jsx, jsxs, Fragment } = react_jsx_runtime;
    const { useState, useEffect, useRef, useCallback, useMemo } = react;
    const defineStore = runtimectx && runtimectx.defineStore;
    const resolveWorkspacePath = runtimectx && runtimectx.resolveWorkspacePath;

    //#region styles
    const css = [
      ".dfx-root{display:flex;flex-direction:column;width:100%;min-width:0;height:100%}",
      ".dfx-tabs{display:flex;gap:2px;padding:4px 2px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#343b48);flex:none}",
      ".dfx-tab{cursor:pointer;border:none;background:none;color:var(--dsw-alias-label-secondary,#aab1bd);font:inherit;font-size:12.5px;line-height:20px;padding:5px 12px;border-radius:8px 8px 0 0;flex:none}",
      ".dfx-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
      ".dfx-tab.dfx-tabActive{color:var(--dsw-alias-label-primary,#eceff4);background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.1))}",
      ".dfx-body{flex:1;min-height:0;overflow:auto;padding:6px 2px}",
      ".dfx-empty{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:12px;line-height:18px;padding:10px 12px}",
      ".dfx-sessionRow{cursor:pointer;display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;text-align:left;border:none;background:none;color:var(--dsw-alias-label-primary,#eceff4);font:inherit;font-size:13px;line-height:20px;padding:7px 10px;border-radius:8px}",
      ".dfx-sessionRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
      ".dfx-sessionRow.dfx-active{background:var(--dsw-alias-state-business-primary-muted,rgba(76,141,255,.14));color:var(--dsw-alias-state-business-primary,#4c8dff)}",
      ".dfx-sessionTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}",
      ".dfx-treeNode{display:flex;flex-direction:column}",
      ".dfx-treeRow{position:relative;cursor:pointer;display:flex;align-items:center;gap:6px;border:none;background:none;color:var(--dsw-alias-label-secondary,#aab1bd);font:inherit;font-size:12.5px;line-height:20px;padding:4px 4px;border-radius:6px;text-align:left;min-width:0;width:100%;box-sizing:border-box}",
      ".dfx-treeRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
      ".dfx-treeIcon{flex:none;width:16px;color:var(--dsw-alias-label-tertiary,#7d8592)}",
      ".dfx-treeName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#eceff4)}",
      ".dfx-treeChildren{margin-left:14px;display:flex;flex-direction:column}",
      ".dfx-treeOps{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:none;align-items:center;gap:2px;background:var(--dsw-alias-bg-layer-1,#15181f);border-radius:6px;padding:1px 2px}",
      ".dfx-treeRow:hover .dfx-treeOps{display:flex}",
      ".dfx-treeOps button{cursor:pointer;border:none;background:none;color:var(--dsw-alias-label-tertiary,#7d8592);font:inherit;font-size:11px;line-height:16px;padding:0 3px;border-radius:4px}",
      ".dfx-treeOps button:hover{color:var(--dsw-alias-label-primary,#eceff4);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
      ".dfx-toolbar{display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,#343b48);flex:none}",
      ".dfx-toolBtn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#343b48);background:none;color:var(--dsw-alias-label-secondary,#aab1bd);font:inherit;font-size:11.5px;line-height:18px;border-radius:6px;padding:1px 8px}",
      ".dfx-toolBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#eceff4)}",
      ".dfx-inlineInput{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-state-business-primary,#4c8dff);outline:none;background:var(--dsw-alias-bg-layer-1,#15181f);color:var(--dsw-alias-label-primary,#eceff4);font:inherit;font-size:12.5px;line-height:20px;border-radius:6px;padding:1px 6px}",
      ".dfx-createRow{display:flex;align-items:center;gap:6px;padding:4px 10px}",
      ".dfx-createLabel{color:var(--dsw-alias-label-secondary,#aab1bd);font-size:11.5px;line-height:18px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:50%}",
      ".dfx-status{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:11px;line-height:16px;padding:2px 10px}",
      // file editor body
      ".dfx-editor{flex:1;min-height:0;display:flex;flex-direction:column;padding:10px 12px}",
      ".dfx-editorChrome{flex:none;display:flex;align-items:center;gap:10px;padding:6px 2px 8px}",
      ".dfx-editorName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#eceff4);font-size:13px;line-height:20px;font-weight:500}",
      ".dfx-editorWrap{flex:1;min-height:0;display:flex;border:1px solid var(--dsw-alias-border-l2,#343b48);border-radius:8px;overflow:hidden}",
      ".dfx-gutter{flex:none;width:44px;box-sizing:border-box;overflow:hidden;padding:10px 6px 10px 10px;text-align:right;background:var(--dsw-alias-bg-layer-1,#15181f);color:var(--dsw-alias-label-tertiary,#7d8592);font-family:Consolas,monospace;font-size:12.5px;line-height:20px;white-space:pre;user-select:none}",
      ".dfx-editorWrap textarea{flex:1;box-sizing:border-box;border:none;outline:none;resize:none;padding:10px;background:var(--dsw-alias-bg-layer-1,#15181f);color:var(--dsw-alias-label-primary,#eceff4);font-family:Consolas,monospace;font-size:12.5px;line-height:20px;min-height:120px}",
      ".dfx-imagePreview{flex:1;min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:16px}",
      ".dfx-imagePreview img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}",
      ".dfx-mediaPreview{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:16px}",
      ".dfx-mediaPreview video{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;background:#000}",
      ".dfx-docBar{flex:none;display:flex;align-items:center;gap:10px;padding:14px 2px}",
      // json / markdown / html viewers
      ".dfx-jsonBar{flex:none;display:flex;align-items:center;gap:8px;padding:0 2px 6px;flex-wrap:wrap}",
      ".dfx-jsonOk{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:11px;line-height:16px}",
      ".dfx-jsonErr{color:var(--dsw-alias-state-error-primary,#f85149);font-size:11px;line-height:16px}",
      ".dfx-split{flex:1;min-height:0;display:flex;gap:8px}",
      ".dfx-splitPane{flex:1;min-width:0;display:flex;flex-direction:column}",
      ".dfx-splitEditor{flex:1;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#343b48);outline:none;resize:none;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#15181f);color:var(--dsw-alias-label-primary,#eceff4);font-family:Consolas,monospace;font-size:12.5px;line-height:20px;min-height:120px}",
      ".dfx-splitPreview{flex:1;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#343b48);border-radius:8px;background:#fff}",
      ".dfx-htmlBar{flex:none;display:flex;align-items:center;gap:8px;padding:0 2px 6px}",
      ".dfx-splitLabel{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:11px;line-height:16px;flex:none}",
      ".dfx-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#343b48);background:none;color:var(--dsw-alias-label-primary,#eceff4);font:inherit;font-size:12px;border-radius:7px;padding:4px 12px}",
      ".dfx-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
      ".dfx-btn-primary{border-color:var(--dsw-alias-state-business-primary,#4c8dff);color:#fff;background:var(--dsw-alias-state-business-primary,#4c8dff)}",
    ].join("");
    const tagId = "@dsh-kit/plugin-file-explorer/styles";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@dsh-kit/plugin-file-explorer";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region runtime service access
    function sessionsOf(ctx) {
      try {
        return ctx.get?.("sessions") || ctx.sessions;
      } catch {
        return undefined;
      }
    }
    function currentSessionId(ctx) {
      const s = sessionsOf(ctx);
      const snap = s?.list?.getSnapshot?.();
      return snap && snap.current;
    }
    function subscribeSessions(ctx, fn) {
      const s = sessionsOf(ctx);
      const list = s?.list;
      if (!list || typeof list.subscribe !== "function") return () => {};
      return list.subscribe(fn);
    }
    //#endregion

    //#region file tree
    function TreeNode({ node, depth, expanded, onToggle, onOpen, onRename, onDelete, onCreateIn }) {
      const [hover, setHover] = useState(false);
      const [renaming, setRenaming] = useState(false);
      const [renameVal, setRenameVal] = useState("");
      if (!node) return null;
      const isDir = node.type === "dir";
      const isOpen = isDir && !!expanded[node.path];
      const startRename = () => {
        setRenameVal(node.name);
        setRenaming(true);
      };
      const commitRename = () => {
        const name = renameVal.trim();
        if (name && name !== node.name) onRename(node, name);
        setRenaming(false);
      };
      return jsxs("div", {
        className: "dfx-treeNode",
        children: [
          jsxs("div", {
            className: "dfx-treeRow",
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: { paddingLeft: 4 + depth * 12 },
            children: [
              jsx("span", {
                className: "dfx-treeIcon",
                children: isDir ? (isOpen ? "▾" : "▸") : "•",
                onClick: isDir ? () => onToggle(node.path) : undefined,
              }),
              renaming
                ? jsx("input", {
                    className: "dfx-inlineInput",
                    value: renameVal,
                    autoFocus: true,
                    onFocus: (e) => e.currentTarget.select(),
                    onChange: (e) => setRenameVal(e.currentTarget.value),
                    onBlur: commitRename,
                    onKeyDown: (e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setRenaming(false);
                      e.stopPropagation();
                    },
                  })
                : jsx("span", {
                    className: "dfx-treeName",
                    onClick: () => {
                      if (isDir) onToggle(node.path);
                      else onOpen(node);
                    },
                    children: node.name,
                  }),
              hover && !renaming
                ? jsxs("span", {
                    className: "dfx-treeOps",
                    children: [
                      isDir ? jsx("button", { type: "button", title: "新建文件", onClick: () => onCreateIn(node.path, "file"), children: "＋文件" }) : null,
                      isDir ? jsx("button", { type: "button", title: "新建文件夹", onClick: () => onCreateIn(node.path, "dir"), children: "＋目录" }) : null,
                      jsx("button", { type: "button", title: "重命名", onClick: startRename, children: "✎" }),
                      jsx("button", { type: "button", title: "删除", onClick: () => onDelete(node), children: "🗑" }),
                    ],
                  })
                : null,
            ],
          }),
          isDir && isOpen && node.children && node.children.length > 0
            ? jsx("div", {
                className: "dfx-treeChildren",
                children: node.children.map((child) =>
                  jsx(TreeNode, { node: child, depth: depth + 1, expanded, onToggle, onOpen, onRename, onDelete, onCreateIn }, child.path)
                ),
              })
            : null,
        ],
      });
    }

    function FilesTab({ sessionId }) {
      const [tree, setTree] = useState(null);
      const [root, setRoot] = useState(null);
      const [err, setErr] = useState(null);
      const [expanded, setExpanded] = useState({ "": true });
      const [createState, setCreateState] = useState(null); // { dir, kind }
      const [createVal, setCreateVal] = useState("");
      const [status, setStatus] = useState("");

      const reload = useCallback(() => {
        if (!sessionId) {
          setTree(null);
          setRoot(null);
          setErr("当前无活动会话");
          return;
        }
        fetch(`/dshkit-fs/tree?session=${encodeURIComponent(sessionId)}`)
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) throw new Error(d.error || "failed");
            setRoot(d.root);
            setTree(d.tree);
            setErr(null);
          })
          .catch((e) => setErr(e.message));
      }, [sessionId]);
      useEffect(() => {
        reload();
      }, [reload]);
      useEffect(() => {
        if (!sessionId) return;
        const onChanged = (ev) => {
          const d = ev.detail || {};
          if (d.sessionId && d.sessionId !== sessionId) return;
          reload();
        };
        window.addEventListener("dshkit:fschanged", onChanged);
        return () => window.removeEventListener("dshkit:fschanged", onChanged);
      }, [sessionId, reload]);

      const api = useCallback(async (path, body) => {
        const res = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return res.json();
      }, []);

      const toggleDir = useCallback((p) => {
        setExpanded((prev) => ({ ...prev, [p]: !prev[p] }));
      }, []);

      const openFile = (node) => {
        window.dispatchEvent(new CustomEvent("dshkit:openfile", { detail: { path: node.path, name: node.name, sessionId } }));
      };

      const expandAll = () => {
        const next = {};
        const walk = (n) => {
          if (n.type === "dir") {
            next[n.path] = true;
            (n.children || []).forEach(walk);
          }
        };
        if (tree) walk(tree);
        setExpanded(next);
      };

      const commitCreate = async () => {
        const name = createVal.trim();
        const { dir, kind } = createState || { dir: "", kind: "file" };
        if (!name) {
          setStatus("名称不能为空");
          return;
        }
        try {
          const d = await api("/dshkit-fs/create", { session: sessionId, dir, name, kind });
          if (d.ok) {
            setCreateState(null);
            setCreateVal("");
            setStatus("");
            if (dir) setExpanded((prev) => ({ ...prev, [dir]: true }));
            window.dispatchEvent(new CustomEvent("dshkit:fschanged", { detail: { sessionId, type: "create", path: d.path } }));
            if (kind === "file" && d.path) {
              window.dispatchEvent(new CustomEvent("dshkit:openfile", { detail: { path: d.path, name, sessionId } }));
            }
          } else {
            setStatus("新建失败：" + (d.error || ""));
          }
        } catch (e) {
          setStatus("新建失败：" + (e.message || String(e)));
        }
      };

      const renameNode = async (node, name) => {
        try {
          const d = await api("/dshkit-fs/rename", { session: sessionId, path: node.path, name });
          if (d.ok) {
            setStatus("");
            window.dispatchEvent(new CustomEvent("dshkit:fschanged", {
              detail: { sessionId, type: "rename", path: node.path, to: d.path, name },
            }));
          } else {
            setStatus("重命名失败：" + (d.error || ""));
          }
        } catch (e) {
          setStatus("重命名失败：" + (e.message || String(e)));
        }
      };

      const deleteNode = async (node) => {
        const label = node.type === "dir" ? "目录及其内容" : "文件";
        if (!window.confirm(`确定删除${label}「${node.name}」？此操作不可恢复。`)) return;
        try {
          const d = await api("/dshkit-fs/delete", { session: sessionId, path: node.path });
          if (d.ok) {
            setStatus("");
            window.dispatchEvent(new CustomEvent("dshkit:fschanged", { detail: { sessionId, type: "delete", path: node.path } }));
          } else {
            setStatus("删除失败：" + (d.error || ""));
          }
        } catch (e) {
          setStatus("删除失败：" + (e.message || String(e)));
        }
      };

      if (err) return jsx("div", { className: "dfx-empty", children: err });
      if (!tree) return jsx("div", { className: "dfx-status", children: "加载中…" });
      return jsxs("div", {
        className: "dfx-root",
        children: [
          jsxs("div", {
            className: "dfx-toolbar",
            children: [
              jsx("button", { type: "button", className: "dfx-toolBtn", onClick: () => { setCreateState({ dir: "", kind: "file" }); setCreateVal(""); }, children: "＋文件" }),
              jsx("button", { type: "button", className: "dfx-toolBtn", onClick: () => { setCreateState({ dir: "", kind: "dir" }); setCreateVal(""); }, children: "＋目录" }),
              jsx("button", { type: "button", className: "dfx-toolBtn", onClick: reload, children: "刷新" }),
              jsx("button", { type: "button", className: "dfx-toolBtn", onClick: expandAll, children: "全部展开" }),
              jsx("button", { type: "button", className: "dfx-toolBtn", onClick: () => setExpanded({}), children: "全部收起" }),
            ],
          }),
          createState
            ? jsxs("div", {
                className: "dfx-createRow",
                children: [
                  jsx("span", { className: "dfx-createLabel", children: (createState.dir ? "在 " + createState.dir + " 下" : "根目录") + (createState.kind === "dir" ? "新建文件夹" : "新建文件") + "：" }),
                  jsx("input", {
                    className: "dfx-inlineInput",
                    value: createVal,
                    autoFocus: true,
                    placeholder: createState.kind === "dir" ? "文件夹名" : "文件名（含扩展名）",
                    onChange: (e) => setCreateVal(e.currentTarget.value),
                    onKeyDown: (e) => {
                      if (e.key === "Enter") commitCreate();
                      else if (e.key === "Escape") { setCreateState(null); setCreateVal(""); }
                    },
                  }),
                  jsx("button", { type: "button", className: "dfx-btn", onClick: commitCreate, children: "确定" }),
                  jsx("button", { type: "button", className: "dfx-btn", onClick: () => { setCreateState(null); setCreateVal(""); }, children: "取消" }),
                ],
              })
            : null,
          status ? jsx("div", { className: "dfx-status", children: status }) : null,
          root ? jsx("div", { className: "dfx-status", children: root.replace(/\\/g, "/") }) : null,
          jsx("div", {
            className: "dfx-body",
            children: jsx(TreeNode, {
              node: tree,
              depth: 0,
              expanded,
              onToggle: toggleDir,
              onOpen: openFile,
              onRename: renameNode,
              onDelete: deleteNode,
              onCreateIn: (dir, kind) => { setCreateState({ dir, kind }); setCreateVal(""); },
            }),
          }),
        ],
      });
    }

    function SessionsTab({ sessionId, onSelect }) {
      const [items, setItems] = useState([]);
      useEffect(() => {
        const sync = () => {
          const s = sessionsOf(appCtx);
          const snap = s?.list?.getSnapshot?.();
          const byId = snap?.byId || {};
          const list = Object.values(byId);
          list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
          setItems(list.map((x) => ({ id: x.id || x.sessionId, title: x.title || "未命名会话" })));
        };
        sync();
        return subscribeSessions(appCtx, sync);
      }, []);
      if (!items.length) return jsx("div", { className: "dfx-empty", children: "暂无会话" });
      return jsx("div", {
        className: "dfx-root",
        children: jsx("div", {
          className: "dfx-body",
          children: items.map((s) =>
            jsx("button", {
              type: "button",
              className: "dfx-sessionRow" + (s.id === sessionId ? " dfx-active" : ""),
              onClick: () => onSelect(s.id),
              children: jsx("span", { className: "dfx-sessionTitle", children: s.title }),
            }, s.id)
          ),
        }),
      });
    }

    let appCtx = null;

    function SidebarWorkspacesTabs(props) {
      const [tab, setTab] = useState("sessions");
      const [sessionId, setSessionId] = useState(() => currentSessionId(appCtx));
      useEffect(() => subscribeSessions(appCtx, () => setSessionId(currentSessionId(appCtx))), []);
      const onSelect = (id) => {
        const s = sessionsOf(appCtx);
        if (s && typeof s.open === "function") s.open(id);
        setSessionId(id);
      };
      return jsxs("div", {
        className: "dfx-root",
        children: [
          jsxs("div", {
            className: "dfx-tabs",
            children: [
              jsx("button", { type: "button", className: "dfx-tab" + (tab === "sessions" ? " dfx-tabActive" : ""), onClick: () => setTab("sessions"), children: "会话" }),
              jsx("button", { type: "button", className: "dfx-tab" + (tab === "files" ? " dfx-tabActive" : ""), onClick: () => setTab("files"), children: "文件" }),
            ],
          }),
          tab === "sessions"
            ? jsx(SessionsTab, { sessionId, onSelect })
            : jsx(FilesTab, { sessionId }, "files"),
        ],
      });
    }
    //#endregion

    //#region file editor (rendered as a conversation.view tab)
    // 图片 / 视频 / 文档扩展名（与 host 路由对齐）。
    const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
    const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "ogv", "ogg", "mov"]);
    const DOC_EXTS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf", "rtf", "odt", "ods", "odp", "wps", "et", "dps"]);

    /** 按扩展名决定 Tab 内容组件类型：image | video | doc | json | markdown | html | text。 */
    function editorKindForPath(path) {
      const ext = String(path).toLowerCase().split(".").pop() || "";
      if (IMAGE_EXTS.has(ext)) return "image";
      if (VIDEO_EXTS.has(ext)) return "video";
      if (DOC_EXTS.has(ext)) return "doc";
      if (ext === "json") return "json";
      if (ext === "md" || ext === "markdown") return "markdown";
      if (ext === "html" || ext === "htm") return "html";
      return "text";
    }

    //#region markdown 轻量渲染（无第三方依赖，离线可用）
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
    function inlineMd(s) {
      let out = escapeHtml(s);
      out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
      out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
      return out;
    }
    function renderMarkdown(src) {
      const lines = String(src ?? "").split("\n");
      const html = [];
      let inCode = false;
      let codeBuf = [];
      let listOpen = false;
      let quoteBuf = [];
      const closeList = () => {
        if (listOpen) {
          html.push("</ul>");
          listOpen = false;
        }
      };
      const flushQuote = () => {
        if (quoteBuf.length) {
          html.push("<blockquote>" + quoteBuf.join("<br>") + "</blockquote>");
          quoteBuf = [];
        }
      };
      for (const line of lines) {
        const fence = line.match(/^```([\w+-]*)\s*$/);
        if (fence) {
          closeList();
          flushQuote();
          if (inCode) {
            html.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
            codeBuf = [];
            inCode = false;
          } else inCode = true;
          continue;
        }
        if (inCode) {
          codeBuf.push(line);
          continue;
        }
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) {
          closeList();
          flushQuote();
          const lv = h[1].length;
          html.push("<h" + lv + ">" + inlineMd(h[2]) + "</h" + lv + ">");
          continue;
        }
        if (/^[-*]\s+/.test(line)) {
          flushQuote();
          if (!listOpen) {
            html.push("<ul>");
            listOpen = true;
          }
          html.push("<li>" + inlineMd(line.replace(/^[-*]\s+/, "")) + "</li>");
          continue;
        }
        if (/^>\s?/.test(line)) {
          closeList();
          quoteBuf.push(inlineMd(line.replace(/^>\s?/, "")));
          continue;
        }
        closeList();
        flushQuote();
        if (line.trim() === "") continue;
        html.push("<p>" + inlineMd(line) + "</p>");
      }
      if (inCode) html.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
      closeList();
      flushQuote();
      return html.join("\n");
    }
    //#endregion

    //#region markdown / html 分屏编辑预览组件
    const MD_PREVIEW_CSS = [
      "body{background:#15181f;color:#eceff4;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.7;padding:16px;margin:0;box-sizing:border-box}",
      "pre,code{font-family:Consolas,monospace;font-size:12px}",
      "pre{background:#0d1117;border:1px solid #343b48;border-radius:6px;padding:10px;overflow:auto}",
      "code{background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px}",
      "pre code{background:none;padding:0;border:none}",
      "h1,h2,h3,h4{border-bottom:1px solid #343b48;padding-bottom:6px}",
      "a{color:#4c8dff}",
      "blockquote{border-left:3px solid #4c8dff;margin:8px 0;padding:2px 12px;color:#aab1bd}",
      "ul{padding-left:22px}",
      "table{border-collapse:collapse}th,td{border:1px solid #343b48;padding:4px 10px}",
    ].join("");

    function MarkdownEditor({ content, onChange, onKeyDown }) {
      const html = useMemo(() => renderMarkdown(content), [content]);
      const doc = useMemo(
        () => '<!doctype html><html><head><meta charset="utf-8"><style>' + MD_PREVIEW_CSS + "</style></head><body>" + html + "</body></html>",
        [html]
      );
      return jsxs("div", {
        className: "dfx-split",
        children: [
          jsx("div", {
            className: "dfx-splitPane",
            children: [
              jsx("div", { className: "dfx-splitLabel", children: "编辑（Markdown）" }),
              jsx("textarea", {
                className: "dfx-splitEditor",
                value: content,
                onChange: onChange,
                onKeyDown,
                spellCheck: false,
                placeholder: "输入 Markdown…",
              }),
            ],
          }),
          jsx("div", {
            className: "dfx-splitPane",
            children: [
              jsx("div", { className: "dfx-splitLabel", children: "预览" }),
              jsx("iframe", { className: "dfx-splitPreview", srcDoc: doc, sandbox: "", title: "markdown 预览" }),
            ],
          }),
        ],
      });
    }

    function HtmlEditor({ content, onChange, onKeyDown }) {
      const [doc, setDoc] = useState(content);
      useEffect(() => {
        const t = setTimeout(() => setDoc(content), 300);
        return () => clearTimeout(t);
      }, [content]);
      return jsxs("div", {
        className: "dfx-root",
        children: [
          jsx("div", { className: "dfx-htmlBar", children: jsx("span", { className: "dfx-splitLabel", children: "预览延迟 300ms 自动刷新（沙箱内允许脚本）" }) }),
          jsxs("div", {
            className: "dfx-split",
            children: [
              jsx("div", {
                className: "dfx-splitPane",
                children: [
                  jsx("div", { className: "dfx-splitLabel", children: "编辑（HTML）" }),
                  jsx("textarea", {
                    className: "dfx-splitEditor",
                    value: content,
                    onChange: onChange,
                    onKeyDown,
                    spellCheck: false,
                    placeholder: "输入 HTML…",
                  }),
                ],
              }),
              jsx("div", {
                className: "dfx-splitPane",
                children: [
                  jsx("div", { className: "dfx-splitLabel", children: "预览" }),
                  jsx("iframe", { className: "dfx-splitPreview", srcDoc: doc, sandbox: "allow-scripts allow-modals allow-forms", title: "html 预览" }),
                ],
              }),
            ],
          }),
        ],
      });
    }
    //#endregion

    function FileEditorTab({ filePath, fileName, sessionId }) {
      const [content, setContent] = useState("");
      const [status, setStatus] = useState("");
      const [loaded, setLoaded] = useState(false);
      const [dirty, setDirty] = useState(false);
      const [loadErr, setLoadErr] = useState("");
      const [mediaErr, setMediaErr] = useState("");
      const gutterRef = useRef(null);
      const areaRef = useRef(null);
      const contentRef = useRef(content);
      contentRef.current = content;
      const dirtyRef = useRef(dirty);
      dirtyRef.current = dirty;
      const ekind = editorKindForPath(filePath);
      const mediaUrl = `/dshkit-fs/media?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`;

      useEffect(() => {
        setStatus("");
        setLoaded(false);
        setLoadErr("");
        setMediaErr("");
        // 图片 / 视频走 /media 流式 webview，doc 走系统默认应用，均无需 fetch 文本内容。
        if (ekind === "image" || ekind === "video" || ekind === "doc") {
          return;
        }
        const controller = new AbortController();
        setStatus("加载中…");
        fetch(`/dshkit-fs/read?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`, {
          signal: controller.signal,
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) {
              if (d.error === "binary") setLoadErr("二进制文件，不支持编辑");
              else if (d.error === "too large") setLoadErr("文件过大，拒绝读取");
              else setLoadErr("读取失败：" + d.error);
              return;
            }
            setContent(d.content ?? "");
            setDirty(false);
            setStatus("");
            setLoaded(true);
          })
          .catch((e) => {
            if (e && e.name === "AbortError") return;
            setLoadErr("读取失败：" + (e && e.message ? e.message : String(e)));
            setContent("");
          });
        return () => controller.abort();
      }, [filePath, sessionId]); // ekind 由 filePath 派生，无需单独列入依赖

      const save = () => {
        if (ekind === "json") {
          try {
            JSON.parse(contentRef.current);
          } catch (e) {
            setStatus("JSON 不合法，无法保存：" + e.message);
            return;
          }
        }
        setStatus("保存中…");
        fetch("/dshkit-fs/write", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: sessionId, path: filePath, content: contentRef.current }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (d.ok) {
              setDirty(false);
              setStatus("已保存");
            } else setStatus("保存失败：" + (d.error || ""));
          })
          .catch((e) => setStatus("保存失败：" + e.message));
      };

      const formatJson = (pretty) => {
        try {
          const obj = JSON.parse(contentRef.current);
          setContent(JSON.stringify(obj, null, pretty ? 2 : 0));
          setDirty(true);
          setStatus("");
        } catch (e) {
          setStatus("格式化失败：" + e.message);
        }
      };

      const jsonCheck = useMemo(() => {
        if (ekind !== "json") return null;
        try {
          JSON.parse(content);
          return { ok: true };
        } catch (e) {
          return { ok: false, msg: e.message };
        }
      }, [ekind, content]);

      const onContentChange = (e) => {
        setContent(e.currentTarget.value);
        setDirty(true);
        setStatus("");
      };

      const requestClose = () => {
        if (dirtyRef.current && !window.confirm("文件尚未保存，确定关闭？未保存的修改将丢失。")) return;
        window.dispatchEvent(new CustomEvent("dshkit:closefile", { detail: { path: filePath } }));
      };

      const openWithSystem = async () => {
        setStatus("正在调用系统默认应用…");
        try {
          const r = await fetch("/dshkit-fs/open", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: sessionId, path: filePath }),
          });
          const d = await r.json();
          setStatus(d.ok ? "已调用系统默认应用打开" : "打开失败：" + (d.error || ""));
        } catch (e) {
          setStatus("打开失败：" + e.message);
        }
      };

      const onKeyDown = (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          const el = e.currentTarget;
          const s = el.selectionStart;
          const en = el.selectionEnd;
          const next = content.slice(0, s) + "    " + content.slice(en);
          setContent(next);
          setDirty(true);
          setStatus("");
          requestAnimationFrame(() => {
            el.selectionStart = el.selectionEnd = s + 4;
          });
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          if (loaded) save();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
          e.preventDefault();
          requestClose();
        }
      };

      const onScrollSync = () => {
        if (gutterRef.current && areaRef.current) {
          gutterRef.current.scrollTop = areaRef.current.scrollTop;
        }
      };

      const lineCount = content ? content.split("\n").length : 1;
      const gutterNumbers = Array.from({ length: lineCount }, (_, i) => String(i + 1)).join("\n");
      const fileLabel = fileName || filePath.split("/").pop() || filePath;

      // 加载失败 / 二进制 / 超大文件
      if (loadErr) {
        return jsxs("div", {
          className: "dfx-editor",
          children: [
            jsx("div", {
              className: "dfx-editorChrome",
              children: [
                jsx("span", { className: "dfx-editorName", children: fileLabel }),
                jsx("button", { type: "button", className: "dfx-btn", onClick: requestClose, children: "关闭" }),
              ],
            }),
            jsx("div", { className: "dfx-empty", children: loadErr }),
          ],
        });
      }

      // 图片 / 视频：专用媒体 webview（/media 流式，支持 Range 拖动进度）
      if (ekind === "image" || ekind === "video") {
        const isVideo = ekind === "video";
        return jsxs("div", {
          className: "dfx-editor",
          children: [
            jsx("div", {
              className: "dfx-editorChrome",
              children: [
                jsx("span", { className: "dfx-editorName", children: fileLabel }),
                jsx("span", { className: "dfx-status", children: isVideo ? "（视频预览 · 只读）" : "（图片预览 · 只读）" }),
                jsx("button", { type: "button", className: "dfx-btn", onClick: requestClose, children: "关闭" }),
              ],
            }),
            mediaErr
              ? jsx("div", { className: "dfx-empty", children: mediaErr })
              : isVideo
                ? jsx("div", {
                    className: "dfx-mediaPreview",
                    children: jsx("video", { src: mediaUrl, controls: true, preload: "metadata", onError: () => setMediaErr("视频加载失败，文件可能已移动或删除"), children: jsx("track", { kind: "captions" }) }),
                  })
                : jsx("div", {
                    className: "dfx-imagePreview",
                    children: jsx("img", { src: mediaUrl, alt: fileLabel, onError: () => setMediaErr("图片加载失败，文件可能已移动或删除") }),
                  }),
          ],
        });
      }

      // doc / excel / ppt / pdf 等：提示用系统默认应用打开
      if (ekind === "doc") {
        return jsxs("div", {
          className: "dfx-editor",
          children: [
            jsx("div", {
              className: "dfx-editorChrome",
              children: [
                jsx("span", { className: "dfx-editorName", children: fileLabel }),
                jsx("span", { className: "dfx-status", children: "（文档 · 不支持在线编辑）" }),
                jsx("button", { type: "button", className: "dfx-btn", onClick: requestClose, children: "关闭" }),
              ],
            }),
            jsx("div", {
              className: "dfx-empty",
              children: "这是文档文件（Word / Excel / PPT / PDF 等），不支持在线编辑。请使用系统默认应用打开。",
            }),
            jsx("div", {
              className: "dfx-docBar",
              children: [
                jsx("button", { type: "button", className: "dfx-btn dfx-btn-primary", onClick: openWithSystem, children: "用系统默认应用打开" }),
                status ? jsx("span", { className: "dfx-status", children: status }) : null,
              ],
            }),
          ],
        });
      }

      // markdown / html：分屏编辑 + 预览
      if (ekind === "markdown" || ekind === "html") {
        const Body = ekind === "markdown" ? MarkdownEditor : HtmlEditor;
        return jsxs("div", {
          className: "dfx-editor",
          children: [
            jsx("div", {
              className: "dfx-editorChrome",
              children: [
                jsx("span", { className: "dfx-editorName", children: fileLabel + (dirty ? " ●" : "") }),
                jsx("span", { className: "dfx-status", children: status || (dirty ? "（未保存）" : "") }),
                jsx("button", { type: "button", className: "dfx-btn", onClick: requestClose, children: "关闭" }),
                jsx("button", { type: "button", className: "dfx-btn dfx-btn-primary", onClick: save, disabled: !loaded, children: "保存" }),
              ],
            }),
            jsx(Body, { content, onChange: onContentChange, onKeyDown }),
          ],
        });
      }

      // text / json：行号 + 语法高亮编辑体（json 额外带格式化与校验工具条）
      return jsxs("div", {
        className: "dfx-editor",
        children: [
          jsx("div", {
            className: "dfx-editorChrome",
            children: [
              jsx("span", { className: "dfx-editorName", children: fileLabel + (dirty ? " ●" : "") }),
              jsx("span", { className: "dfx-status", children: status || (dirty ? "（未保存）" : "") }),
              jsx("button", { type: "button", className: "dfx-btn", onClick: requestClose, children: "关闭" }),
              jsx("button", { type: "button", className: "dfx-btn dfx-btn-primary", onClick: save, disabled: !loaded, children: "保存" }),
            ],
          }),
          ekind === "json"
            ? jsxs("div", {
                className: "dfx-jsonBar",
                children: [
                  jsx("button", { type: "button", className: "dfx-toolBtn", onClick: () => formatJson(true), children: "格式化" }),
                  jsx("button", { type: "button", className: "dfx-toolBtn", onClick: () => formatJson(false), children: "压缩" }),
                  jsonCheck && jsonCheck.ok
                    ? jsx("span", { className: "dfx-jsonOk", children: "JSON 合法" })
                    : jsx("span", { className: "dfx-jsonErr", children: "JSON 错误：" + (jsonCheck ? jsonCheck.msg : "") }),
                ],
              })
            : null,
          jsx("div", {
            className: "dfx-editorWrap",
            children: [
              jsx("div", { className: "dfx-gutter", ref: gutterRef, children: gutterNumbers }),
              jsx("textarea", {
                ref: areaRef,
                value: content,
                onChange: onContentChange,
                onKeyDown,
                onScroll: onScrollSync,
                spellCheck: false,
                placeholder: loaded ? "" : "加载中…",
              }),
            ],
          }),
        ],
      });
    }
    //#endregion

    //#region plugin entry
    const inject = ["slots", "locale", "sessions", "workspaces", "layout"];

    function apply(ctx) {
      appCtx = ctx;

      // open-file dispatcher: keeps a set of reusable conversation.view tickets so a re-open
      // of the same file does not double-register the tab.
      const fileEntryDisposers = new Map(); // path -> disposer(s)
      const viewStore = (typeof defineStore === "function") ? defineStore({
        init: () => ({ openFiles: [], active: null }),
        actions: {
          addFile: (d, path, name) => {
            const existing = d.openFiles.find((f) => f.path === path);
            if (!existing) d.openFiles.push({ path, name });
            d.active = path;
          },
          closeFile: (d, path) => {
            d.openFiles = d.openFiles.filter((f) => f.path !== path);
            if (d.active === path) d.active = d.openFiles.length ? d.openFiles[d.openFiles.length - 1].path : null;
          },
          activate: (d, path) => {
            d.active = path;
          },
        },
      }) : null;

      function registerFileView(file) {
        const path = file.path;
        if (fileEntryDisposers.has(path)) return;
        const disposer = ctx.slots.inject("conversation.view", () => {
          return ctx.slots.register(
            {
              name: "conversation.view",
              id: "file:" + path,
              order: 1000,
              label: () => file.name || path.split("/").pop() || path,
              locale: "file-explorer",
              store: viewStore,
              inject: (sessionId) => ({
                filePath: path,
                fileName: file.name || path.split("/").pop() || path,
                sessionId: sessionId || file.sessionId,
              }),
            },
            FileEditorTab
          );
        });
        fileEntryDisposers.set(path, disposer);
      }

      function unregisterFileView(path) {
        const d = fileEntryDisposers.get(path);
        if (d) {
          try {
            d();
          } catch {}
          fileEntryDisposers.delete(path);
        }
      }

      function closeAllFileViews() {
        for (const path of [...fileEntryDisposers.keys()]) unregisterFileView(path);
      }

      const onOpenFile = (ev) => {
        const d = ev.detail || {};
        if (!d.path) return;
        const sessionId = d.sessionId || currentSessionId(ctx) || "";
        registerFileView({ path: d.path, name: d.name, sessionId });
      };
      window.addEventListener("dshkit:openfile", onOpenFile);

      // Close file tab when its × is clicked (from the FileEditor tab itself we expose via a
      // lightweight confirm; the primary close path is a small × we cannot add to the tab ring
      // label, so we add a right-click / key affordance via events below).
      const onCloseRequest = (ev) => {
        const path = ev.detail && ev.detail.path;
        if (path) unregisterFileView(path);
      };
      window.addEventListener("dshkit:closefile", onCloseRequest);

      // 文件树操作联动：重命名同步已打开 Tab（换新路径重开），删除则关闭对应 Tab。
      const onFsChanged = (ev) => {
        const d = ev.detail || {};
        if (d.type === "rename") {
          if (d.path && d.to && fileEntryDisposers.has(d.path)) {
            const sessionId = d.sessionId || currentSessionId(ctx) || "";
            unregisterFileView(d.path);
            registerFileView({ path: d.to, name: d.name || d.to.split("/").pop() || d.to, sessionId });
          }
        } else if (d.type === "delete") {
          if (d.path) unregisterFileView(d.path);
        }
      };
      window.addEventListener("dshkit:fschanged", onFsChanged);

      // 会话切换：清空已打开的文件 Tab，避免残留到新会话。
      let lastSessionId = currentSessionId(ctx);
      const onSessionsChanged = () => {
        const id = currentSessionId(ctx);
        if (id !== lastSessionId) {
          lastSessionId = id;
          closeAllFileViews();
        }
      };
      const unsubSessions = subscribeSessions(ctx, onSessionsChanged);

      // 1) Shadow sidebar.workspaces (single, lowest priority wins) with the two-tab region.
      ctx.slots.inject("sidebar.workspaces", () =>
        ctx.slots.register(
          { name: "sidebar.workspaces", priority: -10, locale: "file-explorer" },
          SidebarWorkspacesTabs
        )
      );

      // 2) Cleanup on unload.
      ctx.effect(() => () => {
        window.removeEventListener("dshkit:openfile", onOpenFile);
        window.removeEventListener("dshkit:closefile", onCloseRequest);
        window.removeEventListener("dshkit:fschanged", onFsChanged);
        if (unsubSessions) unsubSessions();
        closeAllFileViews();
      }, "plugin-file-explorer: unload");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
