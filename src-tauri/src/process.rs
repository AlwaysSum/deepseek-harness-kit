//! 进程执行工具：流式日志、捕获输出、环境构建。

use std::collections::HashMap;
use std::io::Read;
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

/// 泵取子进程输出并逐段推送给前端。
/// 以字节流方式读取，遇到 `\r` 或 `\n` 即作为一条日志发出：
/// npx 等工具用 `\r` 刷新的进度条不会被 BufReader::lines 整段吞掉，
/// 日志可以实时显示。连续相同的段落去重，避免固定文案的旋转动画刷屏。
pub fn spawn_pump<R: Read + Send + 'static>(
    app: AppHandle,
    event: String,
    kind: String,
    reader: R,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut acc = String::new();
        let mut last: Option<String> = None;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]);
                    for ch in s.chars() {
                        if ch == '\n' || ch == '\r' {
                            let seg = acc.trim().to_string();
                            if !seg.is_empty() && last.as_deref() != Some(seg.as_str()) {
                                emit_log(&app, &event, &seg, &kind);
                                last = Some(seg);
                            }
                            acc.clear();
                        } else {
                            acc.push(ch);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let seg = acc.trim().to_string();
        if !seg.is_empty() && last.as_deref() != Some(seg.as_str()) {
            emit_log(&app, &event, &seg, &kind);
        }
    })
}

/// 构建子进程环境：把给定目录（如托管 node 目录）放到 PATH 最前
pub fn build_env(extra_paths: &[&Path]) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    // Windows 环境变量名不区分大小写（系统里通常叫 Path）。
    // 必须先收敛成单个 PATH 键：否则会残留大小写不同的重复键，
    // 子进程解析 node 时可能取到旧 Path 里的系统 Node（如 v18），
    // 导致 dsh 运行时报 parseEnv 等不兼容错误。
    let sys_path = env
        .remove("Path")
        .or_else(|| env.remove("PATH"))
        .or_else(|| env.remove("path"))
        .unwrap_or_default();
    let mut path = String::new();
    for p in extra_paths {
        if let Some(s) = p.to_str() {
            path.push_str(s);
            path.push(';');
        }
    }
    path.push_str(&sys_path);
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

/// 拼接可读的命令行（参数含空格时加引号），用于日志排查
pub fn cmd_line(prog: &str, args: &[String]) -> String {
    std::iter::once(prog.to_string())
        .chain(args.iter().cloned())
        .map(|p| if p.contains(' ') { format!("\"{}\"", p) } else { p })
        .collect::<Vec<_>>()
        .join(" ")
}

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
    // 先把要执行的完整命令打到日志，方便用户复制到终端复现排查
    let args_owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    emit_log(app, event, &format!("[命令] {}", cmd_line(prog, &args_owned)), "step");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 {}: {}", prog, e))?;
    let out = child.stdout.take().ok_or("stdout 不可用")?;
    let err = child.stderr.take().ok_or("stderr 不可用")?;

    let t1 = spawn_pump(app.clone(), event.to_string(), "out".into(), out);
    let t2 = spawn_pump(app.clone(), event.to_string(), "err".into(), err);

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

/// 探测系统代理：优先环境变量，其次 Windows 注册表（IE/系统代理设置）
pub fn system_proxy() -> Option<String> {
    for v in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(p) = std::env::var(v) {
            let p = p.trim();
            if !p.is_empty() {
                return Some(normalize_proxy(p));
            }
        }
    }
    #[cfg(windows)]
    {
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
        // 必须加 CREATE_NO_WINDOW：reg.exe 是控制台程序，不加会在每次网络请求
        // 探测系统代理时弹出一个一闪而过的终端窗口。
        let mut enabled_cmd = std::process::Command::new("reg");
        enabled_cmd.args(["query", key, "/v", "ProxyEnable"]);
        no_window(&mut enabled_cmd);
        let enabled = enabled_cmd
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        if enabled.contains("0x1") {
            let mut server_cmd = std::process::Command::new("reg");
            server_cmd.args(["query", key, "/v", "ProxyServer"]);
            no_window(&mut server_cmd);
            if let Ok(out) = server_cmd.output() {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    if let Some(idx) = line.find("REG_SZ") {
                        let v = line[idx + "REG_SZ".len()..].trim();
                        if !v.is_empty() {
                            return Some(normalize_proxy(v));
                        }
                    }
                }
            }
        }
    }
    None
}

fn normalize_proxy(p: &str) -> String {
    if p.contains("://") {
        p.to_string()
    } else {
        format!("http://{}", p)
    }
}

/// 为 AgentBuilder 应用系统代理（若配置了代理则走代理）
pub fn apply_proxy(builder: ureq::AgentBuilder) -> ureq::AgentBuilder {
    if let Some(p) = system_proxy() {
        if let Ok(proxy) = ureq::Proxy::new(p) {
            return builder.proxy(proxy);
        }
    }
    builder
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
