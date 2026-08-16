import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  navConsole: $("nav-console"),
  navHarness: $("nav-harness"),
  navMarket: $("nav-market"),
  navSkills: $("nav-skills"),
  statusPill: $("status-pill"),
  btnPrimary: $("btn-primary"),
  btnSecondary: $("btn-secondary"),
  btnSettings: $("btn-settings"),
  btnSidebarSettings: $("btn-sidebar-settings"),
  btnSidebarUpdate: $("btn-sidebar-update"),
  modalUpdate: $("modal-update"),
  updateText: $("update-text"),
  updateProgress: $("update-progress"),
  updateLog: $("update-log"),
  releaseList: $("release-list"),
  releaseItems: $("release-items"),
  btnCloseUpdate: $("btn-close-update"),
  btnUpdateCancel: $("btn-update-cancel"),
  btnUpdateAction: $("btn-update-action"),
  sidebarFooter: $("sidebar-footer"),
  log: $("log"),
  viewControl: $("view-control"),
  viewPage: $("view-page"),
  frame: $("harness-frame"),
  pageOverlay: $("page-overlay"),
  fab: $("float-fab"),
  fabToggle: $("fab-toggle"),
  fabMenu: $("fab-menu"),
  btnOverlayBack: $("btn-overlay-back"),
  modal: $("modal-settings"),
  btnCloseSettings: $("btn-close-settings"),
  btnSaveSettings: $("btn-save-settings"),
  modalMarket: $("modal-market"),
  marketTabs: $("market-tabs"),
  panelMarket: $("panel-market"),
  panelLocal: $("panel-local"),
  marketList: $("market-list"),
  marketOnlineList: $("market-online-list"),
  pluginSearchInput: $("plugin-search-input"),
  pluginSearchBtn: $("plugin-search-btn"),
  pluginSearchStatus: $("plugin-search-status"),
  externalPluginList: $("external-plugin-list"),
  extSource: $("ext-source"),
  extFullName: $("ext-full-name"),
  extAddBtn: $("ext-add-btn"),
  btnCloseMarket: $("btn-close-market"),
  btnCloseMarket2: $("btn-close-market-2"),
  btnMarketRefresh: $("btn-market-refresh"),
  modalSkills: $("modal-skills"),
  skillsTabs: $("skills-tabs"),
  panelMy: $("panel-my"),
  panelPlazaSkills: $("panel-plaza-skills"),
  panelPlazaExperts: $("panel-plaza-experts"),
  mySkills: $("my-skills"),
  myExperts: $("my-experts"),
  plazaSkills: $("plaza-skills"),
  plazaExperts: $("plaza-experts"),
  skillsSearchInput: $("skills-search-input"),
  skillsSearchBtn: $("skills-search-btn"),
  skillsImportZip: $("skills-import-zip"),
  skillsImportDir: $("skills-import-dir"),
  skillsZipInput: $("skills-zip-input"),
  skillsDirInput: $("skills-dir-input"),
  pluginImportZip: $("plugin-import-zip"),
  pluginImportDir: $("plugin-import-dir"),
  pluginZipInput: $("plugin-zip-input"),
  pluginDirInput: $("plugin-dir-input"),
  btnCloseSkills: $("btn-close-skills"),
  btnCloseSkills2: $("btn-close-skills-2"),
  btnSkillsRefresh: $("btn-skills-refresh"),
  setRegistry: $("set-registry"),
  setPort: $("set-port"),
  setAutoStart: $("set-auto-start"),
  setStopOnExit: $("set-stop-on-exit"),
  setDataDir: $("set-data-dir"),
  setSkillshubUrl: $("set-skillshub-url"),
  badges: {
    node: $("badge-node"), dsh: $("badge-dsh"), service: $("badge-service"),
  },
  details: {
    node: $("detail-node"), dsh: $("detail-dsh"), service: $("detail-service"),
  },
};

// ---------- 全局状态 ----------
let status = null; // 最近一次 get_status
let settings = null;
let busy = false;
let currentView = "control"; // control | page
let logBuffer = [];
const LOG_MAX = 3000;

// ---------- 视图切换 ----------
function switchView(view) {
  currentView = view;
  el.viewControl.classList.toggle("active", view === "control");
  el.viewPage.classList.toggle("active", view === "page");
  el.navConsole.classList.toggle("active", view === "control");
  el.navHarness.classList.toggle("active", view === "page");
  if (view === "page") {
    const port = settings?.port ?? 3080;
    el.frame.src = `http://127.0.0.1:${port}/`;
    refreshPageOverlay();
  }
}

function refreshPageOverlay() {
  const running = !!status?.service?.running;
  el.pageOverlay.hidden = running;
}

el.navConsole.addEventListener("click", () => switchView("control"));

el.navHarness.addEventListener("click", () => {
  if (!status?.service?.running) {
    // 服务未运行：切换到页面视图并显示提示层
    switchView("page");
    return;
  }
  switchView("page");
});

el.btnOverlayBack.addEventListener("click", () => switchView("control"));

// ---------- 悬浮操作按钮（可拖动 + 点击展开菜单） ----------
function pageUrl() {
  const port = settings?.port ?? 3080;
  return `http://127.0.0.1:${port}/`;
}

function closeFabMenu() {
  el.fabMenu.hidden = true;
  el.fabToggle.classList.remove("open");
  el.fabToggle.setAttribute("aria-expanded", "false");
}

el.fabToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  const opening = el.fabMenu.hidden;
  el.fabMenu.hidden = !opening;
  el.fabToggle.classList.toggle("open", opening);
  el.fabToggle.setAttribute("aria-expanded", String(opening));
});

el.fabMenu.addEventListener("click", (e) => {
  const action = e.target?.closest?.("button")?.dataset?.action;
  if (!action) return;
  closeFabMenu();
  if (action === "refresh") {
    el.frame.src = pageUrl();
  } else if (action === "open-browser") {
    invoke("open_browser", { url: pageUrl() }).catch((err) => logLine(`打开浏览器失败: ${err}`, "err"));
  } else if (action === "back") {
    switchView("control");
  }
});

