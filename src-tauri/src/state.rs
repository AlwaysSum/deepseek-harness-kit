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

/// 外部内置插件配置：用户指定的 GitHub 仓库 / npm 包，安装进 `plugins/` 后与
/// 内置插件一样被默认启用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalPluginCfg {
    /// 目录名（安装到 plugins/ 下的目录名，添加时由 full_name 推导）
    pub name: String,
    /// "github" | "npm"
    pub source: String,
    /// github: "owner/repo"；npm: 包全名（如 @dsh-kit/plugin-foo）
    pub full_name: String,
    /// 仅 github 有：默认分支（用于拼 zipball 下载地址）
    #[serde(default)]
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub registry: String,
    pub port: u16,
    pub auto_start_after_deploy: bool,
    pub stop_on_exit: bool,
    pub node_version: String,
    pub auto_install_node: bool,
    pub plugins_initialized: bool,
    pub skillshub_url: String,
    pub external_plugins: Vec<ExternalPluginCfg>,
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
            plugins_initialized: false,
            skillshub_url: DEFAULT_SKILLSHUB_URL.into(),
            external_plugins: Vec::new(),
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

/// dsh 用户目录（DSH_HOME），默认 ~/.dsh
pub fn dsh_home() -> PathBuf {
    if let Ok(h) = std::env::var("DSH_HOME") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        PathBuf::from(home).join(".dsh")
    } else if let Some(home) = std::env::var_os("HOME") {
        PathBuf::from(home).join(".dsh")
    } else {
        PathBuf::from(".dsh")
    }
}

/// dsh profile 目录（dsh --profile web），内置插件挂载在这里
pub fn dsh_profile_dir() -> PathBuf {
    dsh_home().join("profiles").join("web")
}

/// profile 的 package.json（dependencies + dsh.profile.bundles）
pub fn dsh_profile_manifest() -> PathBuf {
    dsh_profile_dir().join("package.json")
}

/// profile 的 node_modules/@dsh-kit 链接根目录
pub fn dsh_profile_kit_link_dir() -> PathBuf {
    dsh_profile_dir().join("node_modules").join("@dsh-kit")
}

/// 项目内置插件目录（打包后可改用 resources 目录）
pub fn builtin_plugins_dir() -> PathBuf {
    let exe = std::env::current_exe().ok();
    // 开发模式：从工作目录找 plugins/（仓库根即 cargo 运行目录，至少向上找两层）
    if let Ok(cwd) = std::env::current_dir() {
        for cand in [cwd.clone(), cwd.join(".."), cwd.join("..").join("..")] {
            let p = cand.join("plugins");
            if p.is_dir() {
                return p;
            }
        }
    }
    let _ = exe;
    PathBuf::from("plugins")
}

/// 部署成功标记（写入 dsh.installed 与 dsh.version）
pub fn dsh_marker() -> PathBuf {
    data_dir().join("dsh.installed")
}
pub fn dsh_version_file() -> PathBuf {
    data_dir().join("dsh.version")
}

// ---------- 设置读写 ----------

/// 技能广场默认数据源：skillhub.cn 官方 API（按热度取前 100）。
pub const DEFAULT_SKILLSHUB_URL: &str = "https://api.skillhub.cn/api/skills?sortBy=score&pageSize=100";
/// 已失效的旧版 skillshub 索引地址（GitHub 直连不可用），加载设置时自动迁移。
const LEGACY_SKILLSHUB_URL: &str = "https://raw.githubusercontent.com/AlwaysSum/skillshub/main/index.json";

pub fn load_settings() -> Settings {
    let p = settings_path();
    let mut s = if let Ok(text) = std::fs::read_to_string(&p) {
        if let Ok(parsed) = serde_json::from_str::<Settings>(&text) {
            parsed
        } else {
            Settings::default()
        }
    } else {
        Settings::default()
    };
    // 旧 skillshub 地址已失效：自动迁移到 skillhub.cn 数据源并回写
    if s.skillshub_url == LEGACY_SKILLSHUB_URL {
        s.skillshub_url = DEFAULT_SKILLSHUB_URL.into();
        let _ = save_settings(&s);
    }
    s
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

/// 解析 npx 缓存中 @deepseek-ai/dsh 的可执行入口（package.json 的 bin 指向的 JS 文件）。
/// 用于直接用托管 Node 运行 dsh，绕开 npx 的 .cmd 脚本——那类脚本会回退到 PATH
/// 里的系统 Node，版本过旧（如 v18 缺 parseEnv）会导致启动崩溃。
pub fn dsh_bin_js() -> Option<PathBuf> {
    let pkg = find_dsh_package_dir()?;
    let txt = std::fs::read_to_string(pkg.join("package.json")).ok()?;
    let j: serde_json::Value = serde_json::from_str(&txt).ok()?;
    let rel = match j.get("bin")? {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(m) => m.values().find_map(|v| v.as_str())?.to_string(),
        _ => return None,
    };
    let p = pkg.join(rel);
    p.is_file().then_some(p)
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
