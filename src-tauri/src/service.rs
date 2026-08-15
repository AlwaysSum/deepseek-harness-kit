//! 服务管理：启动 / 停止 / 端口探测。

use crate::deploy::{ensure_node, npx_cli};
use crate::process::{build_env, emit_log, no_window};
use crate::state::{data_dir, write_dsh_marker, AppState, DSH_PACKAGE, ServiceHandle, Settings};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
pub struct ServiceStatePayload {
    pub state: String,
    pub url: String,
}

pub fn service_url(port: u16) -> String {
    format!("http://127.0.0.1:{}/", port)
}

/// 探测端口上是否有 HTTP 服务
pub fn probe_http(port: u16) -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .user_agent("dsh-desktop/0.1.0")
        .build();
    match agent.get(&service_url(port)).call() {
        Ok(_) => true,
        Err(_) => false,
    }
}

/// 通过 netstat 查找占用端口的进程 PID
pub fn find_pid_on_port(port: u16) -> Option<u32> {
    let mut cmd = Command::new("netstat");
    cmd.args(["-ano", "-p", "tcp"]);
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!(":{}", port);
    let mut pids = Vec::new();
    for line in text.lines() {
        if line.contains(&needle) && line.contains("LISTENING") {
            if let Some(pid) = line.split_whitespace().last() {
                if let Ok(p) = pid.parse::<u32>() {
                    pids.push(p);
                }
            }
        }
    }
    pids.pop()
}

/// 杀掉进程树（Windows taskkill /T /F）
pub fn kill_pid(pid: u32) -> bool {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    no_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// 启动服务（后台进程 + 日志流 + 端口就绪等待）
pub fn start_impl(
    app: &AppHandle,
    state: &AppState,
    settings: &Settings,
) -> Result<(), String> {
    let port = settings.port;
    if probe_http(port) {
        emit_log(app, "service:log", &format!("服务已在运行：{}", service_url(port)), "ok");
        let _ = app.emit(
            "service:state",
            ServiceStatePayload {
                state: "ready".into(),
                url: service_url(port),
            },
        );
        return Ok(());
    }

    let env = ensure_node(app, settings)?;
    let npx = npx_cli(&env);
    if !npx.exists() {
        return Err(format!("未找到 npx-cli.js（{}）", npx.display()));
    }
    let mut cmd = Command::new(&env.node_exe);
    cmd.args([
        npx.to_str().unwrap(),
        "--yes",
        DSH_PACKAGE,
        "web",
        "--port",
        &port.to_string(),
    ]);
    cmd.current_dir(&data_dir());
    let mut penv = build_env(&[&env.node_dir]);
    penv.insert("npm_config_registry".into(), settings.registry.clone());
    cmd.envs(&penv);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("启动服务失败: {}", e))?;
    let pid = child.id();
    let out = child.stdout.take().ok_or("stdout 不可用")?;
    let err = child.stderr.take().ok_or("stderr 不可用")?;
    std::mem::forget(child); // 后台进程由 taskkill 管理

    let a1 = app.clone();
    let t1 = std::thread::spawn(move || {
        for line in BufReader::new(out).lines() {
            if let Ok(l) = line {
                emit_log(&a1, "service:log", &l, "out");
            }
        }
    });
    let a2 = app.clone();
    let t2 = std::thread::spawn(move || {
        for line in BufReader::new(err).lines() {
            if let Ok(l) = line {
                emit_log(&a2, "service:log", &l, "err");
            }
        }
    });
    let _ = (t1, t2);

    *state.service.lock().unwrap() = Some(ServiceHandle { pid });
    emit_log(app, "service:log", &format!("服务进程已启动（PID {}），等待就绪…", pid), "dim");
    let _ = app.emit(
        "service:state",
        ServiceStatePayload {
            state: "starting".into(),
            url: service_url(port),
        },
    );

    // 等待端口就绪（最长 5 分钟，首次启动可能较慢）
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut ready = false;
    while Instant::now() < deadline {
        if probe_http(port) {
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    if !ready {
        let _ = app.emit(
            "service:state",
            ServiceStatePayload {
                state: "failed".into(),
                url: service_url(port),
            },
        );
        return Err("服务启动超时（5 分钟内未就绪），请查看上方日志。".into());
    }
    emit_log(app, "service:log", &format!("服务已就绪：{}", service_url(port)), "ok");
    // 启动成功即视为已部署（npx 缓存已有运行时）
    let _ = write_dsh_marker(
        &crate::state::dsh_version().unwrap_or_else(|| "latest".into()),
    );
    let _ = app.emit(
        "service:state",
        ServiceStatePayload {
            state: "ready".into(),
            url: service_url(port),
        },
    );
    Ok(())
}

/// 停止服务
pub fn stop_impl(
    app: &AppHandle,
    state: &AppState,
    settings: &Settings,
) -> Result<(), String> {
    let port = settings.port;
    let pid = state.service.lock().unwrap().take().map(|h| h.pid);
    let pid = pid.or_else(|| find_pid_on_port(port));
    match pid {
        Some(pid) => {
            emit_log(app, "service:log", &format!("停止服务进程（PID {}）…", pid), "step");
            if !kill_pid(pid) {
                return Err(format!("停止进程失败（PID {}）", pid));
            }
            for _ in 0..30 {
                if !probe_http(port) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
            emit_log(app, "service:log", "服务已停止", "ok");
            let _ = app.emit(
                "service:state",
                ServiceStatePayload {
                    state: "stopped".into(),
                    url: service_url(port),
                },
            );
            Ok(())
        }
        None => Err("未发现运行中的服务。".into()),
    }
}

/// 退出应用时的安静停止：只结束本应用启动的服务进程（不碰端口上其他进程）
pub fn stop_on_exit(state: &AppState) {
    let pid = state.service.lock().unwrap().take().map(|h| h.pid);
    if let Some(pid) = pid {
        let _ = kill_pid(pid);
    }
}
