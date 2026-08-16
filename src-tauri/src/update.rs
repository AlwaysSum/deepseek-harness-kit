//! 更新检查：对接 GitCode Releases（Sunflower816/deepseek-harness-kit）。
//!
//! GitCode 兼容 Gitee OpenAPI v5，公开仓库的 Releases 只读接口无需 access_token，
//! 桌面端客户端可直接调用；安装包附件挂在 release 的 assets 中（type == "attach"）。

use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;

pub const UPDATE_REPO: &str = "Sunflower816/deepseek-harness-kit";
const API_BASE: &str = "https://gitcode.com/api/v5/repos";
const DL_BASE: &str = "https://gitcode.com";

/// GitCode Releases API 仓库根
fn api() -> String {
    format!("{}/{}", API_BASE, UPDATE_REPO)
}

/// 某个版本的 Release 页面地址（GitCode 返回的 JSON 没有 html_url，自行拼接）
fn release_url(tag: &str) -> String {
    format!("{}/{}/releases/tag/{}", DL_BASE, UPDATE_REPO, tag)
}

#[derive(Serialize, Clone, Default)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: Option<String>,
    pub has_update: bool,
    pub release_url: Option<String>,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub error: Option<String>,
}

/// 某个版本（发布记录），供前端列出历史版本以更新/回退
#[derive(Serialize, Clone)]
pub struct Release {
    pub tag: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub release_url: Option<String>,
}

/// "v0.1.0" / "0.1.0" -> (0,1,0)
pub fn version_tuple(v: &str) -> (u32, u32, u32) {
    let t = v.trim().trim_start_matches('v');
    let mut parts = t.split('.');
    let a = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let b = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let c = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    (a, b, c)
}

pub fn has_update(latest: &str, current: &str) -> bool {
    version_tuple(latest) > version_tuple(current)
}

/// 是否为有效的版本 tag（v0.1.0 / 0.1.0）
fn looks_like_version(tag: &str) -> bool {
    let t = tag.trim_start_matches('v');
    let parts: Vec<&str> = t.split('.').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// 工作流产出的安装包文件名是确定的：dsh-desktop_{版本}_x64-setup.exe
fn asset_name_for(tag: &str) -> String {
    format!("dsh-desktop_{}_x64-setup.exe", tag.trim_start_matches('v'))
}

fn agent() -> ureq::Agent {
    crate::process::apply_proxy(
        ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(10))
            .timeout_connect(Duration::from_secs(15))
            .user_agent("dsh-desktop-update-check/1.0"),
    )
    .build()
}

/// 从 release 的 assets 中找本版本对应的安装包附件。
/// 优先精确匹配「dsh-desktop_{版本}_x64-setup.exe」，避免同一 Release 里残留的历史
/// 安装包（GitCode 历史版本曾混入旧包）；兜底取任意 x64 setup 附件。
/// Returns (asset_name, browser_download_url)。
fn find_installer_asset(assets: Option<&serde_json::Value>, tag: &str) -> Option<(String, String)> {
    let arr = assets?.as_array()?;
    let wanted = asset_name_for(tag);
    let mut fallback = None;
    for a in arr {
        let n = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let t = a.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t != "attach" {
            continue;
        }
        let url = a
            .get("browser_download_url")
            .and_then(|u| u.as_str())
            .unwrap_or("");
        if url.is_empty() {
            continue;
        }
        if n == wanted {
            return Some((n.to_string(), url.to_string()));
        }
        if fallback.is_none() && n.contains("x64") && n.ends_with("setup.exe") {
            fallback = Some((n.to_string(), url.to_string()));
        }
    }
    fallback
}

/// 检查 GitCode Releases 最新版本
pub fn check_update() -> UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let endpoint = format!("{}/releases/latest", api());
    let resp = match agent().get(&endpoint).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(404, _)) => {
            // 仓库还没有发布任何版本
            return UpdateInfo {
                current,
                ..Default::default()
            };
        }
        Err(e) => {
            return UpdateInfo {
                current,
                error: Some(format!("无法连接更新服务器：{}", e)),
                ..Default::default()
            };
        }
    };
    let body = match resp.into_string() {
        Ok(b) => b,
        Err(e) => {
            return UpdateInfo {
                current,
                error: Some(format!("读取更新数据失败：{}", e)),
                ..Default::default()
            };
        }
    };
    let json: serde_json::Value = match serde_json::from_str(&body) {
        Ok(j) => j,
        Err(_) => {
            return UpdateInfo {
                current,
                error: Some("更新服务器返回异常数据".into()),
                ..Default::default()
            };
        }
    };

    let mut info = UpdateInfo {
        current,
        ..Default::default()
    };
    info.latest = json
        .get("tag_name")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    if let Some(tag) = &info.latest {
        info.release_url = Some(release_url(tag));
        if let Some((name, url)) = find_installer_asset(json.get("assets"), tag) {
            info.asset_name = Some(name);
            info.asset_url = Some(url);
        }
        info.has_update = has_update(tag, &info.current);
    }
    info
}

/// 拉取全部历史版本（GitCode API /releases），从新到旧返回可安装的版本。
pub fn list_releases() -> Result<Vec<Release>, String> {
    let endpoint = format!("{}/releases?per_page=50", api());
    let resp = agent()
        .get(&endpoint)
        .call()
        .map_err(|e| format!("无法连接更新服务器：{}", e))?;
    let body = resp
        .into_string()
        .map_err(|e| format!("读取更新数据失败：{}", e))?;
    let arr: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "更新服务器返回异常数据".to_string())?;
    let arr = arr.as_array().ok_or("更新服务器返回异常数据")?;

    let mut releases: Vec<Release> = Vec::new();
    for rel in arr {
        let tag = rel
            .get("tag_name")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !looks_like_version(&tag) {
            continue;
        }
        // 找到该版本对应的安装包附件（无安装包则无法更新/回退，跳过）
        let Some((asset_name, asset_url)) = find_installer_asset(rel.get("assets"), &tag) else {
            continue;
        };
        let page = release_url(&tag);
        releases.push(Release {
            tag,
            asset_name: Some(asset_name),
            asset_url: Some(asset_url),
            release_url: Some(page),
        });
    }
    // GitCode 已按发布时间倒序，保持从新到旧
    Ok(releases)
}

/// 下载更新安装包：GitCode 为国内服务，浏览器直链（可能 302 到 OBS 存储），
/// 无需像 GitHub 那样走海外加速镜像；直接下载失败即返回错误。
pub fn download_update(app: &AppHandle, url: &str, name: &str) -> Result<String, String> {
    let dest = crate::state::dl_dir().join(name);
    if let Some(d) = dest.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    crate::download::download(app, url, &dest, name, "update:download")?;
    Ok(dest.display().to_string())
}