// 点击页面其它区域时收起菜单
document.addEventListener("pointerdown", (e) => {
  if (currentView === "page" && !el.fabMenu.hidden && !el.fab.contains(e.target)) {
    closeFabMenu();
  }
});

// 拖动悬浮按钮（仅移动位置，不触发点击）
(function initFabDrag() {
  const fab = el.fab;
  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, origX = 0, origY = 0;

  el.fabToggle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = fab.getBoundingClientRect();
    origX = rect.left;
    origY = rect.top;
    el.fabToggle.setPointerCapture?.(e.pointerId);
  });

  el.fabToggle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    if (!moved) return;
    // 限制在视口内，避免拖出窗口边缘拿不回来
    const W = window.innerWidth;
    const H = window.innerHeight;
    const r = 46;
    let x = origX + dx;
    let y = origY + dy;
    x = Math.max(4, Math.min(W - r - 4, x));
    y = Math.max(4, Math.min(H - r - 4, y));
    fab.style.left = `${x}px`;
    fab.style.top = `${y}px`;
    fab.style.right = "auto";
    fab.style.bottom = "auto";
  });

  el.fabToggle.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      el.fabToggle.releasePointerCapture?.(e.pointerId);
    } catch {}
    if (moved) {
      // 拖动了：这次是拖动，不当作点击，收起菜单
      closeFabMenu();
    }
  });

  el.fabToggle.addEventListener("pointercancel", () => {
    dragging = false;
  });
})();

// ---------- 日志 ----------
function logLine(text, kind = "out") {
  const line = document.createElement("div");
  line.className = `log-line-${kind}`;
  line.textContent = text;
  el.log.appendChild(line);
  logBuffer.push(line);
  while (logBuffer.length > LOG_MAX) {
    const old = logBuffer.shift();
    old.remove();
  }
  el.log.scrollTop = el.log.scrollHeight;
}

function logClear() {
  el.log.innerHTML = "";
  logBuffer = [];
}

// ---------- 状态渲染 ----------
function badge(elBadge, state, text) {
  elBadge.className = `card-badge ${state}`;
  elBadge.textContent = text;
}

function renderStatus(s) {
  status = s;
  const svc = s.service;
  const dsh = s.dsh;

  if (s.version) el.sidebarFooter.textContent = `v${s.version}`;

  // 顶部状态
  if (busy) {
    setPill("进行中…", "amber");
  } else if (svc?.running) {
    setPill("运行中", "green");
  } else if (dsh?.ready) {
    setPill("已就绪 · 未启动", "amber");
  } else {
    setPill("未部署", "gray");
  }

  // Node
  if (s.node?.ok) {
    badge(el.badges.node, "ok", "可用");
    el.details.node.textContent = `${s.node.version}${s.node.managed ? "（应用内置便携版）" : "（系统安装）"}`;
  } else if (s.node?.present) {
    badge(el.badges.node, "warn", "版本不符");
    el.details.node.textContent = `当前 ${s.node.version}，需要 Node ^22.19 || >=24；可自动安装便携版`;
  } else {
    badge(el.badges.node, "bad", "缺失");
    el.details.node.textContent = "未检测到 Node.js，部署时将自动下载便携版";
  }

  // dsh 运行时（npx）
  if (dsh?.ready) {
    badge(el.badges.dsh, "ok", "可用");
    el.details.dsh.textContent = `@deepseek-ai/dsh v${dsh.version ?? "?"}（npx 缓存已就绪）`;
  } else {
    badge(el.badges.dsh, "bad", "未获取");
    el.details.dsh.textContent = "尚未获取运行时，一键部署将自动通过 npx 下载官方包";
  }

  // 服务
  if (svc?.running) {
    badge(el.badges.service, "ok", "运行中");
    el.details.service.textContent = `${svc.url}${svc.pid ? `（PID ${svc.pid}）` : ""}`;
  } else {
    badge(el.badges.service, "bad", "未运行");
    el.details.service.textContent = `http://127.0.0.1:${s.settings?.port ?? 3080}`;
  }

  renderButtons();
  refreshPageOverlay();
}

function setPill(text, tone) {
  el.statusPill.textContent = text;
  el.statusPill.className = `pill pill-${tone}`;
}

function renderButtons() {
  const s = status;
  el.btnPrimary.disabled = busy;
  el.btnPrimary.classList.toggle("busy", busy);
  el.btnSecondary.hidden = busy || !s?.dsh?.ready;

  if (busy) {
    el.btnPrimary.textContent = "进行中，请稍候…";
    return;
  }
  if (s?.service?.running) {
    el.btnPrimary.textContent = "停止服务";
  } else if (s?.dsh?.ready) {
    el.btnPrimary.textContent = "一键启动";
  } else {
    el.btnPrimary.textContent = "一键部署";
  }
}

// ---------- 主操作按钮 ----------
el.btnPrimary.addEventListener("click", async () => {
  if (busy) return;
  const s = status;
  if (s?.service?.running) {
    await runAction("stop_service", "正在停止服务…");
  } else if (s?.dsh?.ready) {
    await runAction("start_service", "正在启动服务…");
  } else {
    await runAction("deploy", "开始部署…");
  }
});

el.btnSecondary.addEventListener("click", () => {
  if (busy) return;
  invoke("deploy", { force: true })
    .then(() => logLine("部署完成", "ok"))
    .catch((e) => logLine(`部署失败: ${e}`, "err"))
    .finally(refresh);
});

async function runAction(cmd, hint) {
  busy = true;
  renderButtons();
  logLine(hint, "step");
  try {
    await invoke(cmd);
  } catch (e) {
    logLine(`操作失败: ${e}`, "err");
  } finally {
    busy = false;
    refresh();
  }
}

