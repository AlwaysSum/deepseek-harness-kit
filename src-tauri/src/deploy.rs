//! 一键部署编排：Node 检测/安装 + 通过 npx 获取官方 dsh 运行时。

use crate::download::{download, extract_zip};
use crate::process::{build_env, emit_log, run_capture, run_stream};
use crate::state::{
    data_dir, dl_dir, node_home, node_version_ok, write_dsh_marker, AppState, BINARY_MIRROR,
    DSH_PACKAGE, OFFICIAL_NODE_DIST, Settings,
};
use std::path::PathBuf;
use tauri::AppHandle;

/// 部署用工具链信息
pub struct Env {
    pub node_exe: PathBuf,
    pub node_dir: PathBuf, // 加入 PATH
}

pub fn node_zip_url(ver: &str, base: &str) -> String {
    format!("{}/node/{}/node-{}-win-x64.zip", base, ver, ver)
}

/// npx CLI 入口（node_dir 下自带 npm）
pub fn npx_cli(env: &Env) -> PathBuf {
    env.node_dir
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npx-cli.js")
}

/// 检测 Node：优先系统，其次自动下载便携版
pub fn ensure_node(app: &AppHandle, settings: &Settings) -> Result<Env, String> {
    let sys = run_capture("node", &["--version"], None, None);
    if let Ok(v) = &sys {
        if node_version_ok(v) {
            let exe = run_capture("node", &["-p", "process.execPath"], None, None)
                .unwrap_or_else(|_| "node".into());
            let exe_path = PathBuf::from(exe.trim());
            let dir = exe_path
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_default();
            emit_log(app, "deploy:log", &format!("[Node] 使用系统 Node {}", v), "ok");
            return Ok(Env {
                node_exe: exe_path,
                node_dir: dir,
            });
        }
    }

    if !settings.auto_install_node {
        return Err(format!(
            "Node.js 版本不满足要求（需要 ^22.19 || >=24），当前：{}。可在设置中开启自动安装。",
            sys.unwrap_or_else(|_| "未检测到".into())
        ));
    }

    let ver = &settings.node_version;
    let base = node_home();
    let dir = base.join(format!("node-{}-win-x64", ver));
    let exe = dir.join("node.exe");
    if !exe.exists() {
        emit_log(
            app,
            "deploy:log",
            &format!("[Node] 未检测到可用 Node，正在下载便携版 {}", ver),
            "step",
        );
        let zip = dl_dir().join(format!("node-{}-win-x64.zip", ver));
        let mut ok = false;
        for u in [
            node_zip_url(ver, BINARY_MIRROR),
            node_zip_url(ver, OFFICIAL_NODE_DIST),
        ] {
            emit_log(app, "deploy:log", &format!("[Node] 下载 {}", u), "dim");
            match download(app, &u, &zip, &format!("Node.js {}", ver), "deploy:download") {
                Ok(()) => {
                    ok = true;
                    break;
                }
                Err(e) => emit_log(app, "deploy:log", &format!("[Node] 下载失败：{}", e), "err"),
            }
        }
        if !ok {
            return Err("Node.js 下载失败（npmmirror 与 nodejs.org 均不可用）".into());
        }
        emit_log(app, "deploy:log", "[Node] 解压中…", "dim");
        extract_zip(&zip, &base)?;
        let _ = std::fs::remove_file(&zip);
    }
    let v = run_capture(exe.to_str().unwrap(), &["--version"], None, None)
        .map_err(|e| format!("便携版 Node 验证失败: {}", e))?;
    emit_log(app, "deploy:log", &format!("[Node] 使用便携版 Node {}", v), "ok");
    Ok(Env {
        node_exe: exe,
        node_dir: dir,
    })
}

/// 一键部署主流程：确保 Node，然后 npx 获取官方 dsh 运行时
pub fn deploy_impl(
    app: &AppHandle,
    state: &AppState,
    settings: &Settings,
    force: bool,
) -> Result<(), String> {
    emit_log(app, "deploy:log", "========== 开始一键部署 ==========", "step");
    emit_log(
        app,
        "deploy:log",
        &format!("[信息] 数据目录：{}", data_dir().display()),
        "dim",
    );

    let env = ensure_node(app, settings)?;
    let npx = npx_cli(&env);
    if !npx.exists() {
        return Err(format!("未找到 npx-cli.js（{}）", npx.display()));
    }

    // force 时使用 @latest 强制校验最新版本
    let spec = if force {
        format!("{}@latest", DSH_PACKAGE)
    } else {
        DSH_PACKAGE.to_string()
    };
    emit_log(
        app,
        "deploy:log",
        &format!("[运行时] 通过 npx 获取官方 {}（首次需下载，请稍候）…", spec),
        "step",
    );
    let mut penv = build_env(&[&env.node_dir]);
    penv.insert("npm_config_registry".into(), settings.registry.clone());
    // 用 `web --help` 触发下载并验证可执行（exit 0）
    run_stream(
        app,
        env.node_exe.to_str().unwrap(),
        &[
            npx.to_str().unwrap(),
            "--yes",
            &spec,
            "web",
            "--help",
        ],
        Some(&data_dir()),
        Some(&penv),
        "deploy:log",
    )?;

    let version = crate::state::dsh_version().unwrap_or_else(|| "latest".into());
    write_dsh_marker(&version)?;
    emit_log(
        app,
        "deploy:log",
        &format!("[运行时] DeepSeek Harness {} 就绪", version),
        "ok",
    );
    emit_log(app, "deploy:log", "========== 部署完成 ==========", "ok");

    if settings.auto_start_after_deploy {
        emit_log(app, "deploy:log", "[启动] 自动启动服务…", "step");
        crate::service::start_impl(app, state, settings)?;
    }
    Ok(())
}
