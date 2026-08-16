//! Windows 防火墙检测与放行。
//!
//! 解决"端口已监听但 HTTP 不应答"的常见根因：Windows 防火墙拦截了入站连接
//! （用户关闭防火墙后即可访问）。启动诊断发现端口被拦截时，尝试通过 UAC
//! 提权添加一条针对该端口的入站放行规则。

use crate::process::{no_window, run_capture};
use std::process::Command;

/// 放行规则固定命名（按端口区分，便于查重/删除）
pub fn rule_name(port: u16) -> String {
    format!("dsh-desktop-{}", port)
}

/// 防火墙是否开启：任一配置文件（域/专用/公用）启用即视为开启。
/// 通过 PowerShell NetSecurity 模块查询，输出与系统语言无关。
pub fn firewall_enabled() -> bool {
    let script = "if ((Get-NetFirewallProfile | Where-Object {$_.Enabled -eq $true})) { 'ON' } else { 'OFF' }";
    let out = run_capture(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", script],
        None,
        None,
    );
    match out {
        Ok(v) => v.trim().eq_ignore_ascii_case("ON"),
        Err(_) => false,
    }
}

/// 是否已存在针对该端口的放行规则（按固定规则名精确匹配，退出码 0=存在）
pub fn rule_exists(port: u16) -> bool {
    let mut cmd = Command::new("netsh");
    cmd.args([
        "advfirewall",
        "firewall",
        "show",
        "rule",
        &format!("name={}", rule_name(port)),
        "dir=in",
    ]);
    no_window(&mut cmd);
    cmd.output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 尝试放行端口：外层 powershell 以普通权限静默启动，内部通过
/// `Start-Process -Verb RunAs` 触发 UAC 提权执行 netsh 添加入站放行规则。
/// 成功后返回 Ok(())；用户拒绝 UAC 或添加失败返回 Err 并附手动命令。
pub fn add_port_rule(port: u16) -> Result<(), String> {
    let name = rule_name(port);
    // 全部参数无空格，Start-Process -ArgumentList 无需额外引号
    let script = format!(
        "Start-Process -FilePath \"$env:windir\\System32\\netsh.exe\" \
         -ArgumentList 'advfirewall','firewall','add','rule','name={name}','dir=in',\
         'action=allow','protocol=TCP','localport={port}','profile=any' \
         -Verb RunAs -Wait",
        name = name,
        port = port,
    );
    // run_capture 内部已对外层 powershell 加 CREATE_NO_WINDOW，不会闪控制台窗口；
    // UAC 授权弹窗由系统呈现，不受影响。
    let _ = run_capture(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
        None,
        None,
    );
    if rule_exists(port) {
        Ok(())
    } else {
        Err(format!(
            "未能添加防火墙放行规则（可能未通过 UAC 授权）。可手动执行：\
             netsh advfirewall firewall add rule name=\"{}\" dir=in action=allow protocol=TCP localport={}",
            name, port
        ))
    }
}
