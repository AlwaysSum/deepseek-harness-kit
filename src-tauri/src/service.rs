//! 服务管理：启动 / 停止 / 端口探测。

use crate::deploy::{ensure_node, npx_cli};
use crate::process::{build_env, emit_log, no_window, spawn_pump};
use crate::state::{data_dir, write_dsh_marker, AppState, DSH_PACKAGE, ServiceHandle, Settings};
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

/// 查询进程可执行文件名（tasklist CSV），用于识别端口占用者是否为残留的 node 进程
fn process_name(pid: u32) -> String {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"]);
    no_window(&mut cmd);
    let out = cmd.output().ok();
    let text = out
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    text.trim()
        .split(',')
        .next()
        .map(|s| s.trim_matches('"').to_lowercase())
        .unwrap_or_default()
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

    // 端口上有监听进程但探测不到 HTTP：大概率是上次异常退出残留的 dsh/node 进程。
    // 识别为 node.exe 时自动清理后继续启动；其他程序占用则给出明确提示。
    if let Some(pid) = find_pid_on_port(port) {
        let name = process_name(pid);
        emit_log(
            app,
            "service:log",
            &format!("端口 {} 被进程占用（PID {}，{}）且未响应 HTTP", port, pid, if name.is_empty() { "未知" } else { &name }),
            "warn",
        );
        if name == "node.exe" {
            emit_log(app, "service:log", "检测到残留的 Node 进程，自动清理后继续启动…", "step");
            if !kill_pid(pid) {
                return Err(format!(
                    "无法清理占用端口 {} 的残留进程（PID {}），请手动结束该进程或更换端口。",
                    port, pid
                ));
            }
            let mut freed = false;
            for _ in 0..20 {
                if find_pid_on_port(port).is_none() {
                    freed = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
            if !freed {
                return Err(format!(
                    "占用端口 {} 的残留进程清理超时（PID {}），请手动结束或更换端口。",
                    port, pid
                ));
            }
        } else {
            return Err(format!(
                "端口 {} 被其他程序占用（PID {}，{}），请在设置中更换端口或先停止该程序。",
                port,
                pid,
                if name.is_empty() { "未知" } else { &name }
            ));
        }
    }

    let env = ensure_node(app, settings)?;
    let npx = npx_cli(&env);
    if !npx.exists() {
        return Err(format!("未找到 npx-cli.js（{}）", npx.display()));
    }

    let mut penv = build_env(&[&env.node_dir]);
    penv.insert("npm_config_registry".into(), settings.registry.clone());

    // 组装启动命令：优先直接用缓存包的入口 JS 运行（绕开 npx 的 .cmd 脚本，
    // 避免它回退到 PATH 里的系统 Node，比如 v18 缺 parseEnv 导致启动崩溃）；
    // 包未缓存时回退到 npx（需要联网下载）。
    let cmd_args: Vec<String> = if let Some(bin) = crate::state::dsh_bin_js() {
        emit_log(
            app,
            "service:log",
            "使用本地缓存的 dsh 运行时直接启动…",
            "dim",
        );
        vec![
            bin.to_string_lossy().into_owned(),
            "web".into(),
            "--port".into(),
            port.to_string(),
        ]
    } else {
        // 未缓存：npx 优先使用本地缓存，避免每次启动都联网校验
        penv.insert("npm_config_prefer_offline".into(), "true".into());
        vec![
            npx.to_string_lossy().into_owned(),
            "--yes".into(),
            DSH_PACKAGE.into(),
            "web".into(),
            "--port".into(),
            port.to_string(),
        ]
    };

    let mut cmd = Command::new(&env.node_exe);
    cmd.args(&cmd_args);
    cmd.current_dir(&data_dir());
    cmd.envs(&penv);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("启动服务失败: {}", e))?;
    let pid = child.id();
    let out = child.stdout.take().ok_or("stdout 不可用")?;
    let err = child.stderr.take().ok_or("stderr 不可用")?;

    // 泵取 stdout/stderr：兼容 \r 进度条，日志实时显示
    spawn_pump(app.clone(), "service:log".to_string(), "out".into(), out);
    spawn_pump(app.clone(), "service:log".to_string(), "err".into(), err);

    *state.service.lock().unwrap() = Some(ServiceHandle { pid });
    emit_log(app, "service:log", &format!("服务进程已启动（PID {}），等待就绪…", pid), "dim");
    let _ = app.emit(
        "service:state",
        ServiceStatePayload {
            state: "starting".into(),
            url: service_url(port),
        },
    );

    // 等待端口就绪（最长 5 分钟，首次启动可能需要下载）
    let started = Instant::now();
    let deadline = started + Duration::from_secs(300);
    let mut last_feedback = Instant::now();
    let mut ready = false;
    loop {
        if probe_http(port) {
            ready = true;
            break;
        }
        // 子进程提前退出：直接报失败，不必干等 5 分钟
        if let Ok(Some(status)) = child.try_wait() {
            *state.service.lock().unwrap() = None;
            let _ = app.emit(
                "service:state",
                ServiceStatePayload {
                    state: "failed".into(),
                    url: service_url(port),
                },
            );
            return Err(format!(
                "服务进程提前退出（退出码 {}），请查看上方日志。",
                status.code().unwrap_or(-1)
            ));
        }
        // 周期性反馈，避免界面看起来“卡死”
        if last_feedback.elapsed() >= Duration::from_secs(15) {
            emit_log(
                app,
                "service:log",
                &format!("仍在等待服务就绪，已等待 {} 秒…", started.elapsed().as_secs()),
                "dim",
            );
            last_feedback = Instant::now();
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if !ready {
        // 超时：清理残留进程与状态，避免留下无法停止的孤儿进程
        let _ = kill_pid(pid);
        *state.service.lock().unwrap() = None;
        let _ = app.emit(
            "service:state",
            ServiceStatePayload {
                state: "failed".into(),
                url: service_url(port),
            },
        );
        return Err("服务启动超时（5 分钟内未就绪），请查看上方日志。".into());
    }
    // 启动成功：后台进程交由 taskkill 管理
    std::mem::forget(child);
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
