//! 应用状态、设置、路径常量。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

pub const APP_DIR_NAME: &str = "DSHDesktop";
/// 通过 npx 直接运行官方发布的 DeepSeek Harness CLI（无需克隆源码/构建）
pub const DSH_PACKAGE: &str = "@deepseek-ai/dsh";
/// 满足 dsh 运行时要求（^22.19.0 || >=24.0.0）的便携版 Node
pub const NODE_VERSION: &str = "v22.20.0";
pub const DEFAULT_REGISTRY: &str = "https://registry.npmmirror.com";
pub const BINARY_MIRROR: &str = "https://registry.npmmirror.com/-/binary";
pub const OFFICIAL_NODE_DIST: &str = "https://nodejs.org/dist";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub registry: String,
    pub port: u16,
    pub auto_start_after_deploy: bool,
    pub stop_on_exit: bool,
    pub node_version: String,
    pub auto_install_node: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            registry: DEFAULT_REGISTRY.into(),
            port: 3080,
            auto_start_after_deploy: true,
            stop_on_exit: true,
            node_version: NODE_VERSION.into(),
            auto_install_node: true,
        }
    }
}

pub struct ServiceHandle {
    pub pid: u32,
}

#[derive(Clone, Default)]
pub struct AppState {
    pub settings: Arc<Mutex<Settings>>,
    pub service: Arc<Mutex<Option<ServiceHandle>>>,
    pub busy: Arc<AtomicBool>,
}

// ---------- 路径 ----------

pub fn data_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("LOCALAPPDATA") {
        PathBuf::from(p).join(APP_DIR_NAME)
    } else if let Some(h) = std::env::var_os("HOME") {
        PathBuf::from(h).join(".dsh-desktop")
    } else {
        PathBuf::from(".").join(".dsh-desktop")
    }
}

pub fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}
pub fn node_home() -> PathBuf {
    data_dir().join("node")
}
pub fn dl_dir() -> PathBuf {
    data_dir().join("downloads")
}

/// 部署成功标记（写入 dsh.installed 与 dsh.version）
pub fn dsh_marker() -> PathBuf {
    data_dir().join("dsh.installed")
}
pub fn dsh_version_file() -> PathBuf {
    data_dir().join("dsh.version")
}

// ---------- 设置读写 ----------

pub fn load_settings() -> Settings {
    let p = settings_path();
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(s) = serde_json::from_str::<Settings>(&s) {
            return s;
        }
    }
    Settings::default()
}

pub fn save_settings(s: &Settings) -> Result<(), String> {
    let p = settings_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| e.to_string())
}

// ---------- 版本判断 ----------

/// dsh 运行时要求：node ^22.19.0 || >=24.0.0（23 系列不支持）
pub fn node_version_ok(v: &str) -> bool {
    let t = v.trim().trim_start_matches('v');
    let mut parts = t.split('.');
    let major: i32 = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let minor: i32 = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    (major == 22 && minor >= 19) || major >= 24
}

// ---------- npx 缓存与 dsh 运行时检测 ----------

/// npm 默认缓存目录（Windows 为 %LOCALAPPDATA%\npm-cache）
pub fn npm_cache_dir() -> Option<PathBuf> {
    if let Ok(c) = std::env::var("npm_config_cache") {
        if !c.is_empty() {
            return Some(PathBuf::from(c));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return Some(PathBuf::from(local).join("npm-cache"));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        return Some(PathBuf::from(home).join(".npm"));
    }
    None
}

/// 在 npx 缓存中查找已安装的 @deepseek-ai/dsh 包目录
pub fn find_dsh_package_dir() -> Option<PathBuf> {
    let cache = npm_cache_dir()?.join("_npx");
    let entries = std::fs::read_dir(&cache).ok()?;
    for entry in entries.flatten() {
        let pkg = entry
            .path()
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh");
        if pkg.join("package.json").exists() {
            return Some(pkg);
        }
    }
    None
}

pub fn dsh_installed() -> bool {
    dsh_marker().exists() || find_dsh_package_dir().is_some()
}

pub fn dsh_version() -> Option<String> {
    if let Some(pkg) = find_dsh_package_dir() {
        if let Ok(txt) = std::fs::read_to_string(pkg.join("package.json")) {
            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&txt) {
                if let Some(v) = j.get("version").and_then(|x| x.as_str()) {
                    return Some(v.to_string());
                }
            }
        }
    }
    std::fs::read_to_string(dsh_version_file())
        .ok()
        .map(|s| s.trim().to_string())
}

/// 标记部署成功
pub fn write_dsh_marker(version: &str) -> Result<(), String> {
    if let Some(dir) = dsh_marker().parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(dsh_marker(), "1").map_err(|e| e.to_string())?;
    std::fs::write(dsh_version_file(), version).map_err(|e| e.to_string())
}
