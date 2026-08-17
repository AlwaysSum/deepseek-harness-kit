//! 内置插件管理：列出 / 启用 / 停用 dsh 内置插件。
//!
//! 每个内置插件是一个遵循 `@dsh-kit/*` 结构的包（`package.json` + `cordis.patch.yml`
//! + `lib/index.js`(host) + `lib/client.js`(browser)）。启用即把它 junction 链接进
//! dsh profile（`~/.dsh/profiles/web/node_modules/@dsh-kit/`），并在 profile 的
//! `package.json` 的 `dsh.profile.bundles` 里登记其 bundle；停用则撤销两者。
//! 服务重启后生效（与手写 install.mjs 同一机制）。
//!
//! 除随附插件外，还支持「外部内置插件」：用户在设置里配置的 GitHub 仓库 / npm 包，
//! 安装进 `plugins/` 后与内置插件一样可启停，并在首次运行时默认一并启用。

use crate::state::{
    builtin_plugins_dir, dsh_profile_dir, dsh_profile_kit_link_dir, dsh_profile_manifest,
    save_settings, AppState, ExternalPluginCfg,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::State;

/// 内置插件清单条目（返回给前端渲染开关）
#[derive(Serialize)]
pub struct BuiltinPluginInfo {
    pub name: String,
    pub package_name: String,
    pub description: String,
    pub has_host: bool,
    pub has_client: bool,
    pub enabled: bool,
}

/// 从 plugins 目录下的一级子目录读取一组内置插件（按名称排序）。
fn load_plugin_entries(root: &PathBuf) -> Result<Vec<(String, Value, PathBuf)>, String> {
    let mut entries = Vec::new();
    if !root.is_dir() {
        return Ok(entries);
    }
    let read = fs::read_dir(root).map_err(|e| format!("读取插件目录失败: {}", e))?;
    for item in read.flatten() {
        let dir = item.path();
        if !dir.is_dir() {
            continue;
        }
        let pkg_path = dir.join("package.json");
        if !pkg_path.is_file() {
            continue;
        }
        let txt = match fs::read_to_string(&pkg_path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let pkg: Value = match serde_json::from_str(&txt) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let pkg_name = pkg
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        if pkg_name.is_empty() {
            continue;
        }
        // 仅把声明了 `dsh` 段的包视为内置插件：`dsh.bundle.patch` 是 profile
        // bundle 的必需项（dsh 启动时强制校验），`dsh.client` 声明浏览器端注入。
        // plugins/ 下随附的 @deepseek-ai 上游工具包（如 dsh-skill-badge）没有
        // `dsh` 段，不是插件：不能把它登记进 dsh.profile.bundles，否则 dsh 启动
        // 会因 "declares no dsh.bundle in its package.json" 直接报错。
        if !pkg.get("dsh").map(|d| d.is_object()).unwrap_or(false) {
            continue;
        }
        entries.push((dirname_plugin_name(&dir), pkg, dir));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

fn dirname_plugin_name(dir: &PathBuf) -> String {
    dir.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 读取 profile manifest，返回 Value（object）。文件不存在或非法时返回空 object。
fn read_manifest(manifest: &PathBuf) -> Value {
    match fs::read_to_string(manifest) {
        Ok(txt) => serde_json::from_str(&txt).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

fn write_manifest(manifest: &PathBuf, doc: &Value) -> Result<(), String> {
    if let Some(p) = manifest.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    fs::write(manifest, pretty).map_err(|e| format!("写入 profile manifest 失败: {}", e))
}

fn bundles_in(doc: &Value) -> Vec<String> {
    doc.get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// dsh `web` profile 的核心模板 bundles，与 dsh 运行时
/// `PROFILE_TEMPLATES.web = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` 对齐。
/// `@deepseek-ai/dsh-web-app` 经由 `@deepseek-ai/dsh-host-webserver` 注册 `webServer`
/// 服务；缺失它，任何 `inject: ["webServer"]` 的插件（如 plugin-file-explorer）会永久
/// pending，导致 `dsh web` 启动报错 "1 entry did not activate"。
const WEB_PROFILE_TEMPLATE_BUNDLES: &[&str] = &[
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
];

/// 确保 `dsh.profile.bundles` 始终包含 web profile 核心模板 bundles：缺失的按模板顺序
/// 前置补齐，已存在的保持原位不动。核心 bundle 由 dsh 安装提供，不需要进 `dependencies`。
fn ensure_core_bundles(mut bundles: Vec<String>) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for core in WEB_PROFILE_TEMPLATE_BUNDLES {
        if !bundles.iter().any(|b| b == *core) {
            result.push((*core).to_string());
        }
    }
    result.append(&mut bundles);
    result
}

/// junction 创建链接（Windows）。回退为递归复制（非 Windows / 无权限时）。
fn link_plugin(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    let parent = dst
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    if dst.exists() {
        // 已存在的 junction / 目录需要先清理
        let meta = fs::symlink_metadata(dst).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            fs::remove_file(dst).map_err(|e| e.to_string())?;
        } else if meta.file_type().is_dir() {
            fs::remove_dir_all(dst).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(dst).map_err(|e| e.to_string())?;
        }
    }
    // 尝试先 junction（Windows 目录链接）
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(src, dst).is_ok() {
            return Ok(());
        }
    }
    // 回退：递归复制
    copy_dir(src, dst)
}

fn copy_dir(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    if !src.is_dir() {
        return Err("插件源目录不存在".into());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let s = entry.path();
        let d = dst.join(entry.file_name());
        if s.is_dir() {
            copy_dir(&s, &d)?;
        } else {
            fs::copy(&s, &d).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn unlink_plugin(dst: &PathBuf) -> Result<(), String> {
    if !dst.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(dst).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        fs::remove_file(dst).map_err(|e| e.to_string())?;
    } else if meta.file_type().is_dir() {
        fs::remove_dir_all(dst).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(dst).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 列出全部内置插件及其启用状态。
#[tauri::command]
pub async fn list_builtin_plugins() -> Result<Vec<BuiltinPluginInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_builtin_plugins_impl)
        .await
        .map_err(|e| format!("线程异常: {}", e))?
}

fn list_builtin_plugins_impl() -> Result<Vec<BuiltinPluginInfo>, String> {
    let root = builtin_plugins_dir();
    let manifest = dsh_profile_manifest();
    let doc = read_manifest(&manifest);
    let bundles: BTreeMap<String, ()> = bundles_in(&doc).into_iter().map(|b| (b, ())).collect();
    let mut out = Vec::new();
    let entries = load_plugin_entries(&root)?;
    for (_dir_name, pkg, _dir) in entries {
        let package_name = pkg
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        let description = pkg
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string();
        let dsh = pkg.get("dsh");
        let has_host = dsh
            .and_then(|d| d.get("bundle"))
            .map(|b| b.is_object())
            .unwrap_or(false);
        let has_client = dsh
            .and_then(|d| d.get("client"))
            .map(|c| !(c.is_null() && !c.is_object()))
            .unwrap_or(false);
        let enabled = bundles.contains_key(&package_name);
        out.push(BuiltinPluginInfo {
            name: package_name.clone(),
            package_name,
            description,
            has_host,
            has_client,
            enabled,
        });
    }
    Ok(out)
}

/// 启用或停用一个内置插件。重启 dsh 服务后生效。
#[tauri::command]
pub async fn set_builtin_plugin_enabled(name: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_builtin_plugin_enabled_impl(&name, enabled))
        .await
        .map_err(|e| format!("线程异常: {}", e))?
}

fn set_builtin_plugin_enabled_impl(name: &str, enabled: bool) -> Result<(), String> {
    let root = builtin_plugins_dir();
    let manifest = dsh_profile_manifest();
    let profile_dir = dsh_profile_dir();
    let link_dir = dsh_profile_kit_link_dir();

    // 在 plugins 目录里定位该包的源码目录
    let mut src_dir = None;
    for (_dir_name, pkg, dir) in load_plugin_entries(&root)? {
        if pkg.get("name").and_then(|n| n.as_str()) == Some(name) {
            src_dir = Some(dir);
            break;
        }
    }
    let src_dir = src_dir
        .ok_or_else(|| format!("未找到内置插件: {}", name))?;
    // 链接目标目录名取自包名的 @scope/name 的 name 段
    let link_name = name
        .split('/')
        .last()
        .ok_or_else(|| "非法插件名".to_string())?;
    let link_path = link_dir.join(link_name);

    if enabled {
        // 1) 链接源码目录
        if let Err(e) = link_plugin(&src_dir, &link_path) {
            return Err(format!("创建插件链接失败: {}", e));
        }
    } else {
        // 1) 删除链接
        if let Err(e) = unlink_plugin(&link_path) {
            return Err(format!("删除插件链接失败: {}", e));
        }
    }

    // 2) 更新 manifest：dependencies 与 dsh.profile.bundles
    let mut doc = read_manifest(&manifest);
    if !doc.is_object() {
        doc = json!({});
    }
    let deps = doc
        .get_mut("dependencies")
        .and_then(|d| d.as_object_mut());
    match deps {
        Some(map) => {
            if enabled {
                map.insert(name.to_string(), json!("0.1.0"));
            } else {
                map.remove(name);
            }
        }
        None => {
            if enabled {
                doc["dependencies"] = json!({ name.to_string(): "0.1.0" });
            }
        }
    }
    // dsh.profile.bundles
    let mut bundles = bundles_in(&doc);
    if enabled {
        if !bundles.iter().any(|b| b == name) {
            bundles.push(name.to_string());
        }
    } else {
        bundles.retain(|b| b != name);
    }
    // 始终补齐 web profile 核心模板 bundles（提供 webServer 等基础服务），
    // 否则当 manifest 不存在或仅含插件时，dsh 启动会因缺少 webServer 而失败。
    let bundles = ensure_core_bundles(bundles);
    doc["dsh"] = json!({
        "profile": {
            "bundles": bundles
        }
    });
    write_manifest(&manifest, &doc)?;
    let _ = profile_dir;
    Ok(())
}

/// 判断 profile 是否已登记过 @dsh-kit 插件 bundle（排除 web profile 核心模板）。
/// 供 setup 钩子识别「老版本打包空跑置位」场景：插件目录能读到但 profile 从未登记
/// 任何插件时，重置 plugins_initialized 让前端重新执行默认启用。
pub fn profile_has_plugin_bundles() -> bool {
    let manifest = dsh_profile_manifest();
    let doc = read_manifest(&manifest);
    bundles_in(&doc).iter().any(|b| {
        !WEB_PROFILE_TEMPLATE_BUNDLES.contains(&b.as_str()) && b.starts_with("@dsh-kit/")
    })
}

/// 首次启动时把全部内置插件默认启用（写入 profile manifest 并建立链接）。
///
/// 仅当 profile manifest 中尚未登记任何 `@dsh-kit/*` 插件 bundle 时执行——
/// 这意味着用户从未配置过插件（首次运行场景）；一旦用户启用/停用过任意插件，
/// 该函数即变为空操作，尊重用户的既有选择。重启 dsh 服务后生效。
/// 同时把已配置的「外部内置插件」一并安装并默认启用。
#[tauri::command]
pub async fn ensure_builtin_plugins_default_enabled(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let external = state
        .settings
        .lock()
        .map(|s| s.external_plugins.clone())
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_builtin_plugins_default_enabled_impl(&external)
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?
}

fn ensure_builtin_plugins_default_enabled_impl(
    external: &[ExternalPluginCfg],
) -> Result<(), String> {
    let root = builtin_plugins_dir();
    let manifest = dsh_profile_manifest();
    let doc = read_manifest(&manifest);
    let bundles: Vec<String> = bundles_in(&doc);

    // 仅当不存在任何 @dsh-kit/* 插件 bundle（排除 web profile 核心模板）时才视为首次运行
    let has_plugin_bundle = bundles.iter().any(|b| {
        !WEB_PROFILE_TEMPLATE_BUNDLES.contains(&b.as_str()) && b.starts_with("@dsh-kit/")
    });
    if has_plugin_bundle {
        return Ok(());
    }

    let entries = load_plugin_entries(&root)?;
    for (_dir_name, pkg, _dir) in entries {
        let name = pkg
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        // 已启用则跳过；否则启用（链接 + 写 manifest）
        if bundles.iter().any(|b| b == &name) {
            continue;
        }
        set_builtin_plugin_enabled_impl(&name, true)?;
    }

    // 外部内置插件：与内置插件一起默认安装并启用；单个失败不阻塞整体流程
    for cfg in external {
        if cfg.name.is_empty() || cfg.full_name.is_empty() {
            continue;
        }
        if let Err(e) = install_and_enable_external(cfg) {
            eprintln!("外部内置插件 {} 安装/启用失败: {}", cfg.full_name, e);
        }
    }
    Ok(())
}

// ---------- 外部内置插件 ----------

/// 外部内置插件条目（返回给前端渲染配置列表）。
#[derive(Serialize)]
pub struct ExternalPluginInfo {
    pub name: String,
    pub source: String,
    pub full_name: String,
    /// 已安装时从 package.json 读取的描述
    pub description: String,
    /// plugins/<name> 目录是否已存在（已下载）
    pub installed: bool,
    /// 是否已在 profile manifest 中启用
    pub enabled: bool,
}

fn external_plugin_info(cfg: &ExternalPluginCfg, bundles: &BTreeMap<String, ()>) -> ExternalPluginInfo {
    let dir = builtin_plugins_dir().join(&cfg.name);
    let mut package_name = String::new();
    let mut description = String::new();
    let pkg_path = dir.join("package.json");
    if pkg_path.is_file() {
        if let Ok(txt) = fs::read_to_string(&pkg_path) {
            if let Ok(pkg) = serde_json::from_str::<Value>(&txt) {
                package_name = pkg
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                description = pkg
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("")
                    .to_string();
            }
        }
    }
    ExternalPluginInfo {
        name: cfg.name.clone(),
        source: cfg.source.clone(),
        full_name: cfg.full_name.clone(),
        description,
        installed: pkg_path.is_file(),
        enabled: !package_name.is_empty() && bundles.contains_key(&package_name),
    }
}

/// 列出已配置的外部内置插件及其安装/启用状态。
#[tauri::command]
pub fn list_external_plugins(state: State<AppState>) -> Vec<ExternalPluginInfo> {
    let manifest = dsh_profile_manifest();
    let doc = read_manifest(&manifest);
    let bundles: BTreeMap<String, ()> = bundles_in(&doc).into_iter().map(|b| (b, ())).collect();
    let mut out: Vec<ExternalPluginInfo> = state
        .settings
        .lock()
        .map(|s| s.external_plugins.clone())
        .unwrap_or_default()
        .iter()
        .map(|cfg| external_plugin_info(cfg, &bundles))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 新增一个外部内置插件配置（source: "github" | "npm"；full_name: owner/repo 或 npm 包名）。
#[tauri::command]
pub fn add_external_plugin(
    state: State<AppState>,
    source: String,
    full_name: String,
) -> Result<(), String> {
    let full_name = full_name.trim().to_string();
    if full_name.is_empty() {
        return Err("请填写 GitHub 仓库或 npm 包名".into());
    }
    let source = if source == "npm" { "npm".to_string() } else { "github".to_string() };
    let name = if source == "npm" {
        crate::hub::npm_dir_name(&full_name)
    } else {
        crate::hub::github_dir_name(&full_name)
    };
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
    {
        return Err("插件地址不合法，无法推导目录名".into());
    }

    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    if settings.external_plugins.iter().any(|p| p.full_name == full_name) {
        return Err(format!("该插件已在配置中: {}", full_name));
    }
    settings.external_plugins.push(ExternalPluginCfg {
        name,
        source,
        full_name,
        default_branch: None,
    });
    save_settings(&settings).map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除一个外部内置插件配置（不删除已下载的插件目录，仅移除配置）。
#[tauri::command]
pub fn remove_external_plugin(state: State<AppState>, name: String) -> Result<(), String> {
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    let before = settings.external_plugins.len();
    settings.external_plugins.retain(|p| p.name != name);
    if settings.external_plugins.len() == before {
        return Err(format!("配置中未找到该插件: {}", name));
    }
    save_settings(&settings).map_err(|e| e.to_string())?;
    Ok(())
}

/// 安装并启用一个已配置的外部内置插件：下载到 plugins/ 目录后写入 manifest 并建立链接。
#[tauri::command]
pub async fn install_external_plugin(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let cfg = state
        .settings
        .lock()
        .map(|s| s.external_plugins.clone())
        .unwrap_or_default()
        .into_iter()
        .find(|p| p.name == name)
        .ok_or_else(|| format!("配置中未找到该插件: {}", name))?;
    tauri::async_runtime::spawn_blocking(move || install_and_enable_external(&cfg))
        .await
        .map_err(|e| format!("线程异常: {}", e))?
}

/// 下载外部插件到 plugins/（如未安装）并默认启用。
fn install_and_enable_external(cfg: &ExternalPluginCfg) -> Result<(), String> {
    let dir = builtin_plugins_dir().join(&cfg.name);
    if !dir.join("package.json").is_file() {
        crate::hub::install_plugin_to(&cfg.source, &cfg.full_name, cfg.default_branch.as_deref())?;
    }
    let txt = fs::read_to_string(dir.join("package.json"))
        .map_err(|e| format!("安装后缺少 package.json: {}", e))?;
    let pkg: Value = serde_json::from_str(&txt).map_err(|e| format!("解析 package.json 失败: {}", e))?;
    let package_name = pkg
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    if package_name.is_empty() {
        return Err("插件缺少 name 字段（@dsh-kit/* 结构）".into());
    }
    // 已启用则跳过
    let manifest = dsh_profile_manifest();
    let doc = read_manifest(&manifest);
    if bundles_in(&doc).iter().any(|b| b == &package_name) {
        return Ok(());
    }
    set_builtin_plugin_enabled_impl(&package_name, true)
}

// ---------- 本地导入（zip / 文件夹） ----------

/// 导入目录名安全校验：仅允许普通目录名。
fn safe_plugin_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
}

/// 相对路径安全校验：仅允许普通相对路径，拒绝 `..`、绝对路径、盘符等。
fn safe_relative_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if p.is_absolute() || p.as_os_str().is_empty() {
        return Err(format!("非法文件路径: {}", path));
    }
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::Normal(s) => out.push(s),
            _ => return Err(format!("非法文件路径: {}", path)),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("非法文件路径: {}", path));
    }
    Ok(out)
}

/// 导入插件 zip 后校验 package.json 存在。
fn ensure_plugin_package(root: &PathBuf) -> Result<String, String> {
    let pkg_path = root.join("package.json");
    if !pkg_path.is_file() {
        return Err("导入内容缺少 package.json（不是有效的 @dsh-kit 插件）".into());
    }
    let txt = fs::read_to_string(&pkg_path).map_err(|e| format!("读取 package.json 失败: {}", e))?;
    let pkg: Value = serde_json::from_str(&txt).map_err(|e| format!("解析 package.json 失败: {}", e))?;
    pkg.get("name")
        .and_then(|n| n.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "插件缺少 name 字段（@dsh-kit/* 结构）".into())
}

/// 导入一个插件 zip（前端上传字节）到 `plugins/<name>/`，不自动启用。
#[tauri::command]
pub async fn import_plugin_zip(name: String, bytes: Vec<u8>) -> Result<(), String> {
    if !safe_plugin_name(&name) {
        return Err("非法的插件名称".into());
    }
    if bytes.is_empty() {
        return Err("导入内容为空".into());
    }
    let dst = builtin_plugins_dir().join(&name);
    if dst.exists() {
        return Err(format!("插件已存在: {}", name));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let tmp = std::env::temp_dir().join(format!("dsh-import-plugin-{}.zip", name));
        std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        let result = std::fs::create_dir_all(&dst)
            .map_err(|e| e.to_string())
            .and_then(|_| crate::hub::extract_zip_strip_root(&tmp, &dst))
            .and_then(|_| ensure_plugin_package(&dst).map(|_| ()));
        let _ = std::fs::remove_file(&tmp);
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&dst);
        }
        result
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?
}

/// 导入一个插件文件夹（前端遍历文件后回传）到 `plugins/<name>/`，不自动启用。
#[tauri::command]
pub async fn import_plugin_dir(name: String, files: Vec<crate::skills::ImportedFile>) -> Result<(), String> {
    if !safe_plugin_name(&name) {
        return Err("非法的插件名称".into());
    }
    if files.is_empty() {
        return Err("未选择任何文件".into());
    }
    let dst = builtin_plugins_dir().join(&name);
    if dst.exists() {
        return Err(format!("插件已存在: {}", name));
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
        for f in files {
            let rel = safe_relative_path(&f.path)?;
            let full = dst.join(&rel);
            if let Some(p) = full.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            std::fs::write(&full, &f.content).map_err(|e| format!("写入 {} 失败: {}", f.path, e))?;
        }
        ensure_plugin_package(&dst).map(|_| ())
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?
}
