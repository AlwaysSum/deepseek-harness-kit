import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  navConsole: $("nav-console"),
  navHarness: $("nav-harness"),
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
  btnCloseUpdate: $("btn-close-update"),
  btnUpdateCancel: $("btn-update-cancel"),
  btnUpdateAction: $("btn-update-action"),
  sidebarFooter: $("sidebar-footer"),
  log: $("log"),
  viewControl: $("view-control"),
  viewPage: $("view-page"),
  frame: $("harness-frame"),
  pageUrl: $("page-url"),
  pageDot: $("page-dot"),
  pageOverlay: $("page-overlay"),
  btnRefresh: $("btn-refresh"),
  btnOpenBrowser: $("btn-open-browser"),
  btnBack: $("btn-back"),
  btnOverlayBack: $("btn-overlay-back"),
  modal: $("modal-settings"),
  btnCloseSettings: $("btn-close-settings"),
  btnSaveSettings: $("btn-save-settings"),
  setRegistry: $("set-registry"),
  setPort: $("set-port"),
  setAutoStart: $("set-auto-start"),
  setStopOnExit: $("set-stop-on-exit"),
  setDataDir: $("set-data-dir"),
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
    const url = `http://127.0.0.1:${port}/`;
    el.pageUrl.textContent = url;
    el.frame.src = url;
    refreshPageOverlay();
  }
}

function refreshPageOverlay() {
  const running = !!status?.service?.running;
  el.pageOverlay.hidden = running;
  el.pageDot.classList.toggle("off", !running);
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

el.btnBack.addEventListener("click", () => switchView("control"));
el.btnOverlayBack.addEventListener("click", () => switchView("control"));

el.btnRefresh.addEventListener("click", () => {
  const port = settings?.port ?? 3080;
  el.frame.src = `http://127.0.0.1:${port}/`;
});

el.btnOpenBrowser.addEventListener("click", () => {
  const port = settings?.port ?? 3080;
  invoke("open_browser", { url: `http://127.0.0.1:${port}/` }).catch((e) => logLine(`打开浏览器失败: ${e}`, "err"));
});

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
function openSettings() {
  if (!settings) return;
  el.setRegistry.value = settings.registry ?? "";
  el.setPort.value = settings.port ?? 3080;
  el.setAutoStart.checked = settings.auto_start_after_deploy !== false;
  el.setStopOnExit.checked = settings.stop_on_exit !== false;
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
  const next = {
    ...settings,
    registry: el.setRegistry.value.trim() || "https://registry.npmmirror.com",
    port: Math.min(65535, Math.max(1, Number(el.setPort.value) || 3080)),
    auto_start_after_deploy: el.setAutoStart.checked,
    stop_on_exit: el.setStopOnExit.checked,
  };
  try {
    await invoke("set_settings", { settings: next });
    settings = next;
    el.modal.hidden = true;
    logLine("设置已保存", "ok");
    refresh();
  } catch (e) {
    logLine(`保存设置失败: ${e}`, "err");
  }
});

// ---------- 更新检查与下载 ----------
let updatePending = null; // { url, name, path }

function updateLogLine(text) {
  const line = document.createElement("div");
  line.textContent = text;
  el.updateLog.appendChild(line);
  el.updateLog.scrollTop = el.updateLog.scrollHeight;
}

async function openUpdateModal() {
  updatePending = null;
  el.modalUpdate.hidden = false;
  el.updateProgress.hidden = true;
  el.btnUpdateAction.hidden = true;
  el.btnUpdateCancel.textContent = "关闭";
  el.updateLog.innerHTML = "";
  el.updateText.textContent = "正在检查更新…";
  logLine("正在检查更新…", "dim");
  let info;
  try {
    info = await invoke("check_update");
  } catch (e) {
    el.updateText.textContent = `检查更新失败：${e}`;
    logLine(`检查更新失败：${e}`, "err");
    return;
  }
  if (info.error) {
    el.updateText.textContent = `检查更新失败：${info.error}`;
    logLine(`检查更新失败：${info.error}`, "err");
    return;
  }
  if (info.has_update && info.asset_url && info.asset_name) {
    el.updateText.textContent = `发现新版本 ${info.latest}（当前 ${info.current}），是否下载并安装？`;
    logLine(`发现新版本 ${info.latest}（当前 ${info.current}）`, "ok");
    updatePending = { url: info.asset_url, name: info.asset_name, path: null };
    el.btnUpdateAction.hidden = false;
    el.btnUpdateAction.textContent = "下载并安装";
  } else {
    el.updateText.textContent = `当前已是最新版本（v${info.current}）`;
    logLine(`当前已是最新版本（v${info.current}）`, "ok");
  }
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
    el.updateText.textContent = "正在下载安装包…";
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
async function refresh() {
  try {
    const s = await invoke("get_status");
    if (s.settings) settings = s.settings;
    renderStatus(s);
  } catch (e) {
    setPill("状态获取失败", "red");
    logLine(`get_status 失败: ${e}`, "err");
  }
}

// ---------- 启动 ----------
(async function init() {
  await setupEvents();
  await refresh();
  setInterval(refresh, 2500);

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
})();
