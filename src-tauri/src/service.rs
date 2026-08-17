//! 服务管理：启动 / 停止 / 端口探测。

use crate::deploy::ensure_node;
use crate::process::{build_env, emit_log, no_window, spawn_pump_tail};
use crate::state::{data_dir, write_dsh_marker, AppState, ServiceHandle, Settings};
use std::collections::VecDeque;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
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
        // 必须同时设读超时和连接超时：否则当端口有监听但服务事件循环卡住时，
        // TCP 连接积压会导致每次 connect 等满 Windows 默认 21 秒才失败，
        // 启动等待循环会每 21 秒才推进一次，误以为服务在缓慢启动。
        .timeout(Duration::from_secs(2))
        .timeout_connect(Duration::from_secs(2))
        .user_agent("dsh-desktop/0.1.0")
        .build();
    match agent.get(&service_url(port)).call() {
        Ok(_) => true,
        Err(_) => false,
    }
}

/// node 进程的可执行名，用于识别端口占用者是否为残留的 dsh/node 进程。
#[cfg(windows)]
const NODE_PROCESS_NAME: &str = "node.exe";
#[cfg(not(windows))]
const NODE_PROCESS_NAME: &str = "node";

/// 通过系统工具查找占用端口的进程 PID
#[cfg(windows)]
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
#[cfg(not(windows))]
pub fn find_pid_on_port(port: u16) -> Option<u32> {
    // 优先 lsof（macOS / Linux 桌面发行版默认可用），-t 仅输出 PID
    if let Ok(out) = Command::new("lsof")
        .args(["-nP", "-iTCP", &format!(":{port}"), "-sTCP:LISTEN", "-t"])
        .output()
    {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Ok(p) = line.trim().parse::<u32>() {
                return Some(p);
            }
        }
    }
    // 回退 ss（Linux iproute2）
    #[cfg(target_os = "linux")]
    if let Ok(out) = Command::new("ss").args(["-ltnp"]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        let needle = format!(":{}", port);
        for line in text.lines() {
            if line.contains(&needle) && line.contains("LISTEN") {
                if let Some(idx) = line.find("pid=") {
                    let rest = &line[idx + 4..];
                    let pid_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(p) = pid_str.parse::<u32>() {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

/// 杀掉进程树（Windows taskkill /T /F；Unix kill -KILL）
#[cfg(windows)]
pub fn kill_pid(pid: u32) -> bool {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    no_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}
#[cfg(not(windows))]
pub fn kill_pid(pid: u32) -> bool {
    // Unix 上 dsh 服务为单进程，直接 SIGKILL 与 Windows /F 语义对齐；
    // 若后续 dsh 派生子进程，可改为进程组管理（当前未设置 pgid）。
    Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 查询进程可执行文件名，用于识别端口占用者是否为残留的 node 进程
#[cfg(windows)]
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
#[cfg(not(windows))]
fn process_name(pid: u32) -> String {
    // `ps -p PID -o comm=` 输出进程命令名（如 node），与 Windows tasklist 返回的
    // 可执行名等价；返回小写以统一比较。
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_lowercase().to_string())
        .unwrap_or_default()
}

/// 端口监听快照，用于启动卡住时的诊断输出
#[cfg(windows)]
fn port_listen_lines(port: u16) -> String {
    let mut cmd = Command::new("netstat");
    cmd.args(["-ano", "-p", "tcp"]);
    no_window(&mut cmd);
    let out = cmd.output().ok();
    let text = out
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let needle = format!(":{}", port);
    let lines: Vec<&str> = text.lines().filter(|l| l.contains(&needle)).collect();
    if lines.is_empty() {
        "(无匹配的监听行)".into()
    } else {
        lines[..lines.len().min(8)].join("\n")
    }
}
#[cfg(not(windows))]
fn port_listen_lines(port: u16) -> String {
    let mut lines: Vec<String> = Vec::new();
    // lsof（macOS / Linux 桌面默认可用）
    if let Ok(out) = Command::new("lsof")
        .args(["-nP", "-iTCP", &format!(":{port}"), "-sTCP:LISTEN"])
        .output()
    {
        for l in String::from_utf8_lossy(&out.stdout).lines() {
            let t = l.trim();
            if !t.is_empty() {
                lines.push(t.to_string());
            }
        }
    }
    #[cfg(target_os = "linux")]
    if lines.is_empty() {
        if let Ok(out) = Command::new("ss").args(["-ltnp"]).output() {
            let needle = format!(":{}", port);
            for l in String::from_utf8_lossy(&out.stdout).lines() {
                if l.contains(&needle) && l.contains("LISTEN") {
                    lines.push(l.trim().to_string());
                }
            }
        }
    }
    if lines.is_empty() {
        "(无匹配的监听行)".into()
    } else {
        lines[..lines.len().min(8)].join("\n")
    }
}

/// 把子进程最近输出回放到日志：启动失败/超时时确保真实报错可见，
/// 而不是只看到“仍在等待服务就绪”的循环。
fn dump_tail(tail: &Arc<Mutex<VecDeque<String>>>, app: &AppHandle, title: &str) {
    let lines = tail.lock().unwrap();
    if lines.is_empty() {
        return;
    }
    emit_log(app, "service:log", title, "err");
    for l in lines.iter() {
        emit_log(app, "service:log", l, "err");
    }
}

/// 查询端口当前占用者，用于 EADDRINUSE 等启动失败时给出可操作的提示
fn port_holder_hint(port: u16) -> Option<String> {
    let pid = find_pid_on_port(port)?;
    let name = process_name(pid);
    Some(format!(
        "端口 {} 当前被进程 PID {}（{}）占用，请先停止该进程，或在设置中更换端口后再启动。",
        port,
        pid,
        if name.is_empty() { "未知" } else { &name }
    ))
}

/// 后台检测防火墙并尝试放行端口（在诊断线程中调用，不阻塞等待循环）：
/// 端口已监听但 HTTP 不应答 → 防火墙开启且无放行规则 → UAC 提权添加放行规则。
fn firewall_ensure(port: u16, app: &AppHandle) {
    if !crate::firewall::firewall_enabled() {
        #[cfg(windows)]
        let msg: String = "[防火墙] 系统防火墙未启用，端口不应被 Windows 防火墙拦截。若仍无法访问，请检查第三方安全软件（如 360、火绒等）的防火墙是否拦截了该端口。".to_string();
        #[cfg(not(windows))]
        let msg: String = format!(
            "[防火墙] 非 Windows 平台，未启用自动放行。若无法访问，请放行 TCP 端口 {}（firewalld: `sudo firewall-cmd --add-port={}/tcp`；ufw: `sudo ufw allow {}/tcp`），或检查第三方安全软件。",
            port, port, port
        );
        emit_log(app, "service:log", &msg, "dim");
        return;
    }
    if crate::firewall::rule_exists(port) {
        emit_log(
            app,
            "service:log",
            &format!("[防火墙] 端口 {} 已有放行规则，问题不在防火墙。", port),
            "dim",
        );
        return;
    }
    emit_log(
        app,
        "service:log",
        &format!(
            "[防火墙] 端口 {} 已监听但 HTTP 不应答，疑似被 Windows 防火墙拦截，尝试自动放行（将弹出 UAC 授权窗口，请点击「是」）…",
            port
        ),
        "warn",
    );
    match crate::firewall::add_port_rule(port) {
        Ok(()) => {
            emit_log(
                app,
                "service:log",
                &format!("[防火墙] 已为端口 {} 添加入站放行规则，请稍候服务就绪。", port),
                "ok",
            );
        }
        Err(e) => emit_log(
            app,
            "service:log",
            &format!("[防火墙] 自动放行失败：{}", e),
            "err",
        ),
    }
}

/// 启动服务（后台进程 + 日志流 + 端口就绪等待）
pub fn start_impl(
    app: &AppHandle,
    state: &AppState,
    settings: &Settings,
) -> Result<(), String> {
    let port = settings.port;

    // 局域网访问：确保 profile 的 webserver host 覆盖与端口一致（0.0.0.0）。
    if let Err(e) = crate::net::set_webserver_patch(settings.allow_lan, port) {
        emit_log(
            app,
            "service:log",
            &format!("[局域网] 写入 webserver host 补丁失败：{}", e),
            "err",
        );
    }

    // 局域网访问：往 dsh 前端 dist 的 index.html 注入 crypto.randomUUID polyfill。
    // 纯 HTTP + 非 loopback（如手机扫码 192.168.x.x）属浏览器不安全上下文，
    // Crypto.randomUUID 缺失会让 dsh 前端多处抛 "crypto.randomUUID is not a function"。
    crate::net::ensure_lan_polyfill(settings.allow_lan);

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
        if name == NODE_PROCESS_NAME {
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

    // 启动前清理 web profile 里误登记的模式型 bundle（如 dsh-TUI 与 dsh-web-app
    // 的 storage/workspace 等行冲突，会导致 dsh 启动报 duplicate loader entry id）
    if let Err(e) = crate::plugins::prune_web_incompatible_bundles() {
        emit_log(
            app,
            "service:log",
            &format!("[插件] 清理 web profile 中不兼容的插件失败：{}", e),
            "warn",
        );
    }

    let mut penv = build_env(&[&env.path_dir]);
    penv.insert("npm_config_registry".into(), settings.registry.clone());
    // 直接执行缓存包的入口 JS，并把 Node 锁死为便携版 v22：
    // npx 的 .cmd 脚本会回退到 PATH 里的系统 Node（如 v18 缺 parseEnv 崩溃），不能用，
    // 因此启动绝不走 npx。包未缓存时提示先一键部署（部署内部也是用 npx 只装包、再直连入口）。
    let bin = crate::state::dsh_bin_js()
        .ok_or("未找到本地缓存的 dsh 运行时，请先点击「一键部署」下载后再启动。")?;
    emit_log(
        app,
        "service:log",
        "使用本地缓存的 dsh 运行时（便携版 Node）直接启动…",
        "dim",
    );
    let mut cmd_args: Vec<String> = vec![
        bin.to_string_lossy().into_owned(),
        "web".into(),
        "--port".into(),
        port.to_string(),
    ];
    // 局域网访问开启时，把本机每个局域网 IPv4 显式登记为 dsh 可信主机。
    // 单靠 0.0.0.0 绑定 + dsh 自动推导 LAN IP 不可靠（一次性采样、与启动时序竞争），
    // 导致用 LAN IP 访问时 /api 被 isTrustedApiRequest 拦截、功能不可用。
    // --trusted-host 接受 bare host（无端口），匹配任意端口，正好覆盖 LAN IP:port。
    if settings.allow_lan {
        for ip in crate::net::lan_ipv4_addresses() {
            cmd_args.push("--trusted-host".into());
            cmd_args.push(ip);
        }
    }

    let mut cmd = Command::new(&env.node_exe);
    cmd.args(&cmd_args);
    cmd.current_dir(&data_dir());
    cmd.envs(&penv);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);

    // 先把要执行的完整命令打到日志，方便复制到终端复现排查
    let cmd_display = crate::process::cmd_line(env.node_exe.to_string_lossy().as_ref(), &cmd_args);
    emit_log(app, "service:log", &format!("[命令] {}", cmd_display), "step");
    emit_log(
        app,
        "service:log",
        &format!("[命令] 工作目录：{}", data_dir().display()),
        "dim",
    );

    let mut child = cmd.spawn().map_err(|e| format!("启动服务失败: {}", e))?;
    let pid = child.id();
    let out = child.stdout.take().ok_or("stdout 不可用")?;
    let err = child.stderr.take().ok_or("stderr 不可用")?;

    // 泵取 stdout/stderr：兼容 \r 进度条，日志实时显示；同时缓存最近 60 段，
    // 失败/超时时回放到日志，确保命令的真实报错可见。
    let (_t1, tail_out) =
        spawn_pump_tail(app.clone(), "service:log".to_string(), "out".into(), out, 60);
    let (_t2, tail_err) =
        spawn_pump_tail(app.clone(), "service:log".to_string(), "err".into(), err, 60);

    *state.service.lock().unwrap() = Some(ServiceHandle { pid });
    emit_log(app, "service:log", &format!("服务进程已启动（PID {}），等待就绪…", pid), "dim");
    let _ = app.emit(
        "service:state",
        ServiceStatePayload {
            state: "starting".into(),
            url: service_url(port),
        },
    );

    // 等待端口就绪（最长 120 秒；dsh 已由部署步骤预装，无需再次下载）
    let started = Instant::now();
    let deadline = started + Duration::from_secs(120);
    let mut last_feedback = Instant::now();
    let mut diagnosed = false;
    let mut warned_stuck = false;
    let mut ready = false;
    loop {
        if probe_http(port) {
            ready = true;
            break;
        }
        // 子进程提前退出：立即回放它的真实输出（如 EADDRINUSE 报错），
        // 而不是继续在“等待就绪”里空转。
        if let Ok(Some(status)) = child.try_wait() {
            *state.service.lock().unwrap() = None;
            let _ = app.emit(
                "service:state",
                ServiceStatePayload {
                    state: "failed".into(),
                    url: service_url(port),
                },
            );
            // 稍等泵线程把输出写进缓冲，再回放尾部
            std::thread::sleep(Duration::from_millis(500));
            dump_tail(&tail_out, app, "── 服务进程输出（最后 60 段）──");
            dump_tail(&tail_err, app, "── 服务进程错误输出（最后 60 段）──");
            let mut msg = format!(
                "服务进程提前退出（退出码 {}），以上为进程输出的最后内容，请据此排查。",
                status.code().unwrap_or(-1)
            );
            if let Some(h) = port_holder_hint(port) {
                msg.push_str(&format!("\n{}", h));
            }
            return Err(msg);
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
        // 30 秒仍未就绪：输出一次端口监听快照，区分「端口没监听」和「监听了但 HTTP 不应答」
        if !diagnosed && started.elapsed() >= Duration::from_secs(30) {
            diagnosed = true;
            let snapshot = port_listen_lines(port);
            emit_log(app, "service:log", "[诊断] 端口监听快照：", "warn");
            for line in snapshot.lines() {
                let l = line.trim();
                if !l.is_empty() {
                    emit_log(app, "service:log", l, "dim");
                }
            }
            // Windows netstat 输出 LISTENING，Unix lsof/ss 输出 LISTEN，均含子串 "LISTEN"
            if snapshot.contains("LISTEN") {
                #[cfg(windows)]
                let detail = "可能是 Windows 防火墙拦截了入站连接，或 dsh 启动过程被网络请求阻塞。将自动检测防火墙并尝试放行端口。";
                #[cfg(not(windows))]
                let detail = "可能是系统防火墙（firewalld/ufw 等）或安全软件拦截了入站连接，或 dsh 启动过程被网络请求阻塞。";
                emit_log(
                    app,
                    "service:log",
                    &format!("[诊断] 端口已监听但 HTTP 不应答：{}", detail),
                    "warn",
                );
                // 后台检测防火墙：开启且无放行规则时，通过 UAC 提权添加规则放行该端口
                let app2 = app.clone();
                let port2 = port;
                std::thread::spawn(move || firewall_ensure(port2, &app2));
            } else {
                emit_log(
                    app,
                    "service:log",
                    "[诊断] 进程已启动但端口尚未监听，请结合上方 [命令] 与实时输出排查。",
                    "warn",
                );
            }
        }
        // 90 秒仍未就绪：提示可能已卡死，即将自动停止
        if !warned_stuck && started.elapsed() >= Duration::from_secs(90) {
            warned_stuck = true;
            emit_log(
                app,
                "service:log",
                &format!(
                    "[警告] 已等待 {} 秒仍未就绪，疑似启动卡死；{} 秒后自动停止并回放进程输出。",
                    started.elapsed().as_secs(),
                    deadline.saturating_duration_since(Instant::now()).as_secs()
                ),
                "warn",
            );
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
        std::thread::sleep(Duration::from_millis(600));
        dump_tail(&tail_out, app, "── 服务进程输出（最后 60 段）──");
        dump_tail(&tail_err, app, "── 服务进程错误输出（最后 60 段）──");
        let mut msg = format!(
            "服务启动超时（{} 秒内未就绪），已自动停止进程；以上为进程输出的最后内容，请据此排查。",
            started.elapsed().as_secs()
        );
        if let Some(h) = port_holder_hint(port) {
            msg.push_str(&format!("\n{}", h));
        }
        return Err(msg);
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
