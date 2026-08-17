//! 局域网地址探测与 webserver host patch 管理。
//!
//! 扫码访问需要服务绑定到局域网（0.0.0.0），并让 dsh 的 /api 信任局域网 Host。
//! dsh 的 webserver 只接受 127.0.0.1 / 0.0.0.0 两种 host，且 CLI 层会拒绝
//! --host 0.0.0.0（安全护栏）。因此这里通过 profile 的 cordis.patch.yml 覆盖
//! webserver 行配置为 0.0.0.0 -- 这是 dsh 官方支持的“刻意网络暴露”姿态。
//! 注意：绑定到 0.0.0.0 后，dsh 虽有 resolveLanTrust 自动推导 LAN IP 的逻辑，
//! 但其一次性采样与启动时序竞争，推导结果未必进入 /api 信任名单。因此
//! service.rs 在 allow_lan 开启时还会把本机各 LAN IPv4 通过 --trusted-host
//! 显式登记为可信主机，确保用 LAN IP 访问时 /api 不被 isTrustedApiRequest 拦截。

use crate::process::run_capture;
use std::path::PathBuf;
use crate::state::dsh_profile_dir;
use std::net::{Ipv4Addr, UdpSocket};

/// 链路本地（APIPA）地址 169.254.0.0/16，不可作为可访问地址。
fn is_link_local(o: [u8; 4]) -> bool {
    o[0] == 169 && o[1] == 254
}

/// 通过 UDP connect 到公网地址获取“默认路由接口”的出口 IPv4（不真正发包）。
/// 这是后端最可靠的获取主局域网地址的方法，且与系统语言无关。
fn primary_lan_ip_via_udp() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // connect 选择源地址，不发送任何数据。
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_ipv4() {
        let v4 = match ip {
            std::net::IpAddr::V4(v) => v,
            _ => return None,
        };
        let o = v4.octets();
        if !v4.is_loopback() && !is_link_local(o) {
            return Some(ip.to_string());
        }
    }
    None
}

