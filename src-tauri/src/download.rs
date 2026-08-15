//! 下载与解压工具。

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
pub struct DownloadPayload {
    pub label: String,
    pub done: u64,
    pub total: u64,
}

pub fn download(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    label: &str,
    event: &str,
) -> Result<(), String> {
    if let Some(d) = dest.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(120))
        .user_agent("dsh-desktop/0.1.0")
        .build();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("下载失败 {}: {}", url, e))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = File::create(dest)
        .map_err(|e| format!("无法创建文件 {}: {}", dest.display(), e))?;
    let mut buf = vec![0u8; 128 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("下载中断: {}", e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        let _ = app.emit(
            event,
            DownloadPayload {
                label: label.to_string(),
                done,
                total,
            },
        );
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// 解压 zip 到目标目录（防 zip-slip）
pub fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let file = File::open(zip_path).map_err(|e| format!("无法打开 {}: {}", zip_path.display(), e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取压缩包失败: {}", e))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(outpath) = entry.enclosed_name() else {
            continue;
        };
        let full = dest.join(&outpath);
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