// ---------- 事件监听（后端推送） ----------
async function setupEvents() {
  await listen("deploy:log", (ev) => {
    const p = ev.payload;
    const kind = p.kind === "err" ? "err" : p.kind === "step" ? "step" : "out";
    logLine(p.line, kind);
  });
  await listen("deploy:download", (ev) => {
    const p = ev.payload;
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    logLine(`[下载] ${p.label} ${mb(p.done)} / ${mb(p.total)} MB`, "dim");
  });
  await listen("service:log", (ev) => {
    logLine(ev.payload.line, ev.payload.kind === "err" ? "err" : "dim");
  });
  await listen("service:state", (ev) => {
    const p = ev.payload;
    if (p.state === "starting") logLine("服务启动中…", "step");
    if (p.state === "ready") {
      logLine(`服务已就绪：${p.url}`, "ok");
      refresh().then(() => {
        if (settings?.auto_start_after_deploy !== false) switchView("page");
      });
    }
    if (p.state === "stopped") {
      logLine("服务已停止", "ok");
      refresh();
    }
    if (p.state === "failed") {
      logLine("服务启动失败，请查看上方日志", "err");
      refresh();
    }
  });
  await listen("update:download", (ev) => {
    const p = ev.payload;
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    const line = `[下载] ${p.label} ${mb(p.done)} / ${mb(p.total)} MB`;
    updateLogLine(line);
    logLine(line, "dim");
  });
}

// ---------- 设置 ----------
function renderPluginRows(container, plugins) {
  container.innerHTML = "";
  if (!plugins || !plugins.length) {
    container.innerHTML = '<div class="plugin-row dim">暂无内置插件</div>';
    return;
  }
  for (const p of plugins) {
    const row = document.createElement("div");
    row.className = "plugin-row";

    const info = document.createElement("div");
    info.className = "plugin-info";
    const name = document.createElement("div");
    name.className = "plugin-name";
    name.textContent = p.name;
    info.appendChild(name);
    if (p.description) {
      const desc = document.createElement("div");
      desc.className = "plugin-desc";
      desc.textContent = p.description;
      info.appendChild(desc);
    }

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "plugin-toggle" + (p.enabled ? " on" : "");
    toggle.title = p.enabled ? "点击停用（重启服务后生效）" : "点击启用（重启服务后生效）";
    toggle.addEventListener("click", async () => {
      const target = !p.enabled;
      toggle.disabled = true;
      try {
        await invoke("set_builtin_plugin_enabled", { name: p.name, enabled: target });
        p.enabled = target;
        toggle.classList.toggle("on", target);
        logLine(`${p.name} 已${target ? "启用" : "停用"}（重启服务后生效）`, "ok");
      } catch (e) {
        logLine(`切换插件失败: ${e}`, "err");
      } finally {
        toggle.disabled = false;
      }
    });

    row.appendChild(info);
    row.appendChild(toggle);
    container.appendChild(row);
  }
}

// ---------- 插件市场面板 ----------
let marketTab = "market"; // market | local
let marketSearchDone = false; // 是否已自动搜过一次（打开市场 tab 时兜底展示热门插件）

function switchMarketTab(tab) {
  marketTab = tab;
  for (const btn of el.marketTabs.querySelectorAll(".market-tab")) {
    btn.dataset.active = btn.dataset.tab === tab ? "1" : "";
  }
  el.panelMarket.dataset.active = tab === "market" ? "1" : "";
  el.panelLocal.dataset.active = tab === "local" ? "1" : "";
  if (tab === "local") loadMarket();
  if (tab === "market" && !marketSearchDone) {
    marketSearchDone = true;
    searchPlugins("");
  }
}

function openMarket() {
  el.modalMarket.hidden = false;
  switchMarketTab(marketTab);
}

async function loadMarket() {
  el.marketList.innerHTML = '<div class="plugin-row dim">读取中…</div>';
  el.externalPluginList.innerHTML = '<div class="plugin-row dim">读取中…</div>';
  try {
    const plugins = await invoke("list_builtin_plugins");
    renderPluginRows(el.marketList, plugins);
  } catch (e) {
    el.marketList.innerHTML = `<div class="plugin-row dim">读取插件失败：${e}</div>`;
  }
  try {
    const external = await invoke("list_external_plugins");
    renderExternalPluginRows(external);
  } catch (e) {
    el.externalPluginList.innerHTML = `<div class="plugin-row dim">读取外部插件配置失败：${e}</div>`;
  }
}

// 渲染「外部内置插件」配置列表
function renderExternalPluginRows(list) {
  el.externalPluginList.innerHTML = "";
  if (!list || !list.length) {
    el.externalPluginList.innerHTML = '<div class="plugin-row dim">暂无配置，可在此添加 GitHub 仓库或 npm 包作为外部内置插件</div>';
    return;
  }
  for (const p of list) el.externalPluginList.appendChild(buildExternalRow(p));
}

function buildExternalRow(p) {
  const row = document.createElement("div");
  row.className = "ext-row";

  const info = document.createElement("div");
  info.className = "ext-row-info";
  const name = document.createElement("div");
  name.className = "ext-row-name";
  const srcBadge = document.createElement("span");
  srcBadge.className = "market-card-src " + (p.source === "npm" ? "npm" : "github");
  srcBadge.textContent = p.source === "npm" ? "npm" : "GitHub";
  name.appendChild(srcBadge);
  const full = document.createElement("span");
  full.textContent = p.full_name;
  name.appendChild(full);
  info.appendChild(name);
  if (p.description) {
    const desc = document.createElement("div");
    desc.className = "ext-row-desc";
    desc.textContent = p.description;
    info.appendChild(desc);
  }
  const status = document.createElement("div");
  status.className = "ext-row-status " + (p.enabled ? "ok" : p.installed ? "pending" : "none");
  status.textContent = p.enabled ? "已启用（重启服务后生效）" : p.installed ? "已安装 · 未启用" : "未安装";
  info.appendChild(status);
  row.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "ext-row-actions";

  // 安装并启用（未安装或未启用时显示）
  if (!p.enabled) {
    const install = document.createElement("button");
    install.type = "button";
    install.className = "ext-row-btn primary";
    install.textContent = p.installed ? "启用" : "安装并启用";
    install.addEventListener("click", async () => {
      install.disabled = true;
      install.textContent = "处理中…";
      try {
        await invoke("install_external_plugin", { name: p.name });
        logLine(`外部内置插件已启用：${p.full_name}（重启 dsh 服务后生效）`, "ok");
        loadMarket();
      } catch (e) {
        logLine(`安装外部内置插件失败：${e}`, "err");
        install.disabled = false;
        install.textContent = p.installed ? "启用" : "安装并启用";
      }
    });
    actions.appendChild(install);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ext-row-btn danger";
  remove.textContent = "移除配置";
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    try {
      await invoke("remove_external_plugin", { name: p.name });
      logLine(`已移除外部内置插件配置：${p.full_name}`, "ok");
      loadMarket();
    } catch (e) {
      logLine(`移除配置失败：${e}`, "err");
      remove.disabled = false;
    }
  });
  actions.appendChild(remove);
  row.appendChild(actions);
  return row;
}

