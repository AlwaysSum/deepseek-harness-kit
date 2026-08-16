//! 远程市场：插件市场搜索/安装（GitHub -> npm 兜底）与技能广场索引拉取。
//!
//! - `search_remote_plugins(query)`：先查 GitHub 仓库（dsh 相关），网络不通/限流时回退 npm registry。
//! - `install_remote_plugin(source, full_name, default_branch)`：GitHub 走 zipball，npm 走 tarball(.tgz)，
//!   解压到项目 `plugins/` 目录后即可在「本地插件」中启用。
//! - `fetch_skillshub(url)`：拉取技能广场数据源，列出可安装的技能/专家及其下载链接。
//!   支持两种格式：skillhub.cn 官方 API（`https://api.skillhub.cn/api/skills`）与旧版
//!   skillshub index.json（`{skills, experts}`）。

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::process::apply_proxy;
use crate::state::builtin_plugins_dir;

// ---------- 公共数据结构 ----------

/// 远程插件条目（插件市场搜索结果）。
#[derive(Serialize, Clone, Default)]
pub struct RemotePlugin {
    /// 目录名（安装时落到 plugins/ 下的目录名）
    pub name: String,
    /// github: "owner/repo"；npm: 包全名（如 @dsh-kit/plugin-foo）
    pub full_name: String,
    pub description: String,
    /// html_url（github）或 npm 链接
    pub url: String,
    /// "github" | "npm"
    pub source: String,
    pub stars: u64,
    /// 仅 github 有：默认分支（用于拼 zipball）
    pub default_branch: Option<String>,
    /// 是否已安装到本地 plugins/
    pub installed: bool,
}

/// 技能广场索引中的单个技能。
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct HubSkill {
    /// 技能目录名（skillhub.cn 用 slug，旧 skillshub 用自带 name）
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub when_to_use: Option<String>,
    /// 技能内容压缩包下载地址（zip）
    #[serde(default)]
    pub url: Option<String>,
    /// skillhub.cn 的 slug（用于拼下载地址）；旧 skillshub 格式为 None
    #[serde(default)]
    pub slug: Option<String>,
    /// skillhub.cn 的中文展示名；旧格式为 None
    #[serde(default)]
    pub display_name: Option<String>,
}

/// skillshub index.json 中的单个专家（preset）。
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct HubExpert {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub skills: Vec<String>,
    /// 专家内容压缩包下载地址（zip）
    #[serde(default)]
    pub url: Option<String>,
}

/// 技能广场索引结构。
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SkillshubIndex {
    #[serde(default)]
    pub skills: Vec<HubSkill>,
    #[serde(default)]
    pub experts: Vec<HubExpert>,
    /// 数据源标签（"skillhub.cn" / "skillshub"），解析时填充
    #[serde(default)]
    pub origin: String,
}

// ---------- HTTP agent ----------

fn agent() -> ureq::Agent {
    apply_proxy(
        ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(20))
            .timeout_connect(Duration::from_secs(15))
            .user_agent("dsh-desktop-market/1.0"),
    )
    .build()
}

fn agent_long() -> ureq::Agent {
    apply_proxy(
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(30))
            .timeout_read(Duration::from_secs(180))
            .user_agent("dsh-desktop-market/1.0"),
    )
    .build()
}

fn fetch_json(url: &str) -> Result<serde_json::Value, String> {
    let resp = agent()
        .get(url)
        .call()
        .map_err(|e| format!("请求失败 {}: {}", url, e))?;
    serde_json::from_reader(resp.into_reader())
        .map_err(|e| format!("解析 JSON 失败 {}: {}", url, e))
}

/// 下载 url 到本地文件（返回写入字节数）。
fn download_file(url: &str, dest: &Path) -> Result<u64, String> {
    if let Some(d) = dest.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let resp = agent_long()
        .get(url)
        .call()
        .map_err(|e| format!("下载失败 {}: {}", url, e))?;
    let mut reader = resp.into_reader();
    let mut file = File::create(dest).map_err(|e| format!("无法创建文件 {}: {}", dest.display(), e))?;
    let mut buf = vec![0u8; 128 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("下载中断: {}", e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        total += n as u64;
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(total)
}

// ---------- 本地已安装判断 ----------

/// 列出本地 plugins/ 目录下已存在的插件目录名。
fn installed_plugin_names() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    if let Ok(read) = std::fs::read_dir(builtin_plugins_dir()) {
        for entry in read.flatten() {
            if entry.path().is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    set.insert(name.to_string());
                }
            }
        }
    }
    set
}