/// 通过 PowerShell Get-NetIPAddress 枚举全部 IPv4（字段名与系统语言无关，
/// 与应用内 firewall.rs 的做法一致）。仅在真实用户权限下可用。
fn enumerate_via_cim() -> Vec<String> {
    // 输出用竖线分隔，避免依赖 PowerShell 表格的对齐宽度。
    let script = "Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { $_.IPAddress }";
    match run_capture(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", script],
        None,
        None,
    ) {
        Ok(out) => out
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// 清理并排序枚举到的 IPv4：去掉回环、链路本地、空串、非法地址，去重，保序。
fn normalize(list: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for s in list {
        let t = s.trim().to_string();
        if t.is_empty() || seen.contains(&t) {
            continue;
        }
        if let Ok(ip) = t.parse::<Ipv4Addr>() {
            let o = ip.octets();
            if !ip.is_loopback() && !is_link_local(o) && !ip.is_unspecified() {
                seen.insert(t.clone());
                out.push(t);
            }
        }
    }
    out
}

/// 返回本机可访问的局域网 IPv4 地址列表（主地址优先，无重复）。
pub fn lan_ipv4_addresses() -> Vec<String> {
    let mut list = Vec::new();
    if let Some(p) = primary_lan_ip_via_udp() {
        list.push(p);
    }
    list.extend(enumerate_via_cim());
    normalize(list)
}

// ---------- webserver host patch ----------

/// cordis.patch.yml 中 webserver 行的 id。
const WEBSERVER_ID: &str = "webserver";

/// 读取 profile 的 cordis.patch.yml 文本；文件不存在时返回空串。
fn read_patch() -> String {
    let p = dsh_profile_dir().join("cordis.patch.yml");
    std::fs::read_to_string(&p).unwrap_or_else(|_| String::new())
}

fn write_patch(text: &str) -> Result<(), String> {
    let p = dsh_profile_dir().join("cordis.patch.yml");
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&p, text).map_err(|e| format!("写入 {} 失败: {}", p.display(), e))
}

/// 判断现有 patch 文本里是否已含 webserver 覆盖条目。
fn has_webserver_entry(text: &str) -> bool {
    text.lines()
        .any(|l| l.trim().eq_ignore_ascii_case("- id: ") && l.contains(WEBSERVER_ID))
        || text.contains(&format!("- id: {}", WEBSERVER_ID))
}

/// 生成一份包含 webserver host 覆盖的 patch（保留未动的最外层注释行）。
fn build_enabled_patch(port: u16) -> String {
    let header = "# 由 dsh-desktop 管理的局域网访问补丁（UI 中开启“允许局域网访问”时生效）。
                  # 覆盖 dsh 内置 webserver 绑定到全部接口；配合 service.rs 传 --trusted-host
                  # 显式信任 LAN IP（dsh 自动推导不可靠），并往前端注入 crypto.randomUUID polyfill。
";
    format!(
        "{}
- id: {}
  config:
    host: 0.0.0.0
    port: {}
",
        header, WEBSERVER_ID, port
    )
}

/// 根据开关写入/移除 webserver host=0.0.0.0 覆盖。
/// - 开启：写入仅含 webserver 覆盖的 patch（保留注释）。
/// - 关闭：移除 webserver 覆盖（回到 dsh 默认的 127.0.0.1）。
pub fn set_webserver_patch(allow_lan: bool, port: u16) -> Result<(), String> {
    let current = read_patch();
    if allow_lan {
        // 仅当尚未写入或端口不同时才重写，避免每次启动都改动文件。
        if !has_webserver_entry(&current)
            || !current.contains(&format!("port: {}", port))
        {
            write_patch(&build_enabled_patch(port))?;
        }
    } else {
        // 关闭：清空为普通模板，让 dsh 走默认回环。
        let template = "# 由 dsh-desktop 管理的局域网访问补丁：当前未开启，webserver 保持默认 127.0.0.1。
                        # 需要局域网扫码访问时，可在 UI 中开启“允许局域网访问”。
";
        write_patch(template)?;
    }
    Ok(())
}

/// 判断 webserver host 覆盖当前是否为 0.0.0.0（用于状态展示）。
pub fn webserver_patch_enabled() -> bool {
    let t = read_patch();
    has_webserver_entry(&t) && t.contains("host: 0.0.0.0")
}

// ---------- 前端 crypto.randomUUID polyfill（LAN HTTP 不安全上下文兼容） ----------

/// polyfill 注入标记：在 index.html 里以此串的存在判定是否已注入（幂等）。
const POLYFILL_MARKER: &str = "dsh-desktop-lan-randomuuid-polyfill";

/// polyfill 脚本体（单引号字面量，不含双引号，便于嵌入 raw string）。
/// 用不安全上下文下仍可用的 crypto.getRandomValues 实现 RFC 4122 v4 UUID；
/// 安全上下文下 crypto.randomUUID 已存在，自检跳过，零行为差异。
const POLYFILL_JS: &str = r#"(function(){if(typeof crypto==='undefined'||typeof crypto.randomUUID==='function')return;var s=crypto&&typeof crypto.getRandomValues==='function'?crypto:null;if(!s)return;crypto.randomUUID=function randomUUID(){var b=s.getRandomValues(new Uint8Array(16));b[6]=(b[6]&0x0f)|0x40;b[8]=(b[8]&0x3f)|0x80;var h='',i=0;while(i!==16){var x=b[i].toString(16);if(x.length!==2)x='0'+x;h+=x;i++}return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20,32)};})();"#;

/// 定位 npx 缓存里 dsh-web-frontend 的 dist/index.html。
/// dsh 的 applyIndexTaps 每次请求都 read 此文件再叠加官方 tap（boot manifest 等），
/// 故直接 patch 文件不会与 dsh 注入冲突。优先取提升到顶层的包，回退到嵌套在
/// dsh-web-app 下的副本。
fn find_dsh_frontend_index() -> Option<PathBuf> {
    let dsh_pkg = crate::state::find_dsh_package_dir()?;
    let nm = dsh_pkg.parent()?.parent()?;
    let candidates = [
        nm.join("@deepseek-ai").join("dsh-web-frontend"),
        nm
            .join("@deepseek-ai")
            .join("dsh-web-app")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh-web-frontend"),
    ];
    for c in candidates {
        let idx = c.join("dist").join("index.html");
        if idx.is_file() {
            return Some(idx);
        }
    }
    None
}

/// 局域网访问开启时，幂等地往 dsh 前端 dist 的 index.html 注入 crypto.randomUUID
/// polyfill。纯 HTTP + 非 loopback（如手机扫码访问 192.168.104.8:3080）属浏览器
/// 不安全上下文，Crypto.randomUUID 被隐藏，dsh 前端多处（dsh-client-connection
/// 的消息 id、dsh-client-ui-conversation 的会话 id）调用即抛
/// "crypto.randomUUID is not a function"，功能连锁失效。127.0.0.1 / HTTPS 不
/// 受影响（安全上下文，polyfill 自检跳过）。注入为经典内联 <script>，插在 <head>
/// 之首，先于所有 type=module 的延迟脚本执行，保证 polyfill 先于任何调用就位。
pub fn ensure_lan_polyfill(allow_lan: bool) {
    if !allow_lan {
        return;
    }
    let Some(index) = find_dsh_frontend_index() else {
        return;
    };
    let Ok(html) = std::fs::read_to_string(&index) else {
        return;
    };
    if html.contains(POLYFILL_MARKER) {
        return;
    }
    let script = format!(
        r#"<script data-lan-compat="{m}">{js}</script>"#,
        m = POLYFILL_MARKER,
        js = POLYFILL_JS
    );
    let patched = match html.find("<head>") {
        Some(i) => {
            let (head, tail) = html.split_at(i + 6);
            format!("{}{}{}", head, script, tail)
        }
        None => format!("{}{}", script, html),
    };
    let _ = std::fs::write(&index, patched);
}