// 搜索远程插件（GitHub -> npm 兜底），渲染结果卡片
async function searchPlugins(query) {
  const q = (query ?? "").trim();
  el.pluginSearchStatus.textContent = "正在搜索…";
  el.marketOnlineList.innerHTML = '<div class="market-card-empty">正在搜索，请稍候…</div>';
  try {
    const plugins = await invoke("search_remote_plugins", { query: q });
    el.pluginSearchStatus.textContent = `共找到 ${plugins.length} 个插件`;
    if (!plugins.length) {
      el.marketOnlineList.innerHTML = '<div class="market-card-empty">未找到相关插件，换个关键词试试</div>';
      return;
    }
    el.marketOnlineList.innerHTML = "";
    for (const p of plugins) el.marketOnlineList.appendChild(buildPluginCard(p));
  } catch (e) {
    el.pluginSearchStatus.textContent = "搜索失败";
    el.marketOnlineList.innerHTML = `<div class="market-card-empty">搜索失败：${e}</div>`;
  }
}

function buildPluginCard(p) {
  const card = document.createElement("div");
  card.className = "market-card";

  const info = document.createElement("div");
  info.className = "market-card-info";

  const name = document.createElement("div");
  name.className = "market-card-name";
  name.textContent = p.name;
  if (p.source === "github") {
    const src = document.createElement("span");
    src.className = "market-card-src github";
    src.textContent = "GitHub";
    name.appendChild(src);
    if (p.stars > 0) {
      const stars = document.createElement("span");
      stars.className = "market-card-stars";
      stars.textContent = `★ ${p.stars}`;
      name.appendChild(stars);
    }
  } else if (p.source === "npm") {
    const src = document.createElement("span");
    src.className = "market-card-src npm";
    src.textContent = "npm";
    name.appendChild(src);
  }
  info.appendChild(name);

  if (p.description) {
    const desc = document.createElement("div");
    desc.className = "market-card-desc";
    desc.textContent = p.description;
    info.appendChild(desc);
  }

  const meta = document.createElement("div");
  meta.className = "market-card-meta";
  const id = document.createElement("span");
  id.className = "market-card-id";
  id.textContent = p.full_name;
  meta.appendChild(id);
  info.appendChild(meta);

  card.appendChild(info);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "market-card-action btn-secondary" + (p.installed ? " installed" : "");
  btn.textContent = p.installed ? "已安装" : "安装";
  btn.disabled = !!p.installed;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "安装中…";
    try {
      await invoke("install_remote_plugin", {
        source: p.source,
        fullName: p.full_name,
        defaultBranch: p.default_branch ?? null,
      });
      logLine(`插件已安装：${p.name}（可在「本地插件」中启用，重启 dsh 服务后生效）`, "ok");
      btn.classList.add("installed");
      btn.textContent = "已安装";
      p.installed = true;
    } catch (e) {
      logLine(`安装插件失败：${e}`, "err");
      btn.disabled = false;
      btn.textContent = "安装";
    }
  });
  card.appendChild(btn);
  return card;
}

el.navMarket.addEventListener("click", openMarket);
el.marketTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".market-tab");
  if (btn) switchMarketTab(btn.dataset.tab);
});
el.pluginSearchBtn.addEventListener("click", () => searchPlugins(el.pluginSearchInput.value));
el.pluginSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchPlugins(el.pluginSearchInput.value);
});

// 添加外部内置插件配置
async function addExternalPlugin() {
  const fullName = el.extFullName.value.trim();
  if (!fullName) {
    logLine("请填写 GitHub 仓库或 npm 包名", "err");
    return;
  }
  const source = el.extSource.value;
  el.extAddBtn.disabled = true;
  try {
    await invoke("add_external_plugin", { source, fullName });
    logLine(`已添加外部内置插件配置：${fullName}`, "ok");
    el.extFullName.value = "";
    loadMarket();
  } catch (e) {
    logLine(`添加外部内置插件失败：${e}`, "err");
  } finally {
    el.extAddBtn.disabled = false;
  }
}
el.extAddBtn.addEventListener("click", addExternalPlugin);
el.extFullName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addExternalPlugin();
});
el.btnCloseMarket.addEventListener("click", () => (el.modalMarket.hidden = true));
el.btnCloseMarket2.addEventListener("click", () => (el.modalMarket.hidden = true));
el.modalMarket.addEventListener("click", (e) => {
  if (e.target === el.modalMarket) el.modalMarket.hidden = true;
});
el.btnMarketRefresh.addEventListener("click", () => {
  if (marketTab === "local") {
    loadMarket();
  } else {
    searchPlugins(el.pluginSearchInput.value);
  }
});

// ---------- 技能广场面板 ----------
let skillsData = { my: null, plaza: null }; // 缓存 list_my_skills / list_skill_plaza 结果
let skillsTab = "my";
let plazaKeyword = ""; // 技能广场当前搜索词

