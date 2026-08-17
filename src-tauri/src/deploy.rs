//! 一键部署编排：Node 检测/安装 + 通过 npx 获取官方 dsh 运行时。

use crate::download::download;
#[cfg(windows)]
use crate::download::extract_zip;
#[cfg(not(windows))]
use crate::download::extract_tar_xz;
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
    /// 用于定位 npx/npm（见 npx_cli）：Windows 便携/系统均为 node 所在目录，
    /// Unix 便携为解压根目录（npm 在 lib/node_modules 下），系统为 node 所在 bin 目录。
    pub node_dir: PathBuf,
    /// 需加入 PATH 的目录：Windows 与 node_dir 一致；Unix 便携为 node_dir/bin。
    pub path_dir: PathBuf,
}

/// 当前目标平台的 Node 官方包标识与压缩格式后缀。
/// Windows = win-x64.zip；Linux = linux-{arch}.tar.xz；macOS = darwin-{arch}.tar.xz。
#[cfg(windows)]
fn node_archive_platform() -> (&'static str, &'static str) {
    ("win-x64", "zip")
}
#[cfg(not(windows))]
fn node_archive_platform() -> (&'static str, &'static str) {
    if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") {
            ("linux-arm64", "tar.xz")
        } else {
            ("linux-x64", "tar.xz")
        }
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            ("darwin-arm64", "tar.xz")
        } else {
            ("darwin-x64", "tar.xz")
        }
    } else {
        ("linux-x64", "tar.xz")
    }
}

pub fn node_archive_url(ver: &str, base: &str) -> String {
    let (plat, ext) = node_archive_platform();
    format!("{}/node/{}/node-{}-{}.{}", base, ver, ver, plat, ext)
}

pub fn node_archive_name(ver: &str) -> String {
    let (plat, ext) = node_archive_platform();
    format!("node-{}-{}.{}", ver, plat, ext)
}

pub fn node_extract_dir_name(ver: &str) -> String {
    let (plat, _) = node_archive_platform();
    format!("node-{}-{}", ver, plat)
}

/// 便携包内 node 可执行文件的相对路径：Windows 直接在根下（node.exe），
/// Unix 在 bin/ 下（bin/node）。
#[cfg(windows)]
fn node_bin_relative() -> PathBuf {
    PathBuf::from("node.exe")
}
#[cfg(not(windows))]
fn node_bin_relative() -> PathBuf {
    PathBuf::from("bin").join("node")
}

pub fn node_managed_dir(ver: &str) -> PathBuf {
    node_home().join(node_extract_dir_name(ver))
}

pub fn node_managed_exe(ver: &str) -> PathBuf {
    node_managed_dir(ver).join(node_bin_relative())
}

/// npx CLI 入口（node_dir 下自带 npm）
pub fn npx_cli(env: &Env) -> PathBuf {
    let cands = npx_cli_candidates(env);
    for c in &cands {
        if c.is_file() {
            return c.clone();
        }
    }
    // 找不到时返回首个候选，便于上层报出明确路径
    cands.into_iter().next().unwrap_or_default()
}

/// 按平台枚举 npx-cli.js 的候选路径。
#[cfg(windows)]
fn npx_cli_candidates(env: &Env) -> Vec<PathBuf> {
    vec![
        env.node_dir
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npx-cli.js"),
    ]
}
#[cfg(not(windows))]
fn npx_cli_candidates(env: &Env) -> Vec<PathBuf> {
    let mut v = Vec::new();
    // 便携版 tarball 布局：<root>/lib/node_modules/npm/bin/npx-cli.js
    v.push(
        env.node_dir
            .join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npx-cli.js"),
    );
    // 系统 Node：通过 `npm root -g` 解析全局 node_modules 根
    // （apt/NodeSource/nvm/Homebrew 各自把 npm 放在不同位置，统一用 npm 自述最稳）
    if let Ok(root) = run_capture("npm", &["root", "-g"], None, None) {
        let root = root.trim();
        if !root.is_empty() {
            v.push(PathBuf::from(root).join("npm").join("bin").join("npx-cli.js"));
        }
    }
    // 兜底：部分发行版把全局 node_modules 放在 node_dir 同级 lib
    v.push(
        env.node_dir
            .join("..")
            .join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npx-cli.js"),
    );
    v
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
            // 系统 Node：node_dir 即 node 所在 bin 目录，PATH 与定位 npm 都基于它
            return Ok(Env {
                node_exe: exe_path,
                node_dir: dir.clone(),
                path_dir: dir,
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
    let dir = node_managed_dir(ver);
    let exe = node_managed_exe(ver);
    if !exe.exists() {
        emit_log(
            app,
            "deploy:log",
            &format!("[Node] 未检测到可用 Node，正在下载便携版 {}", ver),
            "step",
        );
        let archive = dl_dir().join(node_archive_name(ver));
        let mut ok = false;
        for u in [
            node_archive_url(ver, BINARY_MIRROR),
            node_archive_url(ver, OFFICIAL_NODE_DIST),
        ] {
            emit_log(app, "deploy:log", &format!("[Node] 下载 {}", u), "dim");
            match download(app, &u, &archive, &format!("Node.js {}", ver), "deploy:download") {
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
        #[cfg(windows)]
        extract_zip(&archive, &base)?;
        #[cfg(not(windows))]
        extract_tar_xz(&archive, &base)?;
        let _ = std::fs::remove_file(&archive);
    }
    let v = run_capture(exe.to_str().unwrap(), &["--version"], None, None)
        .map_err(|e| format!("便携版 Node 验证失败: {}", e))?;
    emit_log(app, "deploy:log", &format!("[Node] 使用便携版 Node {}", v), "ok");
    // 便携版：Windows 的 node.exe 在解压根目录，PATH 直接用根目录；
    // Unix 的 node 在 <root>/bin/node，PATH 需指向 <root>/bin
    #[cfg(windows)]
    let path_dir = dir.clone();
    #[cfg(not(windows))]
    let path_dir = dir.join("bin");
    Ok(Env {
        node_exe: exe,
        node_dir: dir,
        path_dir,
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
    let mut penv = build_env(&[&env.path_dir]);
    penv.insert("npm_config_registry".into(), settings.registry.clone());
    // 1) npx 只负责安装/更新包：用 --call 跑一个无操作命令，绝不执行 dsh 的 bin。
    //    npx 执行 bin 走 .cmd 脚本，会回退到 PATH 里的系统 Node（v18 缺 parseEnv 崩溃）。
    let node_str = env.node_exe.to_str().unwrap();
    let npx_str = npx.to_str().unwrap();
    let spec_str = spec.as_str();
    run_stream(
        app,
        node_str,
        &[
            npx_str,
            "--yes",
            "--package",
            spec_str,
            "--call",
            "node -e 1",
        ],
        Some(&data_dir()),
        Some(&penv),
        "deploy:log",
    )?;
    // 2) 用便携版 Node 直接执行缓存包入口验证可执行（锁死正确版本）
    let bin = crate::state::dsh_bin_js().ok_or("npx 安装后未找到 dsh 运行时入口")?;
    let bin_str = bin.to_str().unwrap();
    run_stream(
        app,
        node_str,
        &[bin_str, "web", "--help"],
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
