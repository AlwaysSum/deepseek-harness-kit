// @dsh-kit/plugin-theme-skin — browser half.
// 主题换肤插件：
//   1. 修改主题颜色：通过 ctx.theme.overrideTokens() 叠加覆盖 --dsw-alias-* 令牌色
//      （品牌色 / 底色 / 面板色 / 边框 / 文字 / 状态色 / 侧边栏色），
//      与官方浅色/深色主题共存，改动即时生效并持久化到 settings scope。
//   2. 背景图 / 背景视频：注入固定全屏媒体层（z-index 为负、pointer-events:none），
//      支持 GIF / APNG / 动态 WebP 等动态图片，以及 MP4 / WebM / OGG 等视频
//      （自动静音循环播放）；开启背景时把应用表面背景令牌覆盖为半透明，让背景透出，
//      并叠加一层可调遮罩保证文字可读。本地文件经 IndexedDB 持久化，远程 URL 直接引用。
//
// 设置入口：设置 → 主题换肤（settings.section 页）。
// 与现有 @dsh-kit/plugin-i18n-zh 同构：__ModuleLoader__ 手写 bundle，无构建步骤。

window.__ModuleLoader__.load({
  id: "@dsh-kit/plugin-theme-skin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");

    const { jsx, jsxs, Fragment } = react_jsx_runtime;
    const { useState, useEffect, useRef } = react;

    //#region constants
    const NS = "theme-skin";
    const LS_KEY = "dshkit:theme-skin:config";
    const SETTINGS_SECTION_ID = "theme-skin";

    /** 可被用户覆盖的主题令牌（--dsw-alias-*）。fallback 仅用于设置面板取色器显示。 */
    const SKIN_TOKENS = [
      { key: "--dsw-alias-brand-primary", label: "品牌主色", fallback: "#4c8dff" },
      { key: "--dsw-alias-bg-base", label: "界面底色", fallback: "#0d1117" },
      { key: "--dsw-alias-bg-layer-1", label: "一级面板底色", fallback: "#15181f" },
      { key: "--dsw-alias-bg-layer-2", label: "二级面板底色", fallback: "#1b202a" },
      { key: "--dsw-alias-bg-overlay", label: "弹层底色", fallback: "#15181f" },
      { key: "--dsw-alias-border-l1", label: "细边框", fallback: "#2a303c" },
      { key: "--dsw-alias-border-l2", label: "粗边框", fallback: "#343b48" },
      { key: "--dsw-alias-label-primary", label: "主文字", fallback: "#eceff4" },
      { key: "--dsw-alias-label-secondary", label: "次要文字", fallback: "#aab1bd" },
      { key: "--dsw-alias-state-error-primary", label: "错误色", fallback: "#f05454" },
      { key: "--dsw-alias-state-success-primary", label: "成功色", fallback: "#3fb950" },
      { key: "--dsw-alias-state-warn-primary", label: "警告色", fallback: "#d29922" },
      { key: "--dsw-specific-sidebar-fill", label: "侧边栏底色", fallback: "#12151c" },
    ];

    const DEFAULT_CONFIG = {
      colors: {}, // { "--dsw-alias-xxx": "#rrggbb" }，仅记录用户主动设置过的颜色
      media: {
        enabled: false,
        kind: "image", // image | video
        url: "", // 远程地址
        blobId: null, // IndexedDB 中本地上传文件的 id
        name: "", // 本地文件原始名（仅展示用）
        fit: "cover", // cover | contain（仅图片）
        blur: 0, // 背景模糊 px
        dim: 0.45, // 遮罩浓度 0..1
        alpha: 0.72, // 应用表面不透明度 0.35..1
      },
    };

    const MAX_FILE_BYTES = 120 * 1024 * 1024;
    //#endregion

    //#region locale dictionaries
    const zh = {
      "section.label": "主题换肤",
      "section.desc": "修改界面主题颜色，并设置图片 / 动态图 / 视频背景。",
      "group.colors": "主题颜色",
      "group.media": "背景图 / 背景视频",
      "media.none": "无",
      "media.image": "图片",
      "media.video": "视频",
      "media.imageHint": "支持 JPG / PNG / WebP / AVIF，以及 GIF / APNG / 动态 WebP 等动态图",
      "media.videoHint": "支持 MP4 / WebM / OGG 等视频格式（自动静音循环播放）",
      "media.url": "远程地址",
      "media.upload": "上传本地文件",
      "media.remove": "移除背景",
      "media.fileName": "已添加：",
      "media.alpha": "表面不透明度",
      "media.dim": "遮罩浓度",
      "media.blur": "背景模糊",
      "media.fit": "填充方式",
      "media.fit.cover": "铺满",
      "media.fit.contain": "适应",
      "media.transparentNote": "开启背景后，界面底色将变为透明以便背景透出（文字可读性由遮罩保证）",
      "reset": "恢复默认",
      "done": "完成",
      "busyUpload": "正在保存文件…",
      "err.type": "文件类型不匹配，请选择{kind}",
      "err.size": "文件过大（上限 120MB）",
      "err.idb": "保存失败",
    };
    const en = {
      "section.label": "Theme Skin",
      "section.desc": "Recolor the UI and set an image / animated-image / video background.",
      "group.colors": "Theme Colors",
      "group.media": "Background",
      "media.none": "None",
      "media.image": "Image",
      "media.video": "Video",
      "media.imageHint": "JPG / PNG / WebP / AVIF, plus animated GIF / APNG / WebP",
      "media.videoHint": "MP4 / WebM / OGG (muted, auto-loop)",
      "media.url": "Remote URL",
      "media.upload": "Upload local file",
      "media.remove": "Remove background",
      "media.fileName": "Added:",
      "media.alpha": "Surface opacity",
      "media.dim": "Dim overlay",
      "media.blur": "Blur",
      "media.fit": "Fit",
      "media.fit.cover": "Cover",
      "media.fit.contain": "Contain",
      "media.transparentNote": "While a background is enabled the base background turns transparent so the media shows through (readability is kept by the dim overlay)",
      "reset": "Reset",
      "done": "Done",
      "busyUpload": "Saving file…",
      "err.type": "File type mismatch, please pick a {kind}",
      "err.size": "File too large (max 120MB)",
      "err.idb": "Save failed",
    };
    //#endregion

    //#region helpers
    function clamp(v, min, max) {
      return Math.min(max, Math.max(min, v));
    }
    function clamp01(v) {
      return clamp(typeof v === "number" ? v : 0.45, 0, 1);
    }
    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }
    function normalizeConfig(cfg) {
      const base = clone(DEFAULT_CONFIG);
      if (!cfg || typeof cfg !== "object") return base;
      base.colors = { ...(cfg.colors && typeof cfg.colors === "object" ? cfg.colors : {}) };
      base.media = { ...base.media, ...(cfg.media && typeof cfg.media === "object" ? cfg.media : {}) };
      return base;
    }

    /** 解析 #hex / rgb() / rgba() 为 {r,g,b,a}。 */
    function parseColor(c) {
      c = String(c || "").trim();
      if (!c) return null;
      if (/^#([0-9a-f]{3,8})$/i.test(c)) {
        let h = c.slice(1);
        if (h.length === 3 || h.length === 4) h = h.split("").map((x) => x + x).join("");
        const n = parseInt(h.slice(0, 6), 16);
        const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
      }
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (m) {
        const parts = m[1].split(",").map((s) => s.trim());
        return {
          r: Number(parts[0]),
          g: Number(parts[1]),
          b: Number(parts[2]),
          a: parts.length > 3 ? Number(parts[3]) : 1,
        };
      }
      return null;
    }
    function withAlpha(color, alpha) {
      const p = parseColor(color);
      if (!p) return color;
      return `rgba(${p.r},${p.g},${p.b},${clamp01(alpha)})`;
    }

    /** 解析一个 CSS 变量的当前计算值（用探针元素强制求值，得到具体颜色）。 */
    function resolveCssVar(name, fallback) {
      try {
        const probe = document.createElement("span");
        probe.style.setProperty("background", `var(${name})`);
        document.body.appendChild(probe);
        const val = getComputedStyle(probe).backgroundColor;
        probe.remove();
        if (val && val !== "transparent" && val !== "rgba(0, 0, 0, 0)") return val;
      } catch {}
      return fallback;
    }

    /** 当前生效的主题明暗（用于按配色方案选基准色）。 */
    function activeScheme(ctx) {
      try {
        const snap = ctx && ctx.theme && typeof ctx.theme.getTheme === "function" ? ctx.theme.getTheme() : null;
        const scheme = snap && snap.active ? snap.active.colorScheme : null;
        return scheme === "light" ? "light" : "dark";
      } catch {
        return "dark";
      }
    }

    /** 各背景令牌的基准色（不读计算值，避免与自身覆盖的透明度叠加）。 */
    function baseBgTokens(scheme) {
      if (scheme === "light") {
        return {
          layer1: "#ffffff",
          layer2: "#f3f4f6",
          overlay: "#ffffff",
          sidebar: "#f7f8fa",
        };
      }
      return {
        layer1: "#15181f",
        layer2: "#1b202a",
        overlay: "#15181f",
        sidebar: "#12151c",
      };
    }
    //#endregion

    //#region IndexedDB (本地媒体文件持久化)
    function idbOpen() {
      return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new Error("indexedDB unavailable"));
          return;
        }
        const req = indexedDB.open("dshkit-theme-skin", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("media")) {
            db.createObjectStore("media", { keyPath: "id" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    function idbPut(record) {
      return idbOpen().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction("media", "readwrite");
            tx.objectStore("media").put(record);
            tx.oncomplete = () => resolve(record.id);
            tx.onerror = () => reject(tx.error);
          })
      );
    }
    function idbGet(id) {
      return idbOpen().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction("media", "readonly");
            const req = tx.objectStore("media").get(String(id));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          })
      );
    }
    function idbDelete(id) {
      return idbOpen().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction("media", "readwrite");
            tx.objectStore("media").delete(String(id));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          })
      );
    }
    //#endregion

    //#region 媒体层 DOM 管理（z-index 为负，位于应用内容之下、画布之上）
    let mediaHost = null;
    let scrimEl = null;
    let videoEl = null;
    let lastMediaKey = "";
    const blobUrlCache = new Map();

    function ensureMediaDom() {
      if (mediaHost) return;
      mediaHost = document.createElement("div");
      mediaHost.id = "dshkit-skin-media";
      mediaHost.style.cssText =
        "position:fixed;inset:0;z-index:-2;pointer-events:none;overflow:hidden;" +
        "background-color:#05070b;background-position:center;background-repeat:no-repeat;background-size:cover;";
      scrimEl = document.createElement("div");
      scrimEl.id = "dshkit-skin-scrim";
      scrimEl.style.cssText = "position:fixed;inset:0;z-index:-1;pointer-events:none;";
      const root = document.body || document.documentElement;
      root.appendChild(mediaHost);
      root.appendChild(scrimEl);
    }
    function removeMediaLayer() {
      if (mediaHost) {
        mediaHost.remove();
        mediaHost = null;
      }
      if (scrimEl) {
        scrimEl.remove();
        scrimEl = null;
      }
      videoEl = null;
      lastMediaKey = "";
    }

    /** 解析媒体源：本地文件（blobId → objectURL，带缓存）优先，其次远程 URL。 */
    async function resolveMediaUrl(media) {
      if (media && media.blobId) {
        const cached = blobUrlCache.get(String(media.blobId));
        if (cached) return cached;
        try {
          const rec = await idbGet(media.blobId);
          if (rec && rec.blob) {
            const url = URL.createObjectURL(rec.blob);
            blobUrlCache.set(String(media.blobId), url);
            return url;
          }
        } catch {}
      }
      return media && typeof media.url === "string" ? media.url : "";
    }

    function renderMediaLayer(media, url) {
      ensureMediaDom();
      const kind = media.kind === "video" ? "video" : "image";
      const key = `${kind}:${url}`;
      mediaHost.style.filter = media.blur ? `blur(${clamp(Number(media.blur) || 0, 0, 40)}px)` : "none";
      if (kind === "image") mediaHost.style.backgroundSize = media.fit === "contain" ? "contain" : "cover";
      scrimEl.style.background = `rgba(10,14,20,${clamp01(media.dim)})`;
      if (key === lastMediaKey) return; // 内容未变：只更新样式（拖动滑杆时不重建 video）
      lastMediaKey = key;
      if (videoEl) {
        videoEl.remove();
        videoEl = null;
      }
      mediaHost.style.backgroundImage = "none";
      if (kind === "video") {
        const v = document.createElement("video");
        v.setAttribute("playsinline", "");
        v.setAttribute("autoplay", "");
        v.setAttribute("muted", "");
        v.setAttribute("loop", "");
        v.preload = "auto";
        v.src = url;
        v.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#05070b;";
        v.addEventListener("error", () => {
          if (v.isConnected) v.remove();
        });
        mediaHost.appendChild(v);
        videoEl = v;
        try {
          const p = v.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch {}
      } else {
        mediaHost.style.backgroundImage = `url(${JSON.stringify(url)})`;
      }
    }

    let mediaGeneration = 0;
    async function applyMediaLayer(config) {
      const media = config.media || {};
      const enabled = !!media.enabled && !!(media.url || media.blobId);
      const gen = ++mediaGeneration;
      if (!enabled) {
        removeMediaLayer();
        return;
      }
      const url = await resolveMediaUrl(media);
      if (gen !== mediaGeneration) return; // 已被更快的后续改动取代
      if (!url) {
        removeMediaLayer();
        return;
      }
      renderMediaLayer(media, url);
    }
    //#endregion

    //#region 主题令牌覆盖
    let skinDisposer = null;

    function applySkinTokens(ctx, config) {
      const theme = ctx && ctx.theme;
      if (!theme || typeof theme.overrideTokens !== "function") return;
      const tokens = {};
      const colors = config.colors || {};
      const media = config.media || {};
      const mediaOn = !!media.enabled && !!(media.url || media.blobId);

      for (const def of SKIN_TOKENS) {
        const c = colors[def.key];
        if (c) tokens[def.key] = { light: c, dark: c };
      }

      if (mediaOn) {
        // 背景开启：画布底色透明让媒体透出，各表面层变为半透明 + 可调不透明度
        const alpha = clamp01(typeof media.alpha === "number" ? media.alpha : 0.72);
        const base = baseBgTokens(activeScheme(ctx));
        const layer1 = colors["--dsw-alias-bg-layer-1"] || base.layer1;
        const layer2 = colors["--dsw-alias-bg-layer-2"] || base.layer2;
        const overlay = colors["--dsw-alias-bg-overlay"] || base.overlay;
        const sidebar = colors["--dsw-specific-sidebar-fill"] || base.sidebar;
        tokens["--dsw-alias-bg-base"] = { light: "rgba(0,0,0,0)", dark: "rgba(0,0,0,0)" };
        tokens["--dsw-alias-bg-layer-1"] = { light: withAlpha(layer1, alpha), dark: withAlpha(layer1, alpha) };
        tokens["--dsw-alias-bg-layer-2"] = { light: withAlpha(layer2, alpha), dark: withAlpha(layer2, alpha) };
        tokens["--dsw-alias-bg-overlay"] = { light: withAlpha(overlay, alpha), dark: withAlpha(overlay, alpha) };
        tokens["--dsw-specific-sidebar-fill"] = { light: withAlpha(sidebar, alpha), dark: withAlpha(sidebar, alpha) };
      }

      try {
        if (skinDisposer) {
          skinDisposer();
          skinDisposer = null;
        }
        if (Object.keys(tokens).length) {
          skinDisposer = theme.overrideTokens(NS, tokens);
        }
      } catch {}
    }
    //#endregion

    //#region 配置读写与生效
    let ctxRef = null;
    let scopeRef = null;

    function persistConfig(scope, config) {
      const json = JSON.stringify(config);
      try {
        if (scope && typeof scope.set === "function") scope.set("config", json);
      } catch {}
      try {
        localStorage.setItem(LS_KEY, json);
      } catch {}
    }

    function readConfig(scope) {
      try {
        const snap = scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : null;
        const raw = snap && snap.value ? snap.value.config : undefined;
        if (typeof raw === "string" && raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") return normalizeConfig(parsed);
        }
      } catch {}
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") return normalizeConfig(parsed);
        }
      } catch {}
      return clone(DEFAULT_CONFIG);
    }

    async function applyConfig(ctx, scope, config) {
      const cfg = normalizeConfig(config);
      window.__dshkitSkinConfig = cfg;
      persistConfig(scope, cfg);
      applySkinTokens(ctx, cfg);
      // 同步广播给设置面板，确保组件状态始终反映最新配置
      window.dispatchEvent(new CustomEvent("dshkit:skin-config", { detail: cfg }));
      await applyMediaLayer(cfg);
    }

    /** 设置面板与 apply 侧的公共提交入口（参数为已克隆的 config 片段）。 */
    function commitConfig(next) {
      const current = window.__dshkitSkinConfig || clone(DEFAULT_CONFIG);
      const merged = { ...current, ...(next || {}) };
      if (next && next.colors) merged.colors = { ...next.colors };
      if (next && next.media) merged.media = { ...current.media, ...next.media };
      const cfg = normalizeConfig(merged);
      applyConfig(ctxRef.current, scopeRef.current, cfg).catch(() => {});
    }
    //#endregion

    //#region 设置面板组件
    const css = [
      ".sk-root{display:flex;flex-direction:column;gap:18px;padding:2px 2px 24px;width:100%;max-width:560px}",
      ".sk-group{border-bottom:1px solid var(--dsw-alias-border-l2,#343b48);padding-bottom:14px}",
      ".sk-groupTitle{color:var(--dsw-alias-label-primary,#eceff4);font-size:14px;line-height:22px;margin:0 0 10px}",
      ".sk-desc{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:12px;line-height:18px;margin:0 0 4px}",
      ".sk-row{display:flex;align-items:center;gap:8px;padding:4px 0}",
      ".sk-label{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#aab1bd);font-size:12.5px;line-height:20px}",
      ".sk-colorWrap{display:flex;align-items:center;gap:6px}",
      ".sk-color{width:36px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l2,#343b48);border-radius:6px;background:none;cursor:pointer}",
      ".sk-colorText{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:10.5px;line-height:14px;min-width:54px;overflow:hidden;text-overflow:ellipsis}",
      ".sk-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#343b48);background:none;color:var(--dsw-alias-label-primary,#eceff4);font:inherit;font-size:12px;line-height:20px;border-radius:7px;padding:3px 10px}",
      ".sk-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
      ".sk-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".sk-btn-primary{border-color:var(--dsw-alias-state-business-primary,#4c8dff);color:#fff;background:var(--dsw-alias-state-business-primary,#4c8dff)}",
      ".sk-seg{display:flex;gap:6px}",
      ".sk-segBtn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#343b48);background:none;color:var(--dsw-alias-label-secondary,#aab1bd);font:inherit;font-size:12px;line-height:20px;border-radius:8px;padding:4px 12px}",
      ".sk-segBtn.on{color:#fff;background:var(--dsw-alias-state-business-primary,#4c8dff);border-color:var(--dsw-alias-state-business-primary,#4c8dff)}",
      ".sk-input{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#343b48);outline:none;background:var(--dsw-alias-bg-layer-1,#15181f);color:var(--dsw-alias-label-primary,#eceff4);font:inherit;font-size:12.5px;line-height:20px;border-radius:7px;padding:4px 8px}",
      ".sk-range{flex:1;min-width:0;accent-color:var(--dsw-alias-state-business-primary,#4c8dff)}",
      ".sk-rangeVal{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:11px;line-height:16px;min-width:26px;text-align:right}",
      ".sk-hint{color:var(--dsw-alias-label-tertiary,#7d8592);font-size:11.5px;line-height:17px;margin-top:2px}",
      ".sk-fileInfo{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary,#aab1bd);font-size:12px;line-height:18px;min-width:0}",
      ".sk-fileName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".sk-err{color:var(--dsw-alias-state-error-primary,#f05454);font-size:11.5px;line-height:16px}",
      ".sk-foot{display:flex;justify-content:flex-end;gap:10px;padding-top:4px}",
    ].join("");
    const tagId = "@dsh-kit/plugin-theme-skin/styles";
    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@dsh-kit/plugin-theme-skin";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    function SkinSettings(props) {
      const { close, t } = props;
      const tr = typeof t === "function" ? t : (k) => zh[k] || k;
      const [config, setConfig] = useState(() => window.__dshkitSkinConfig || clone(DEFAULT_CONFIG));
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState("");
      const fileRef = useRef(null);

      useEffect(() => {
        const onCfg = (ev) => setConfig(ev.detail || clone(DEFAULT_CONFIG));
        window.addEventListener("dshkit:skin-config", onCfg);
        return () => window.removeEventListener("dshkit:skin-config", onCfg);
      }, []);

      const media = config.media;
      const mediaOn = media.enabled && !!(media.url || media.blobId);

      const setMedia = (patch) =>
        commitConfig({ media: { ...media, ...patch } });

      const setColor = (key, value) =>
        commitConfig({ colors: { ...config.colors, [key]: value } });

      const clearColor = (key) => {
        const colors = { ...config.colors };
        delete colors[key];
        commitConfig({ colors });
      };

      const resetAll = () => {
        const old = window.__dshkitSkinConfig || config;
        if (old.media && old.media.blobId) {
          idbDelete(old.media.blobId).catch(() => {});
          blobUrlCache.delete(String(old.media.blobId));
        }
        commitConfig(clone(DEFAULT_CONFIG));
        setErr("");
      };

      const onUpload = (e) => {
        const file = e.target && e.target.files && e.target.files[0];
        if (e.target) e.target.value = "";
        if (!file) return;
        const wantVideo = media.kind === "video";
        if (wantVideo && !/^video\//.test(file.type)) {
          setErr(tr("err.type").replace("{kind}", tr("media.video")));
          return;
        }
        if (!wantVideo && !/^image\//.test(file.type)) {
          setErr(tr("err.type").replace("{kind}", tr("media.image")));
          return;
        }
        if (file.size > MAX_FILE_BYTES) {
          setErr(tr("err.size"));
          return;
        }
        setErr("");
        setBusy(true);
        const id = "media:" + Date.now().toString(36) + ":" + Math.random().toString(36).slice(2, 8);
        idbPut({ id, name: file.name, type: file.type, size: file.size, blob: file })
          .then(() => {
            setMedia({ enabled: true, url: "", blobId: id, name: file.name });
          })
          .catch((ex) => {
            setErr(tr("err.idb") + "：" + ((ex && ex.message) || ex));
          })
          .finally(() => setBusy(false));
      };

      const removeMedia = () => {
        if (media.blobId) {
          idbDelete(media.blobId).catch(() => {});
          blobUrlCache.delete(String(media.blobId));
        }
        setMedia({ enabled: false, url: "", blobId: null, name: "" });
      };

      return jsxs("div", {
        className: "sk-root",
        children: [
          // 主题颜色
          jsxs("div", {
            className: "sk-group",
            children: [
              jsx("h3", { className: "sk-groupTitle", children: tr("group.colors") }),
              jsx("p", { className: "sk-desc", children: tr("section.desc") }),
              SKIN_TOKENS.map((def) => {
                const value = config.colors[def.key] || resolveCssVar(def.key, def.fallback);
                return jsxs("div", {
                  className: "sk-row",
                  children: [
                    jsx("span", { className: "sk-label", children: def.label }),
                    jsxs("span", { className: "sk-colorWrap", children: [
                      jsx("input", {
                        type: "color",
                        className: "sk-color",
                        value: /^#[0-9a-f]{6}$/i.test(value) ? value : def.fallback,
                        onChange: (e) => setColor(def.key, e.currentTarget.value),
                        title: value,
                      }),
                      jsx("span", { className: "sk-colorText", children: value }),
                      jsx("button", {
                        type: "button",
                        className: "sk-btn",
                        onClick: () => clearColor(def.key),
                        children: "×",
                        title: tr("reset"),
                      }),
                    ] }),
                  ],
                }, def.key);
              }),
            ],
          }),

          // 背景图 / 背景视频
          jsxs("div", {
            className: "sk-group",
            children: [
              jsx("h3", { className: "sk-groupTitle", children: tr("group.media") }),
              jsxs("div", {
                className: "sk-row",
                children: [
                  jsx("span", { className: "sk-label", children: tr("media.none") }),
                  jsxs("div", { className: "sk-seg", children: [
                    jsx("button", {
                      type: "button",
                      className: "sk-segBtn" + (!media.enabled ? " on" : ""),
                      onClick: () => setMedia({ enabled: false }),
                      children: tr("media.none"),
                    }),
                    jsx("button", {
                      type: "button",
                      className: "sk-segBtn" + (media.enabled && media.kind === "image" ? " on" : ""),
                      onClick: () => setMedia({ enabled: true, kind: "image", blobId: null, url: "", name: "" }),
                      children: tr("media.image"),
                    }),
                    jsx("button", {
                      type: "button",
                      className: "sk-segBtn" + (media.enabled && media.kind === "video" ? " on" : ""),
                      onClick: () => setMedia({ enabled: true, kind: "video", blobId: null, url: "", name: "" }),
                      children: tr("media.video"),
                    }),
                  ] }),
                ],
              }),
              media.enabled
                ? jsxs(Fragment, {
                    children: [
                      jsx("p", { className: "sk-desc", children: media.kind === "video" ? tr("media.videoHint") : tr("media.imageHint") }),
                      jsx("div", { className: "sk-row", children: [
                        jsx("span", { className: "sk-label", children: tr("media.url") }),
                        jsx("input", {
                          type: "text",
                          className: "sk-input",
                          placeholder: "https://…",
                          spellCheck: false,
                          defaultValue: media.url,
                          onBlur: (e) => {
                            const v = e.currentTarget.value.trim();
                            if (v !== media.url) setMedia({ url: v, blobId: null, name: "" });
                          },
                          onKeyDown: (e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          },
                        }),
                      ] }),
                      jsx("div", { className: "sk-row", children: [
                        jsx("span", { className: "sk-label", children: tr("media.upload") }),
                        jsx("button", {
                          type: "button",
                          className: "sk-btn" + (mediaOn ? "" : " sk-btn-primary"),
                          onClick: () => fileRef.current && fileRef.current.click(),
                          disabled: busy,
                          children: busy ? tr("busyUpload") : tr("media.upload"),
                        }),
                        mediaOn
                          ? jsx("button", {
                              type: "button",
                              className: "sk-btn",
                              onClick: removeMedia,
                              children: tr("media.remove"),
                            })
                          : null,
                      ] }),
                      jsx("input", {
                        ref: fileRef,
                        type: "file",
                        accept: media.kind === "video" ? "video/*" : "image/*",
                        style: { display: "none" },
                        onChange: onUpload,
                      }),
                      media.name
                        ? jsx("div", { className: "sk-fileInfo", children: [
                            jsx("span", { className: "sk-fileName", children: tr("media.fileName") + " " + media.name }),
                          ] })
                        : null,
                      mediaOn
                        ? jsxs(Fragment, {
                            children: [
                              jsx("div", { className: "sk-row", children: [
                                jsx("span", { className: "sk-label", children: tr("media.alpha") }),
                                jsx("input", {
                                  type: "range",
                                  className: "sk-range",
                                  min: 0.35,
                                  max: 1,
                                  step: 0.01,
                                  value: clamp01(typeof media.alpha === "number" ? media.alpha : 0.72),
                                  onChange: (e) => setMedia({ alpha: Number(e.currentTarget.value) }),
                                }),
                                jsx("span", { className: "sk-rangeVal", children: Math.round((clamp01(typeof media.alpha === "number" ? media.alpha : 0.72)) * 100) + "%" }),
                              ] }),
                              jsx("div", { className: "sk-row", children: [
                                jsx("span", { className: "sk-label", children: tr("media.dim") }),
                                jsx("input", {
                                  type: "range",
                                  className: "sk-range",
                                  min: 0,
                                  max: 0.9,
                                  step: 0.01,
                                  value: clamp01(media.dim),
                                  onChange: (e) => setMedia({ dim: Number(e.currentTarget.value) }),
                                }),
                                jsx("span", { className: "sk-rangeVal", children: Math.round(clamp01(media.dim) * 100) + "%" }),
                              ] }),
                              jsx("div", { className: "sk-row", children: [
                                jsx("span", { className: "sk-label", children: tr("media.blur") }),
                                jsx("input", {
                                  type: "range",
                                  className: "sk-range",
                                  min: 0,
                                  max: 30,
                                  step: 1,
                                  value: clamp(Number(media.blur) || 0, 0, 30),
                                  onChange: (e) => setMedia({ blur: Number(e.currentTarget.value) }),
                                }),
                                jsx("span", { className: "sk-rangeVal", children: (Number(media.blur) || 0) + "px" }),
                              ] }),
                              media.kind === "image"
                                ? jsx("div", { className: "sk-row", children: [
                                    jsx("span", { className: "sk-label", children: tr("media.fit") }),
                                    jsxs("div", { className: "sk-seg", children: [
                                      jsx("button", {
                                        type: "button",
                                        className: "sk-segBtn" + (media.fit !== "contain" ? " on" : ""),
                                        onClick: () => setMedia({ fit: "cover" }),
                                        children: tr("media.fit.cover"),
                                      }),
                                      jsx("button", {
                                        type: "button",
                                        className: "sk-segBtn" + (media.fit === "contain" ? " on" : ""),
                                        onClick: () => setMedia({ fit: "contain" }),
                                        children: tr("media.fit.contain"),
                                      }),
                                    ] }),
                                  ] })
                                : null,
                              jsx("p", { className: "sk-hint", children: tr("media.transparentNote") }),
                            ],
                          })
                        : null,
                    ],
                  })
                : null,
              err ? jsx("div", { className: "sk-err", children: err }) : null,
            ],
          }),

          jsx("div", {
            className: "sk-foot",
            children: [
              jsx("button", { type: "button", className: "sk-btn", onClick: resetAll, children: tr("reset") }),
              jsx("button", { type: "button", className: "sk-btn sk-btn-primary", onClick: () => close && close(), children: tr("done") }),
            ],
          }),
        ],
      });
    }
    //#endregion

    //#region plugin entry
    const inject = ["slots", "locale", "theme", "settingsScope"];

    function apply(ctx) {
      ctxRef = { current: ctx };
      let scope = null;
      try {
        if (ctx.settingsScope && typeof ctx.settingsScope.bind === "function") {
          scope = ctx.settingsScope.bind({ namespace: NS });
        }
      } catch {}
      scopeRef = { current: scope };

      const t = ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : ((k) => k);

      // 注册本插件词典（缺省回退 key 原文）
      if (ctx.locale && typeof ctx.locale.register === "function") {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plugin-theme-skin: dictionaries");
      }

      // 启动恢复：读持久化配置并生效
      applyConfig(ctx, scope, readConfig(scope)).catch(() => {});

      // 其它端（设置文档更新 / 连接重置）改动时同步
      if (scope && typeof scope.subscribe === "function") {
        scope.subscribe(() => {
          applyConfig(ctx, scope, readConfig(scope)).catch(() => {});
        });
      }

      // 设置页：设置 → 主题换肤
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: SETTINGS_SECTION_ID,
            order: 40,
            label: () => t("section.label"),
            locale: NS,
          },
          SkinSettings
        )
      );

      // 卸载清理
      ctx.effect(
        () => () => {
          try {
            if (skinDisposer) skinDisposer();
          } catch {}
          removeMediaLayer();
          for (const url of blobUrlCache.values()) {
            try {
              URL.revokeObjectURL(url);
            } catch {}
          }
          blobUrlCache.clear();
        },
        "plugin-theme-skin: unload"
      );
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