function switchSkillsTab(tab) {
  skillsTab = tab;
  for (const btn of el.skillsTabs.querySelectorAll(".skills-tab")) {
    btn.dataset.active = btn.dataset.tab === tab ? "1" : "";
  }
  el.panelMy.dataset.active = tab === "my" ? "1" : "";
  el.panelPlazaSkills.dataset.active = tab === "plaza-skills" ? "1" : "";
  el.panelPlazaExperts.dataset.active = tab === "plaza-experts" ? "1" : "";
  if (tab === "my" && !skillsData.my) loadMy();
  if (tab !== "my" && !skillsData.plaza) loadPlaza(plazaKeyword);
}

function openSkills() {
  el.modalSkills.hidden = false;
  switchSkillsTab(skillsTab);
}

el.navSkills.addEventListener("click", openSkills);
el.btnCloseSkills.addEventListener("click", () => (el.modalSkills.hidden = true));
el.btnCloseSkills2.addEventListener("click", () => (el.modalSkills.hidden = true));
el.modalSkills.addEventListener("click", (e) => {
  if (e.target === el.modalSkills) el.modalSkills.hidden = true;
});
el.btnSkillsRefresh.addEventListener("click", () => {
  skillsData = { my: null, plaza: null };
  plazaKeyword = "";
  el.skillsSearchInput.value = "";
  switchSkillsTab(skillsTab);
});
el.skillsTabs.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".skills-tab");
  if (btn) switchSkillsTab(btn.dataset.tab);
});

// 技能广场搜索（skillhub.cn 服务端分词搜索 + 前端本地过滤兜底）
function doSearchPlaza() {
  plazaKeyword = el.skillsSearchInput.value.trim();
  skillsData.plaza = null;
  if (skillsTab !== "plaza-skills") switchSkillsTab("plaza-skills");
  else loadPlaza(plazaKeyword);
}
el.skillsSearchBtn.addEventListener("click", doSearchPlaza);
el.skillsSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearchPlaza();
});

async function loadMy() {
  el.mySkills.innerHTML = '<div class="skill-row dim">加载中…</div>';
  el.myExperts.innerHTML = '<div class="skill-row dim">加载中…</div>';
  try {
    skillsData.my = await invoke("list_my_skills");
  } catch (e) {
    el.mySkills.innerHTML = `<div class="skill-row dim">读取失败：${e}</div>`;
    return;
  }
  renderMy();
}

async function loadPlaza(keyword) {
  const kw = (keyword ?? "").trim();
  el.plazaSkills.innerHTML = '<div class="skill-row dim">加载中…</div>';
  el.plazaExperts.innerHTML = '<div class="skill-row dim">加载中…</div>';
  try {
    skillsData.plaza = await invoke("list_skill_plaza", { keyword: kw || null });
  } catch (e) {
    el.plazaSkills.innerHTML = `<div class="skill-row dim">读取失败：${e}</div>`;
    el.plazaExperts.innerHTML = "";
    return;
  }
  renderPlaza();
}

function skillRowContent(s) {
  const info = document.createElement("div");
  info.className = "skill-info";
  const name = document.createElement("div");
  name.className = "skill-name";
  name.textContent = s.display_name || s.name;
  const meta = document.createElement("div");
  meta.className = "skill-meta";
  meta.textContent = s.description || "（无描述）";
  info.appendChild(name);
  info.appendChild(meta);
  if (s.when_to_use) {
    const use = document.createElement("div");
    use.className = "skill-when";
    use.textContent = `适用：${s.when_to_use}`;
    info.appendChild(use);
  }
  return info;
}

function buildSkillRow(s, { removable, installable }) {
  const row = document.createElement("div");
  row.className = "skill-row";
  const info = skillRowContent(s);
  const badge = document.createElement("span");
  badge.className = "skill-badge" + (s.source === "user" ? " user" : "");
  badge.textContent = s.source === "hub" ? s.origin || "skillshub" : s.source === "bundled" ? s.origin || "随附" : "本地";
  info.appendChild(badge);
  row.appendChild(info);
  if (removable) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skill-btn danger";
    btn.textContent = "删除";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await invoke("remove_skill", { name: s.name });
        logLine(`已删除技能：${s.name}`, "ok");
        skillsData.my = null;
        loadMy();
      } catch (e) {
        logLine(`删除技能失败: ${e}`, "err");
      } finally {
        btn.disabled = false;
      }
    });
    row.appendChild(btn);
  }
  if (installable) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skill-btn" + (s.installed ? " disabled" : " primary");
    btn.textContent = s.installed ? "已安装" : "安装";
    btn.disabled = !!s.installed;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await invoke("install_skill", { name: s.name, url: s.url ?? null });
        logLine(`技能已安装：${s.name}`, "ok");
        skillsData = { my: null, plaza: null };
        switchSkillsTab(skillsTab);
      } catch (e) {
        logLine(`安装技能失败: ${e}`, "err");
        btn.disabled = false;
      }
    });
    row.appendChild(btn);
  }
  return row;
}

function buildExpertRow(e, { removable, installable }) {
  const row = document.createElement("div");
  row.className = "skill-row expert";
  const info = document.createElement("div");
  info.className = "skill-info";
  const name = document.createElement("div");
  name.className = "skill-name";
  name.textContent = e.name || e.id;
  const meta = document.createElement("div");
  meta.className = "skill-meta";
  meta.textContent = e.description || `专家（preset id: ${e.id}）`;
  info.appendChild(name);
  info.appendChild(meta);
  if (e.skills && e.skills.length) {
    const tags = document.createElement("div");
    tags.className = "skill-tags";
    for (const s of e.skills) {
      const tag = document.createElement("span");
      tag.className = "skill-tag";
      tag.textContent = s;
      tags.appendChild(tag);
    }
    info.appendChild(tags);
  }
  const badge = document.createElement("span");
  badge.className = "skill-badge" + (e.trust === "user" ? " user" : "");
  badge.textContent = e.trust === "user" ? "本地" : "skillshub";
  info.appendChild(badge);
  row.appendChild(info);
  if (removable) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skill-btn danger";
    btn.textContent = "删除";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await invoke("remove_expert", { id: e.id });
        logLine(`已删除专家：${e.name || e.id}`, "ok");
        skillsData.my = null;
        loadMy();
      } catch (err) {
        logLine(`删除专家失败: ${err}`, "err");
      } finally {
        btn.disabled = false;
      }
    });
    row.appendChild(btn);
  }
  if (installable) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skill-btn" + (e.installed ? " disabled" : " primary");
    btn.textContent = e.installed ? "已安装" : "安装";
    btn.disabled = !!e.installed;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await invoke("install_expert", { id: e.id, url: e.url ?? null });
        logLine(`专家已安装：${e.name || e.id}（重启服务后对新建会话生效）`, "ok");
        skillsData = { my: null, plaza: null };
        switchSkillsTab(skillsTab);
      } catch (err) {
        logLine(`安装专家失败: ${err}`, "err");
        btn.disabled = false;
      }
    });
    row.appendChild(btn);
  }
  return row;
}