/// 取 npm 包名对应的目录名（去掉 @scope/ 前缀）。
pub fn npm_dir_name(pkg: &str) -> String {
    pkg.trim_start_matches('@')
        .split_once('/')
        .map(|(_, n)| n.to_string())
        .unwrap_or_else(|| pkg.trim_start_matches('@').to_string())
}

/// 取 GitHub owner/repo 的 repo 名作为目录名。
pub fn github_dir_name(full_name: &str) -> String {
    full_name
        .rsplit('/')
        .next()
        .unwrap_or(full_name)
        .trim_end_matches(".git")
        .to_string()
}

// ---------- 搜索 ----------

/// 插件市场搜索：GitHub -> npm 兜底。
#[tauri::command]
pub async fn search_remote_plugins(query: String) -> Result<Vec<RemotePlugin>, String> {
    tauri::async_runtime::spawn_blocking(move || search_remote_plugins_impl(query))
        .await
        .map_err(|e| format!("线程异常: {}", e))?
}

fn search_remote_plugins_impl(query: String) -> Result<Vec<RemotePlugin>, String> {
    let q = query.trim();
    let installed = installed_plugin_names();
    let mut out = Vec::new();

    match search_github(q, &installed) {
        Ok(items) => {
            out.extend(items);
        }
        Err(e) => {
            // GitHub 不通（网络/限流）：回退 npm
            match search_npm(q, &installed) {
                Ok(items) => out.extend(items),
                Err(npm_err) => {
                    return Err(format!(
                        "GitHub 不可用（{}），npm 也失败：{}",
                        e, npm_err
                    ));
                }
            }
        }
    }

    // 去重（按 name）
    out.sort_by(|a, b| b.stars.cmp(&a.stars).then(a.name.cmp(&b.name)));
    out.dedup_by(|a, b| a.name == b.name);
    Ok(out)
}

fn search_github(q: &str, installed: &std::collections::HashSet<String>) -> Result<Vec<RemotePlugin>, String> {
    let ghq = if q.is_empty() {
        "dsh-kit".to_string()
    } else {
        format!("{} dsh", q)
    };
    let url = format!(
        "https://api.github.com/search/repositories?q={}&per_page=25&sort=stars",
        urlencode(&ghq)
    );
    let doc = fetch_json(&url)?;
    let items = doc
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "GitHub 返回缺少 items".to_string())?;
    let mut out = Vec::new();
    for it in items {
        let name = it
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let full_name = it
            .get("full_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() || full_name.is_empty() {
            continue;
        }
        let dir = github_dir_name(&full_name);
        out.push(RemotePlugin {
            name: dir.clone(),
            full_name,
            description: it
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            url: it
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            source: "github".into(),
            stars: it
                .get("stargazers_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            default_branch: it
                .get("default_branch")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            installed: installed.contains(&dir),
        });
    }
    Ok(out)
}

