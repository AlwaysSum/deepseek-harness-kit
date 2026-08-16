//! 更新检查：对接 GitHub Releases（AlwaysSum/deepseek-harness-kit）。

use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;

pub const UPDATE_REPO: &str = "AlwaysSum/deepseek-harness-kit";

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

/// 检查 GitHub Releases 最新版本
pub fn check_update() -> UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();

    // 方式一：releases/latest 重定向拿 tag（避开 API 限流，走 github.com）
    let latest_page = format!("https://github.com/{}/releases/latest", UPDATE_REPO);
    let no_redirect = crate::process::apply_proxy(
        ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(Duration::from_secs(10))
            .user_agent("dsh-desktop-update-check/1.0"),
    )
    .build();
    if let Ok(resp) = no_redirect.get(&latest_page).call() {
        if let Some(loc) = resp.header("location") {
            // 仓库还没有任何发布：/releases/latest -> /releases
            if loc.trim_end_matches('/').ends_with("/releases") {
                return UpdateInfo {
                    current,
                    ..Default::default()
                };
            }
            let tag = loc.rsplit('/').next().unwrap_or("").trim().to_string();
            if looks_like_version(&tag) {
                let asset_name = asset_name_for(&tag);
                let asset_url = format!(
                    "https://github.com/{}/releases/download/{}/{}",
                    UPDATE_REPO, tag, asset_name
                );
                // 验证安装包确实存在（HEAD）
                let asset_exists = agent().head(&asset_url).call().is_ok();
                return UpdateInfo {
                    current: current.clone(),
                    latest: Some(tag.clone()),
                    has_update: has_update(&tag, &current),
                    release_url: Some(format!(
                        "https://github.com/{}/releases/tag/{}",
                        UPDATE_REPO, tag
                    )),
                    asset_name: Some(asset_name),
                    asset_url: if asset_exists { Some(asset_url) } else { None },
                    error: None,
                };
            }
        }
    }

    // 方式二：GitHub API（兜底）
    let api = format!("https://api.github.com/repos/{}/releases/latest", UPDATE_REPO);
    let resp = match agent().get(&api).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(404, _)) => {
            // 还没有发布任何版本
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
    info.release_url = json
        .get("html_url")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string());
    if let Some(assets) = json.get("assets").and_then(|a| a.as_array()) {
        for a in assets {
            let n = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
            if n.contains("x64") && n.ends_with("setup.exe") {
                info.asset_name = Some(n.to_string());
                info.asset_url = a
                    .get("browser_download_url")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string());
                break;
            }
        }
    }
    if let Some(latest) = &info.latest {
        info.has_update = has_update(latest, &info.current);
    }
    info
}

/// 拉取全部历史版本（GitHub API /releases），从新到旧返回可安装的版本。
pub fn list_releases() -> Result<Vec<Release>, String> {
    let api = format!(
        "https://api.github.com/repos/{}/releases?per_page=50",
        UPDATE_REPO
    );
    let resp = agent()
        .get(&api)
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
        let release_url = rel
            .get("html_url")
            .and_then(|u| u.as_str())
            .map(|s| s.to_string());
        // 找到该版本的 setup.exe 资产（无安装包则无法回退，跳过）
        let mut asset_name = None;
        let mut asset_url = None;
        if let Some(assets) = rel.get("assets").and_then(|a| a.as_array()) {
            for a in assets {
                let n = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
                if n.contains("x64") && n.ends_with("setup.exe") {
                    asset_name = Some(n.to_string());
                    asset_url = a
                        .get("browser_download_url")
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string());
                    break;
                }
            }
        }
        if asset_name.is_none() || asset_url.is_none() {
            continue;
        }
        releases.push(Release {
            tag,
            asset_name,
            asset_url,
            release_url,
        });
    }
    // GitHub /releases 已按发布时间倒序，保持从新到旧
    Ok(releases)
}

/// 下载更新安装包（直连失败时依次回退：系统代理、国内加速镜像）
pub fn download_update(app: &AppHandle, url: &str, name: &str) -> Result<String, String> {
    let dest = crate::state::dl_dir().join(name);
    if let Some(d) = dest.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let direct = crate::download::download(app, url, &dest, name, "update:download");
    if direct.is_ok() {
        return Ok(dest.display().to_string());
    }
    let mut last_err = direct.unwrap_err();
    for prefix in ["https://ghfast.top/", "https://gh-proxy.com/"] {
        let u = format!("{}{}", prefix, url);
        match crate::download::download(app, &u, &dest, name, "update:download") {
            Ok(()) => return Ok(dest.display().to_string()),
            Err(e) => last_err = e,
        }
    }
    Err(format!("下载安装包失败：{}", last_err))
}