function renderMy() {
  const { skills = [], experts = [] } = skillsData.my || {};
  el.mySkills.innerHTML = "";
  if (!skills.length) {
    el.mySkills.innerHTML = '<div class="skill-row dim">暂无本地技能，可到「技能广场」安装</div>';
  } else {
    for (const s of skills) el.mySkills.appendChild(buildSkillRow(s, { removable: true }));
  }
  el.myExperts.innerHTML = "";
  if (!experts.length) {
    el.myExperts.innerHTML = '<div class="skill-row dim">暂无本地专家，可到「专家广场」安装</div>';
  } else {
    for (const e of experts) el.myExperts.appendChild(buildExpertRow(e, { removable: true }));
  }
}

function renderPlaza() {
  const view = skillsData.plaza || {};
  if (view.error) {
    el.plazaSkills.innerHTML = `<div class="skill-row dim">${view.error}</div>`;
    el.plazaExperts.innerHTML = `<div class="skill-row dim">${view.error}</div>`;
    return;
  }
  const kw = plazaKeyword.trim().toLowerCase();
  let { skills = [], experts = [] } = view;
  // 本地过滤兜底：非 skillhub.cn 数据源（旧 index.json）时服务端不支持搜索
  if (kw) {
    skills = skills.filter((s) => {
      const hay = `${s.display_name || ""} ${s.name} ${s.description || ""}`.toLowerCase();
      return hay.includes(kw);
    });
  }
  el.plazaSkills.innerHTML = "";
  if (!skills.length) {
    el.plazaSkills.innerHTML = '<div class="skill-row dim">当前数据源暂未提供可安装技能</div>';
  } else {
    for (const s of skills) el.plazaSkills.appendChild(buildSkillRow(s, { installable: true }));
  }
  el.plazaExperts.innerHTML = "";
  if (!experts.length) {
    el.plazaExperts.innerHTML = '<div class="skill-row dim">当前数据源暂未提供可安装专家</div>';
  } else {
    for (const e of experts) el.plazaExperts.appendChild(buildExpertRow(e, { installable: true }));
  }
}

// ---------- 本地导入（zip / 文件夹） ----------

// 目录名清洗：去掉路径分隔符与冒号，避免注入
function sanitizeName(n) {
  const t = (n || "").trim();
  if (!t || t === "." || t === "..") return "";
  return t.replace(/[/\\:]/g, "_");
}

async function importSkillZip(file) {
  const name = sanitizeName((file.name || "").replace(/\.zip$/i, "")) || "imported-skill";
  try {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    await invoke("import_skill_zip", { name, bytes });
    logLine(`技能已导入：${name}（可在「我的技能」中查看）`, "ok");
    skillsData.my = null;
    loadMy();
  } catch (e) {
    logLine(`导入技能失败：${e}`, "err");
  }
}

async function importSkillDir(files) {
  const rootName = (files[0].webkitRelativePath || "").split("/")[0] || "";
  const name = sanitizeName(rootName) || "imported-skill";
  try {
    const items = [];
    for (const f of files) {
      const rel = (f.webkitRelativePath || "").split("/").slice(1).join("/");
      if (!rel) continue;
      const content = Array.from(new Uint8Array(await f.arrayBuffer()));
      items.push({ path: rel, content });
    }
    if (!items.length) throw new Error("所选文件夹为空");
    await invoke("import_skill_dir", { name, files: items });
    logLine(`技能文件夹已导入：${name}（可在「我的技能」中查看）`, "ok");
    skillsData.my = null;
    loadMy();
  } catch (e) {
    logLine(`导入技能失败：${e}`, "err");
  }
}

async function importPluginZip(file) {
  const name = sanitizeName((file.name || "").replace(/\.zip$/i, "")) || "imported-plugin";
  try {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    await invoke("import_plugin_zip", { name, bytes });
    logLine(`插件已导入：${name}（可在「本地插件」中启用，重启 dsh 服务后生效）`, "ok");
    loadMarket();
  } catch (e) {
    logLine(`导入插件失败：${e}`, "err");
  }
}

async function importPluginDir(files) {
  const rootName = (files[0].webkitRelativePath || "").split("/")[0] || "";
  const name = sanitizeName(rootName) || "imported-plugin";
  try {
    const items = [];
    for (const f of files) {
      const rel = (f.webkitRelativePath || "").split("/").slice(1).join("/");
      if (!rel) continue;
      const content = Array.from(new Uint8Array(await f.arrayBuffer()));
      items.push({ path: rel, content });
    }
    if (!items.length) throw new Error("所选文件夹为空");
    await invoke("import_plugin_dir", { name, files: items });
    logLine(`插件文件夹已导入：${name}（可在「本地插件」中启用）`, "ok");
    loadMarket();
  } catch (e) {
    logLine(`导入插件失败：${e}`, "err");
  }
}

el.skillsImportZip.addEventListener("click", () => el.skillsZipInput.click());
el.skillsZipInput.addEventListener("change", () => {
  const file = el.skillsZipInput.files?.[0];
  el.skillsZipInput.value = "";
  if (file) importSkillZip(file);
});
el.skillsImportDir.addEventListener("click", () => el.skillsDirInput.click());
el.skillsDirInput.addEventListener("change", () => {
  const files = Array.from(el.skillsDirInput.files || []);
  el.skillsDirInput.value = "";
  if (files.length) importSkillDir(files);
});

