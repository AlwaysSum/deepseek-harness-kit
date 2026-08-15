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

/// 检查 GitHub Releases 最新版本
pub fn check_update() -> UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let mut info = UpdateInfo {
        current,
        ..Default::default()
    };

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .user_agent("dsh-desktop-update-check/1.0")
        .build();
    let api = format!("https://api.github.com/repos/{}/releases/latest", UPDATE_REPO);
    let resp = match agent.get(&api).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(404, _)) => {
            // 还没有发布任何版本
            return info;
        }
        Err(e) => {
            info.error = Some(format!("无法连接更新服务器：{}", e));
            return info;
        }
    };
    let body = match resp.into_string() {
        Ok(b) => b,
        Err(e) => {
            info.error = Some(format!("读取更新数据失败：{}", e));
            return info;
        }
    };
    let json: serde_json::Value = match serde_json::from_str(&body) {
        Ok(j) => j,
        Err(_) => {
            info.error = Some("更新服务器返回异常数据".into());
            return info;
        }
    };

    info.latest = json.get("tag_name").and_then(|t| t.as_str()).map(|s| s.to_string());
    info.release_url = json
        .get("html_url")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string());

    if let Some(assets) = json.get("assets").and_then(|a| a.as_array()) {
        for a in assets {
            let n = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
            // 优先 x64 安装包
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

/// 下载更新安装包（直连失败时回退国内加速镜像）
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
