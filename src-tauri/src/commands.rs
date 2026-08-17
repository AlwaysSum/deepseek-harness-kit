//! Tauri 命令层。

use crate::process::no_window;
use crate::service::{find_pid_on_port, probe_http, service_url};
use crate::state::{
    data_dir, dsh_installed, dsh_version, node_version_ok, AppState, Settings,
    DEFAULT_REGISTRY, NODE_VERSION,
};
use std::sync::atomic::Ordering;
use tauri::State;

#[derive(serde::Serialize)]
pub struct NodeInfo {
    pub present: bool,
    pub version: Option<String>,
    pub ok: bool,
    pub managed: bool,
}

#[derive(serde::Serialize)]
pub struct DshInfo {
    pub ready: bool,
    pub version: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ServiceInfo {
    pub running: bool,
    pub url: String,
    pub pid: Option<u32>,
}

#[derive(serde::Serialize)]
pub struct Status {
    pub node: NodeInfo,
    pub dsh: DshInfo,
    pub service: ServiceInfo,
    pub lan_addresses: Vec<String>,
    pub lan_enabled: bool,
    pub data_dir: String,
    pub settings: Settings,
    pub busy: bool,
    pub version: String,
}

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<Status, String> {
    let st = state.inner().clone();
    let s = tauri::async_runtime::spawn_blocking(move || build_status(&st))
        .await
        .map_err(|e| format!("状态线程异常: {}", e))?;
    Ok(s)
}

/// 注意：所有进程 spawn / HTTP 探测 / netstat 都是阻塞 I/O，
/// 必须在 spawn_blocking 线程执行，否则会卡住 Tauri 主线程导致 UI 无响应。
fn build_status(state: &AppState) -> Status {
    let settings = state.settings.lock().unwrap().clone();
    let port = settings.port;

    // --- Node ---
    let mut node = match crate::process::run_capture("node", &["--version"], None, None) {
        Ok(v) => NodeInfo {
            present: true,
            version: Some(v.clone()),
            ok: node_version_ok(&v),
            managed: false,
        },
        Err(_) => NodeInfo {
            present: false,
            version: None,
            ok: false,
            managed: false,
        },
    };
    if !node.ok {
        let managed_exe = crate::deploy::node_managed_exe(&settings.node_version);
        if managed_exe.exists() {
            if let Ok(v) =
                crate::process::run_capture(managed_exe.to_str().unwrap(), &["--version"], None, None)
            {
                node = NodeInfo {
                    present: true,
                    version: Some(v),
                    ok: true,
                    managed: true,
                };
            }
        }
    }

    // --- dsh 运行时（npx） ---
    let dsh = DshInfo {
        ready: dsh_installed(),
        version: dsh_version(),
    };

    // --- 服务 ---
    let running = probe_http(port);
    let pid = state.service.lock().unwrap().as_ref().map(|h| h.pid);
    let service = ServiceInfo {
        running,
        url: service_url(port),
        pid: if running {
            pid.or_else(|| find_pid_on_port(port))
        } else {
            None
        },
    };

    Status {
        node,
        dsh,
        service,
        lan_addresses: crate::net::lan_ipv4_addresses(),
        lan_enabled: crate::net::webserver_patch_enabled(),
        data_dir: data_dir().display().to_string(),
        settings,
        busy: state.busy.load(Ordering::SeqCst),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
pub async fn deploy(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<(), String> {
    let st = state.inner().clone();
    let busy = st.busy.clone();
    if busy.swap(true, Ordering::SeqCst) {
        return Err("已有任务正在进行中，请稍候。".into());
    }
    let settings = st.settings.lock().unwrap().clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        crate::deploy::deploy_impl(&app, &st, &settings, force.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("部署线程异常: {}", e))?;
    busy.store(false, Ordering::SeqCst);
    res
}

#[tauri::command]
pub async fn start_service(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let st = state.inner().clone();
    let busy = st.busy.clone();
    if busy.swap(true, Ordering::SeqCst) {
        return Err("已有任务正在进行中，请稍候。".into());
    }
    let settings = st.settings.lock().unwrap().clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        crate::service::start_impl(&app, &st, &settings)
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?;
    busy.store(false, Ordering::SeqCst);
    res
}

#[tauri::command]
pub async fn stop_service(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let st = state.inner().clone();
    let busy = st.busy.clone();
    if busy.swap(true, Ordering::SeqCst) {
        return Err("已有任务正在进行中，请稍候。".into());
    }
    let settings = st.settings.lock().unwrap().clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        crate::service::stop_impl(&app, &st, &settings)
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?;
    busy.store(false, Ordering::SeqCst);
    res
}

#[tauri::command]
pub async fn open_browser(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", "start", "", &url]);
            no_window(&mut cmd);
            cmd.status().map_err(|e| format!("打开浏览器失败: {}", e))?;
            Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            let mut cmd = std::process::Command::new("open");
            cmd.arg(&url);
            cmd.status().map_err(|e| format!("打开浏览器失败: {}", e))?;
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            let mut cmd = std::process::Command::new("xdg-open");
            cmd.arg(&url);
            cmd.status().map_err(|e| format!("打开浏览器失败: {}", e))?;
            Ok(())
        }
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

/// 当前 dsh UI 主题（"light" / "dark"）：跟随 `~/.dsh/settings.yaml` 的
/// `ui-theme.preference`，为 `system` 时按 Windows 应用主题模式解析。
#[tauri::command]
pub fn get_ui_theme() -> String {
    crate::state::dsh_ui_theme()
}

#[tauri::command]
pub fn set_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    let mut s = settings;
    if s.registry.trim().is_empty() {
        s.registry = DEFAULT_REGISTRY.into();
    }
    if !s.registry.starts_with("http://") && !s.registry.starts_with("https://") {
        return Err("镜像源必须是 http(s) 地址。".into());
    }
    s.port = s.port.clamp(1, 65535);
    if s.node_version.trim().is_empty() {
        s.node_version = NODE_VERSION.into();
    }
    // 局域网访问开关变化时，写入/移除 profile 中 webserver host=0.0.0.0 覆盖。
    crate::net::set_webserver_patch(s.allow_lan, s.port)?;
    crate::state::save_settings(&s)?;
    *state.settings.lock().unwrap() = s;
    Ok(())
}

/// 返回本机当前可访问的局域网 IPv4 地址列表（扫码 URL 使用主地址）。
#[tauri::command]
pub fn get_lan_addresses() -> Vec<String> {
    crate::net::lan_ipv4_addresses()
}

/// 检查 GitHub Releases 是否有新版本
#[tauri::command]
pub async fn check_update() -> Result<crate::update::UpdateInfo, String> {
    let s = tauri::async_runtime::spawn_blocking(crate::update::check_update)
        .await
        .map_err(|e| format!("检查更新线程异常: {}", e))?;
    Ok(s)
}

/// 列出全部历史版本（用于更新到最新或回退到任意历史版本）
#[tauri::command]
pub async fn list_releases() -> Result<Vec<crate::update::Release>, String> {
    tauri::async_runtime::spawn_blocking(crate::update::list_releases)
        .await
        .map_err(|e| format!("线程异常: {}", e))?
}

/// 下载更新安装包（长任务，推送 update:download 进度）
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    asset_url: String,
    asset_name: String,
) -> Result<String, String> {
    let st = state.inner().clone();
    let busy = st.busy.clone();
    if busy.swap(true, Ordering::SeqCst) {
        return Err("已有任务正在进行中，请稍候。".into());
    }
    let res = tauri::async_runtime::spawn_blocking(move || {
        crate::update::download_update(&app, &asset_url, &asset_name)
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?;
    busy.store(false, Ordering::SeqCst);
    res
}

/// 打开文件（运行安装程序等）
#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new(&path);
        no_window(&mut cmd);
        cmd.spawn()
            .map_err(|e| format!("无法启动 {}: {}", path, e))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(())
    }
}