el.pluginImportZip.addEventListener("click", () => el.pluginZipInput.click());
el.pluginZipInput.addEventListener("change", () => {
  const file = el.pluginZipInput.files?.[0];
  el.pluginZipInput.value = "";
  if (file) importPluginZip(file);
});
el.pluginImportDir.addEventListener("click", () => el.pluginDirInput.click());
el.pluginDirInput.addEventListener("change", () => {
  const files = Array.from(el.pluginDirInput.files || []);
  el.pluginDirInput.value = "";
  if (files.length) importPluginDir(files);
});

function openSettings() {
  if (!settings) return;
  el.setRegistry.value = settings.registry ?? "";
  el.setPort.value = settings.port ?? 3080;
  el.setAutoStart.checked = settings.auto_start_after_deploy !== false;
  el.setStopOnExit.checked = settings.stop_on_exit !== false;
  el.setSkillshubUrl.value = settings.skillshub_url ?? "";
  el.setDataDir.value = status?.data_dir ?? "";
  el.modal.hidden = false;
}

el.btnSettings.addEventListener("click", openSettings);
el.btnSidebarSettings.addEventListener("click", openSettings);
el.btnCloseSettings.addEventListener("click", () => (el.modal.hidden = true));
el.modal.addEventListener("click", (e) => {
  if (e.target === el.modal) el.modal.hidden = true;
});

el.btnSaveSettings.addEventListener("click", async () => {
  if (busy) return;
  const next = {
    ...settings,
    registry: el.setRegistry.value.trim() || "https://registry.npmmirror.com",
    port: Math.min(65535, Math.max(1, Number(el.setPort.value) || 3080)),
    auto_start_after_deploy: el.setAutoStart.checked,
    stop_on_exit: el.setStopOnExit.checked,
    skillshub_url: el.setSkillshubUrl.value.trim() || "https://api.skillhub.cn/api/skills?sortBy=score&pageSize=100",
  };
  const portChanged = (settings?.port ?? 3080) !== next.port;
  const wasRunning = !!status?.service?.running;
  try {
    const oldSkillshubUrl = settings?.skillshub_url ?? "";
    await invoke("set_settings", { settings: next });
    settings = next;
    // skillshub 地址可能变更：清空技能广场缓存，下次打开时重新拉取
    if (next.skillshub_url !== oldSkillshubUrl) {
      skillsData = { my: null, plaza: null };
    }
    el.modal.hidden = true;
    logLine("设置已保存", "ok");
    if (portChanged && wasRunning) {
      // 端口已修改：先停止旧服务，再在新端口重启服务
      await runAction("stop_service", "端口已修改，正在停止旧服务…");
      await runAction("start_service", `端口已修改，正在新端口 ${next.port} 启动服务…`);
    } else {
      refresh();
    }
  } catch (e) {
    logLine(`保存设置失败: ${e}`, "err");
  }
});

// ---------- 更新检查与下载 ----------
let updatePending = null; // { url, name, path, tag }

function updateLogLine(text) {
  const line = document.createElement("div");
  line.textContent = text;
  el.updateLog.appendChild(line);
  el.updateLog.scrollTop = el.updateLog.scrollHeight;
}

function normTag(t) {
  return String(t ?? "").replace(/^v/i, "");
}

async function openUpdateModal() {
  updatePending = null;
  el.modalUpdate.hidden = false;
  el.updateProgress.hidden = true;
  el.btnUpdateAction.hidden = true;
  el.btnUpdateCancel.textContent = "关闭";
  el.updateLog.innerHTML = "";
  el.releaseList.hidden = true;
  el.releaseItems.innerHTML = "";
  el.updateText.textContent = "正在检查更新…";
  logLine("正在检查更新…", "dim");

  let info, releases;
  try {
    const [i, r] = await Promise.all([invoke("check_update"), invoke("list_releases")]);
    info = i;
    releases = r || [];
  } catch (e) {
    el.updateText.textContent = `检查更新失败：${e}`;
    el.updateLog.innerHTML = "";
    logLine(`检查更新失败：${e}`, "err");
    return;
  }
  if (info.error) {
    el.updateText.textContent = `检查更新失败：${info.error}`;
    logLine(`检查更新失败：${info.error}`, "err");
    return;
  }

  // 有可安装的版本才展示列表；否则 fallback 到旧的“仅提示最新”逻辑
  if (!releases.length) {
    if (info.has_update && info.asset_url && info.asset_name) {
      el.updateText.textContent = `发现新版本 ${info.latest}（当前 v${info.current}），是否下载并安装？`;
      updatePending = { url: info.asset_url, name: info.asset_name, path: null, tag: info.latest };
      el.btnUpdateAction.hidden = false;
      el.btnUpdateAction.textContent = "下载并安装";
    } else {
      el.updateText.textContent = `当前已是最新版本（v${info.current}）`;
    }
    return;
  }

  // 渲染版本列表，默认选中一个合适版本
  const currentTag = `v${info.current}`;

  function buildRow(rel) {
    const row = document.createElement("label");
    row.className = "release-item";
    row.dataset.tag = rel.tag;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "release-select";
    radio.value = rel.tag;
    const span = document.createElement("span");
    span.className = "release-name";
    span.textContent = rel.tag;
    const badge = document.createElement("span");
    badge.className = `release-badge${rel.is_current ? " current" : ""}`;
    badge.textContent = rel.is_current ? "当前版本" : rel.tag === normTag(info.latest) ? "最新版" : "";
    row.appendChild(radio);
    row.appendChild(span);
    row.appendChild(badge);
    radio.addEventListener("change", () => {
      updatePending = { url: rel.asset_url, name: rel.asset_name, path: null, tag: rel.tag };
      el.btnUpdateAction.hidden = false;
      el.btnUpdateAction.textContent = "下载并安装";
      el.updateText.textContent = `已选择 ${rel.tag}，点击下载并安装。`;
    });
    return row;
  }

  for (const rel of releases) {
    rel.is_current = normTag(rel.tag) === normTag(currentTag);
  }
  for (const rel of releases) {
    el.releaseItems.appendChild(buildRow(rel));
  }

  // 选中目标：有新版本则选最新，否则选当前版本（回退入口）
  const target =
    releases.find((x) => normTag(x.tag) === normTag(info.latest)) ||
    releases.find((x) => x.is_current) ||
    releases[0];
  if (target) {
    updatePending = { url: target.asset_url, name: target.asset_name, path: null, tag: target.tag };
    const radio = el.releaseItems.querySelector(`input[value="${CSS.escape(target.tag)}"]`);
    if (radio) radio.checked = true;
    el.btnUpdateAction.hidden = false;
    el.btnUpdateAction.textContent = "下载并安装";
    if (info.has_update) {
      el.updateText.textContent = `发现新版本 v${info.latest}（当前 v${info.current}），可更新到最新版或选择下方任一历史版本回退。`;
    } else {
      el.updateText.textContent = `当前已是最新版（v${info.current}），如需回退请选择下方历史版本。`;
    }
  }
  el.releaseList.hidden = false;
}

