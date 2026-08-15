//! 进程执行工具：流式日志、捕获输出、环境构建。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
pub struct LogPayload {
    pub line: String,
    pub kind: String,
}

pub fn emit_log(app: &AppHandle, event: &str, line: &str, kind: &str) {
    let _ = app.emit(
        event,
        LogPayload {
            line: line.to_string(),
            kind: kind.to_string(),
        },
    );
}

/// 构建子进程环境：把给定目录（如托管 node 目录）放到 PATH 最前
pub fn build_env(extra_paths: &[&Path]) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    let mut path = String::new();
    for p in extra_paths {
        if let Some(s) = p.to_str() {
            path.push_str(s);
            path.push(';');
        }
    }
    if let Some(p) = env.get("PATH") {
        path.push_str(p);
    }
    env.insert("PATH".into(), path);
    env
}

#[cfg(windows)]
pub fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
pub fn no_window(_cmd: &mut Command) {}

/// 执行命令并把 stdout/stderr 逐行推送给前端
pub fn run_stream(
    app: &AppHandle,
    prog: &str,
    args: &[&str],
    cwd: Option<&Path>,
    env: Option<&HashMap<String, String>>,
    event: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(prog);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    if let Some(e) = env {
        cmd.envs(e);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 {}: {}", prog, e))?;
    let out = child.stdout.take().ok_or("stdout 不可用")?;
    let err = child.stderr.take().ok_or("stderr 不可用")?;

    let a1 = app.clone();
    let ev1 = event.to_string();
    let t1 = std::thread::spawn(move || {
        for line in BufReader::new(out).lines() {
            if let Ok(l) = line {
                emit_log(&a1, &ev1, &l, "out");
            }
        }
    });
    let a2 = app.clone();
    let ev2 = event.to_string();
    let t2 = std::thread::spawn(move || {
        for line in BufReader::new(err).lines() {
            if let Ok(l) = line {
                emit_log(&a2, &ev2, &l, "err");
            }
        }
    });

    let status = child.wait().map_err(|e| format!("等待进程失败: {}", e))?;
    let _ = t1.join();
    let _ = t2.join();
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "命令执行失败（退出码 {}）：{} {}",
            status.code().unwrap_or(-1),
            prog,
            args.join(" ")
        ))
    }
}

/// 执行命令并捕获 stdout（trim 后返回）
pub fn run_capture(
    prog: &str,
    args: &[&str],
    cwd: Option<&Path>,
    env: Option<&HashMap<String, String>>,
) -> Result<String, String> {
    let mut cmd = Command::new(prog);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    if let Some(e) = env {
        cmd.envs(e);
    }
    cmd.stdin(Stdio::null());
    no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("无法运行 {}: {}", prog, e))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(format!(
            "{} 退出码 {}: {}",
            prog,
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}