fn search_npm(q: &str, installed: &std::collections::HashSet<String>) -> Result<Vec<RemotePlugin>, String> {
    let text = if q.is_empty() {
        "@dsh-kit".to_string()
    } else {
        format!("{} @dsh-kit", q)
    };
    let url = format!(
        "https://registry.npmjs.org/-/v1/search?text={}&size=25",
        urlencode(&text)
    );
    let doc = fetch_json(&url)?;
    let objects = doc
        .get("objects")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "npm 返回缺少 objects".to_string())?;
    let mut out = Vec::new();
    for obj in objects {
        let pkg = match obj.get("package").and_then(|v| v.as_object()) {
            Some(p) => p,
            None => continue,
        };
        let full_name = pkg
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if full_name.is_empty() {
            continue;
        }
        let dir = npm_dir_name(&full_name);
        let url = pkg
            .get("links")
            .and_then(|l| l.get("npm"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        out.push(RemotePlugin {
            name: dir.clone(),
            full_name,
            description: pkg
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            url,
            source: "npm".into(),
            stars: 0,
            default_branch: None,
            installed: installed.contains(&dir),
        });
    }
    Ok(out)
}

// ---------- 安装 ----------

/// 安装远程插件到 plugins/ 目录：github 走 zipball，npm 走 tarball。
#[tauri::command]
pub async fn install_remote_plugin(
    source: String,
    full_name: String,
    default_branch: Option<String>,
) -> Result<(), String> {
    let source = source.clone();
    let full_name = full_name.clone();
    let default_branch = default_branch.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_remote_plugin_impl(&source, &full_name, default_branch.as_deref())
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?
}

fn install_remote_plugin_impl(
    source: &str,
    full_name: &str,
    default_branch: Option<&str>,
) -> Result<(), String> {
    install_plugin_to(source, full_name, default_branch).map(|_| ())
}

/// 安装外部插件到 plugins/ 目录（github 走 zipball，npm 走 tarball），返回安装后的目录路径。
/// 供插件市场与「外部内置插件」共用。
pub fn install_plugin_to(
    source: &str,
    full_name: &str,
    default_branch: Option<&str>,
) -> Result<PathBuf, String> {
    let plugins_root = builtin_plugins_dir();
    std::fs::create_dir_all(&plugins_root).map_err(|e| e.to_string())?;

    match source {
        "npm" => install_from_npm(full_name, &plugins_root)?,
        _ => install_from_github(full_name, default_branch, &plugins_root)?,
    }
    let dir = if source == "npm" {
        npm_dir_name(full_name)
    } else {
        github_dir_name(full_name)
    };
    Ok(plugins_root.join(dir))
}

fn install_from_github(full_name: &str, default_branch: Option<&str>, root: &Path) -> Result<(), String> {
    let dir = github_dir_name(full_name);
    let target = root.join(&dir);
    let tmp = std::env::temp_dir().join(format!("dsh-plug-{}.zip", dir));

    // 依次尝试默认分支 / main / master
    let branches: Vec<String> = match default_branch {
        Some(b) if !b.is_empty() => vec![b.to_string(), "main".into(), "master".into()],
        _ => vec!["main".into(), "master".into()],
    };
    let mut last_err = String::from("无法下载仓库");
    for b in &branches {
        let url = format!(
            "https://github.com/{}/archive/refs/heads/{}.zip",
            full_name, b
        );
        match download_file(&url, &tmp) {
            Ok(_) => {
                last_err.clear();
                break;
            }
            Err(e) => {
                last_err = e;
            }
        }
    }
    if !last_err.is_empty() {
        let _ = std::fs::remove_file(&tmp);
        return Err(last_err);
    }

    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("清理旧目录失败: {}", e))?;
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    extract_zip_strip_root(&tmp, &target)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

fn install_from_npm(full_name: &str, root: &Path) -> Result<(), String> {
    let dir = npm_dir_name(full_name);
    let target = root.join(&dir);

    // 拉取 registry 元数据取最新版本 tarball
    let encoded = full_name.replace('/', "%2F");
    let meta_url = format!("https://registry.npmjs.org/{}", encoded);
    let doc = fetch_json(&meta_url)?;
    let latest = doc
        .get("dist-tags")
        .and_then(|d| d.get("latest"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "npm 元数据缺少 dist-tags.latest".to_string())?;
    let tarball = doc
        .get("versions")
        .and_then(|v| v.get(latest))
        .and_then(|v| v.get("dist"))
        .and_then(|d| d.get("tarball"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "npm 元数据缺少 tarball 地址".to_string())?;

    let tmp = std::env::temp_dir().join(format!("dsh-plug-{}.tgz", dir));
    download_file(tarball, &tmp)?;

    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("清理旧目录失败: {}", e))?;
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    extract_tgz_strip_root(&tmp, &target)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

// ---------- skillshub / skillhub.cn ----------

/// skillhub.cn 官方 API 的技能包下载地址模板（{slug} 会被替换为技能 slug）。
const SKILLHUB_CN_DOWNLOAD_TEMPLATE: &str = "https://api.skillhub.cn/api/v1/download?slug={slug}";

/// 识别并解析 skillhub.cn 官方 API 响应（`GET /api/skills`）。
/// 响应特征：顶层含 `code`/`message`，`data.skills` 数组每项带 `slug` 字段。
fn parse_skillhubcn_index(doc: &serde_json::Value) -> Option<SkillshubIndex> {
    if doc.get("code").is_none() && doc.get("message").is_none() {
        return None;
    }
    let skills = doc.get("data")?.get("skills")?.as_array()?;
    let mut out = Vec::new();
    for it in skills {
        let slug = it.get("slug").and_then(|v| v.as_str()).unwrap_or("");
        if slug.is_empty() {
            continue;
        }
        let display = it
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(slug)
            .to_string();
        let description = it
            .get("description_zh")
            .or_else(|| it.get("description"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        out.push(HubSkill {
            name: slug.to_string(),
            description,
            when_to_use: None,
            url: Some(SKILLHUB_CN_DOWNLOAD_TEMPLATE.replace("{slug}", &urlencode(slug))),
            slug: Some(slug.to_string()),
            display_name: Some(display),
        });
    }
    Some(SkillshubIndex {
        skills: out,
        experts: Vec::new(),
        origin: "skillhub.cn".into(),
    })
}

/// 拉取技能广场索引（skillhub.cn API 与旧版 skillshub index.json 均可）。
pub fn fetch_skillshub(url: &str) -> Result<SkillshubIndex, String> {
    if url.trim().is_empty() {
        return Err("未配置技能广场地址（请在设置中填写）".into());
    }
    let doc = fetch_json(url)?;
    // 优先识别 skillhub.cn 官方 API 格式
    if let Some(idx) = parse_skillhubcn_index(&doc) {
        return Ok(idx);
    }
    // 兼容旧版 skillshub index.json：{skills, experts}，可能包在 data 字段里
    let root = doc.get("data").unwrap_or(&doc).clone();
    let mut idx = serde_json::from_value::<SkillshubIndex>(root)
        .map_err(|e| format!("解析技能广场索引失败: {}", e))?;
    idx.origin = "skillshub".into();
    Ok(idx)
}

/// 下载一个远程 zip 并解压到 dest（去掉单层顶层目录）。供技能/专家安装使用。
pub fn install_remote_zip(url: &str, dest: &Path) -> Result<(), String> {
    let tmp = std::env::temp_dir().join(format!(
        "dsh-hub-{}.zip",
        dest.file_name().and_then(|s| s.to_str()).unwrap_or("item")
    ));
    download_file(url, &tmp)?;
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| format!("清理旧目录失败: {}", e))?;
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    extract_zip_strip_root(&tmp, dest)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

// ---------- 解压工具 ----------

/// 解压 zip 到 dest，去掉单层顶层目录（如 GitHub zipball 的 repo-branch/）。
pub fn extract_zip_strip_root(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| format!("无法打开 {}: {}", zip_path.display(), e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取压缩包失败: {}", e))?;
    let len = archive.len();
    // 先扫描出公共顶层目录
    let root_name = common_root_zip(&mut archive, len);
    for i in 0..len {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name() else { continue };
        let rel = strip_root(&name, root_name.as_deref());
        let full = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&full).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = full.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut f = File::create(&full).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn common_root_zip(archive: &mut zip::ZipArchive<File>, len: usize) -> Option<String> {
    let mut root: Option<String> = None;
    for i in 0..len {
        let entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => return None,
        };
        let name = entry.enclosed_name()?;
        let first = name.iter().next()?.to_string_lossy().to_string();
        match &root {
            None => root = Some(first.clone()),
            Some(r) if r != &first => return None,
            _ => {}
        }
    }
    // 仅当存在多于一个条目、且全部共享同一顶层时才剥离
    if len > 1 {
        root
    } else {
        None
    }
}

/// 解压 .tgz 到 dest，去掉单层顶层目录（npm tarball 的 package/）。
pub fn extract_tgz_strip_root(tgz_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(tgz_path).map_err(|e| format!("无法打开 {}: {}", tgz_path.display(), e))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);
    let entries = tar.entries().map_err(|e| format!("读取 tar 失败: {}", e))?;
    // 第一遍：确定公共顶层目录
    let mut names: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        if let Ok(p) = entry.path() {
            names.push(p.into_owned());
        }
    }
    let root_name = common_root_paths(&names);
    // 第二遍：真正解压（重新打开 tar）
    let file = File::open(tgz_path).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);
    for entry in tar.entries().map_err(|e| format!("读取 tar 失败: {}", e))? {
        let mut entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        // 防 zip/tar-slip
        let Some(enclosed) = path_enclosed(&path) else { continue };
        let rel = strip_root(&enclosed, root_name.as_deref());
        let full = dest.join(&rel);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&full).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = full.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut f = File::create(&full).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn common_root_paths(names: &[PathBuf]) -> Option<String> {
    if names.len() <= 1 {
        return None;
    }
    let first = names.iter().filter_map(|p| p.iter().next()).next()?;
    let first_s = first.to_string_lossy().to_string();
    for p in names {
        let Some(f) = p.iter().next() else { return None };
        if f.to_string_lossy() != first_s {
            return None;
        }
    }
    Some(first_s)
}

/// 把 path 限制为相对安全路径（防 zip-slip）。
fn path_enclosed(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::Normal(s) => out.push(s),
            std::path::Component::ParentDir => return None,
            _ => {}
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 去掉顶层目录前缀（root_name 形如 "repo-main"），返回相对路径。
fn strip_root(path: &Path, root_name: Option<&str>) -> PathBuf {
    let Some(root) = root_name else { return path.to_path_buf() };
    let mut comps = path.components();
    let Some(first) = comps.next() else { return path.to_path_buf() };
    if first.as_os_str().to_string_lossy() == root {
        comps.collect()
    } else {
        path.to_path_buf()
    }
}

/// 简单 URL 编码（保留字母数字与 -_.~，空格转 +，其余 %XX）。
/// 供外部拼接搜索/下载 URL 使用。
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