el.btnSidebarUpdate.addEventListener("click", openUpdateModal);
el.btnCloseUpdate.addEventListener("click", () => (el.modalUpdate.hidden = true));
el.btnUpdateCancel.addEventListener("click", () => (el.modalUpdate.hidden = true));
el.modalUpdate.addEventListener("click", (e) => {
  if (e.target === el.modalUpdate) el.modalUpdate.hidden = true;
});

el.btnUpdateAction.addEventListener("click", async () => {
  if (!updatePending) return;
  if (!updatePending.path) {
    // 下载安装包
    el.btnUpdateAction.hidden = true;
    el.btnUpdateCancel.textContent = "取消";
    el.updateProgress.hidden = false;
    el.updateText.textContent = `正在下载 ${updatePending.tag} 安装包…`;
    logLine(`开始下载：${updatePending.name}`, "dim");
    try {
      const path = await invoke("download_update", {
        assetUrl: updatePending.url,
        assetName: updatePending.name,
      });
      updatePending.path = path;
      el.updateText.textContent = "下载完成，是否立即运行安装程序？";
      logLine(`下载完成：${path}`, "ok");
      el.btnUpdateAction.hidden = false;
      el.btnUpdateAction.textContent = "运行安装程序";
    } catch (e) {
      el.updateProgress.hidden = true;
      el.updateText.textContent = `下载失败：${e}`;
      logLine(`下载失败：${e}`, "err");
      el.btnUpdateCancel.textContent = "关闭";
    }
  } else {
    // 运行安装程序
    try {
      await invoke("open_file", { path: updatePending.path });
      el.modalUpdate.hidden = true;
    } catch (e) {
      el.updateText.textContent = `无法启动安装程序：${e}`;
      logLine(`无法启动安装程序：${e}`, "err");
    }
  }
});

// ---------- 状态刷新 ----------
// get_status 内部要做进程探测 + HTTP 探测 + netstat，耗时可能接近轮询间隔，
// 必须防重入，避免多个刷新请求并发堆积。
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const s = await invoke("get_status");
    if (s.settings) settings = s.settings;
    renderStatus(s);
  } catch (e) {
    setPill("状态获取失败", "red");
    logLine(`get_status 失败: ${e}`, "err");
  } finally {
    refreshing = false;
  }
}

// ---------- 启动 ----------
// 每次启动后台静默检测一次更新（不弹窗）：发现新版本时在左下角「检查更新」按钮加红点并写一条日志
async function checkUpdateSilently() {
  let info;
  try {
    info = await invoke("check_update");
  } catch {
    return; // 网络异常等静默忽略，不打断启动
  }
  if (!info || info.error || !info.has_update || !info.latest) return;
  el.btnSidebarUpdate.classList.add("has-update");
  el.btnSidebarUpdate.title = `发现新版本 ${info.latest}（当前 v${info.current}），点击查看`;
  logLine(`发现新版本 ${info.latest}（当前 v${info.current}），可点击左下角「检查更新」下载安装`, "ok");
}

(async function init() {
  await setupEvents();
  await refresh();

  // 首次运行：默认启用全部内置插件（写入 dsh profile manifest），重启 dsh 服务后生效
  if (settings && !settings.plugins_initialized) {
    try {
      await invoke("ensure_builtin_plugins_default_enabled");
      const next = { ...settings, plugins_initialized: true };
      await invoke("set_settings", { settings: next });
      settings = next;
      logLine("已默认启用全部内置插件（重启 dsh 服务后生效）", "dim");
    } catch (e) {
      logLine(`默认启用内置插件失败：${e}`, "err");
    }
  }

  // 轮询状态；busy（启动/停止/部署等长任务）期间暂停，避免与任务争抢资源
  setInterval(() => {
    if (!busy) refresh();
  }, 2500);

  // 欢迎与当前状态日志，让控制台一开始就有内容
  logLine("========== DeepSeek Harness 桌面端 ==========", "step");
  if (status?.node?.ok) {
    logLine(`Node.js：${status.node.version}${status.node.managed ? "（内置便携版）" : "（系统安装）"}`, "dim");
  } else if (status?.node?.present) {
    logLine(`Node.js：${status.node.version}（版本不符，部署时将自动安装便携版）`, "dim");
  } else {
    logLine("Node.js：未检测到（部署时将自动安装便携版）", "dim");
  }
  logLine(
    `DeepSeek Harness 运行时：${
      status?.dsh?.ready
        ? `v${status.dsh.version ?? "?"}（已就绪）`
        : "未获取（点击「一键部署」自动获取）"
    }`,
    "dim"
  );
  if (status?.service?.running) {
    logLine(`服务运行中：${status.service.url}`, "ok");
    // 已部署并运行：中间面板直接显示 Harness 页面
    switchView("page");
  } else {
    logLine("服务未运行：可点击「一键启动」", "dim");
  }

  // 后台静默检测一次更新（不阻塞启动流程）
  checkUpdateSilently();
})();
