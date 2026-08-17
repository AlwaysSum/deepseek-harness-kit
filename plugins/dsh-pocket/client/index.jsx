// dsh-pocket 网页客户端：
//   1. 设置页签「手机访问」（局域网/公网二维码 + 更新/重启提示）
//   2. 移动端适配（移植自 MIT 项目 dsh-web-mobile，见 client/mobile/LICENSE.dsh-web-mobile）
//
// 手机扫码打开的就是电脑上的 dsh web，实时同步；窄屏自动变成抽屉布局。
//
// 注：Web Push 已移除——浏览器推送依赖 Google FCM（Chrome）等境外服务，
// 国内直连被墙，普通用户用不了。专注扫码同屏这一件事。

import { createElement as h, useEffect, useState } from 'react';

import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS, redactStatus, compareVersions } from './api.js';
import { mobileApply } from './mobile/mobile-apply.tsx';

const name = 'dsh-pocket';
const inject = ['slots', 'connection', 'layout', 'locale', 'sessionLogDownload'];

// 官方 DeepSeek Harness 设计系统（dsh-client-ui-theme design-platform.css）：
// 按钮 md=36px 胶囊形 / sm=28px；品牌色 --dsw-alias-brand-primary；
// hover 走 --dsw-alias-button-*-hover；间距 4px 栅格；正文 13px。
const styles = {
  card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 12, padding: '16px 20px', maxWidth: 480 },
  block: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', marginTop: 16, paddingTop: 16 },
  muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
  code: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, wordBreak: 'break-all', margin: '6px 0 10px', color: 'var(--dsw-alias-label-primary,inherit)' },
  // 主按钮：官方 md 胶囊形（36px）
  primary: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))', color: '#fff', height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  // 次级按钮：官方 outline/ghost 胶囊形
  btn: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)', height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  qr: { width: 220, height: 220, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', margin: '8px 0' },
  warn: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.5 },
};

function PocketSettingsTab({ rpcCall }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tunnelState, setTunnelState] = useState(null); // 隧道进度 {phase, detail, startedAt}
  const [restartNotice, setRestartNotice] = useState(false); // 重启后提示
  const [updateInfo, setUpdateInfo] = useState(null); // { current, latest, updating, result, startedAt } | null
  const [isDesktop, setIsDesktop] = useState(false); // DSH Desktop（Electron）环境：更新/重启由桌面版管理
  const [now, setNow] = useState(Date.now()); // 每秒 tick，驱动倒计时

  // 进行中操作的「已等待 X 秒」倒计时
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = (startedAt) => (startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0);

  const call = async (endpoint, payload) => {
    const res = await rpcCall(endpoint, payload);
    if (!res?.ok) throw new Error(res?.error?.message ?? 'RPC failed');
    return res.value;
  };

  const load = async () => {
    try {
      const s = await call(POCKET_ENDPOINTS.status, {});
      setStatus(s);
      setTunnelState(s.tunnelState ?? null);
      if (s.desktop) setIsDesktop(true);
      if (s.restartNotice) {
        // 新进程确认起来了：显示一次「已重启」，清掉旧的更新横幅（单状态，不并存），
        // 然后自动刷新页面加载新代码——不用用户手动刷新
        setRestartNotice(true);
        setUpdateInfo(null);
        if (!sessionStorage.getItem('dshp-auto-reloaded')) {
          sessionStorage.setItem('dshp-auto-reloaded', '1');
          setTimeout(() => { try { location.reload(); } catch { /* 忽略 */ } }, 2000);
        }
      }
    } catch { /* 忽略瞬时失败 */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  // 每次页面加载清掉自动刷新标记——这样下次重启（更新后）才能再次触发自动刷新
  useEffect(() => {
    try { sessionStorage.removeItem('dshp-auto-reloaded'); } catch { /* 忽略 */ }
  }, []);

  // 版本检测：host 当前版本 vs npm registry latest（registry 带 CORS *）
  // 两种情况显示横幅：① 有新版可更新；② 磁盘已更新但进程还是旧代码（重启生效）
  // cache: 'no-store' —— registry 响应带缓存头，浏览器会缓存旧版本号导致「小版本不提示」
  // 周期重查（每 5 分钟）：npm registry 的 /latest 走 CDN 边缘缓存，刚发布后打开页面
  // 可能拿到旧版本号——周期性重查让更新提示在缓存刷新后自动出现，不用重开页面。
  // 桌面端（isDesktop）：更新/重启由 DSH Desktop 管理，这里不做版本检测、不显示更新横幅
  useEffect(() => {
    if (isDesktop) return;
    let alive = true;
    const check = async () => {
      try {
        const v = await call(POCKET_ENDPOINTS.version, {});
        const meta = await (await fetch('https://registry.npmjs.org/dsh-pocket/latest', { cache: 'no-store' })).json();
        if (!alive) return;
        const latest = typeof meta?.version === 'string' ? meta.version : null;
        if (latest && v.current && compareVersions(latest, v.current) > 0) {
          setUpdateInfo({ current: v.current, latest, updating: false, result: null });
        } else if (v.current && v.loaded && compareVersions(v.current, v.loaded) > 0) {
          // 已更新未重启：显示「已更新，重启生效」+ 重启按钮
          setUpdateInfo({ current: v.current, latest: v.current, updating: false, result: 'ok', updated: true });
        }
      } catch { /* 网络失败静默 */ }
    };
    check();
    const t = setInterval(check, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [isDesktop]);

  // 重启宿主（更新生效必需：刷新页面不会重载服务端代码）
  const restartPocket = async () => {
    setUpdateInfo((u) => ({ ...u, restarting: true, startedAt: Date.now() }));
    try {
      // 宿主 500ms 后自杀，RPC 响应可能来不及送达 → 3 秒超时兜底，别让按钮永远卡「重启中…」
      await Promise.race([
        call(POCKET_ENDPOINTS.restart, {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('restart requested (no reply within 3s)')), 3000)),
      ]);
      setUpdateInfo((u) => ({ ...u, restarting: true, result: 'ok' }));
    } catch (err) {
      // 网络断连/超时同样视为「已请求重启」——旧进程即将退出，等新进程起来后刷新即可
      const msg = String(err?.message ?? '');
      if (/connection|socket|fetch|network|abort|cancelled|ECONN|disconnect|closed|timeout/i.test(msg)) {
        setUpdateInfo((u) => ({ ...u, restarting: true, result: 'ok' }));
        return;
      }
      setUpdateInfo((u) => ({ ...u, restarting: false, result: 'fail', output: err.message }));
    }
  };

  // 一键更新：调宿主 dsh plugin update（成功后宿主自动重启生效，用户只点一次）
  const runUpdate = async () => {
    setUpdateInfo((u) => ({ ...u, updating: true, result: null, startedAt: Date.now() }));
    try {
      const r = await call(POCKET_ENDPOINTS.update, {});
      setUpdateInfo((u) => ({
        ...u,
        updating: false,
        result: r.ok ? 'ok' : 'fail',
        autoRestart: r.autoRestart === true,
        output: r.output ?? r.error,
      }));
    } catch (err) {
      setUpdateInfo((u) => ({ ...u, updating: false, result: 'fail', output: err.message }));
    }
  };

  const startTunnel = async () => {
    setBusy(true);
    setError(null);
    setTunnelState({ phase: 'starting', detail: '正在开启…', startedAt: Date.now() });
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelStart, {}));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const stopTunnel = async () => {
    try { setStatus(await call(POCKET_ENDPOINTS.tunnelStop, {})); } catch { /* 忽略 */ }
  };

  const lanUrl = status?.lanUrl;
  const tunnelUrl = status?.tunnelUrl;
  const tunnelPhase = tunnelState?.phase ?? 'idle';
  const tunnelStarting = ['downloading', 'starting', 'registering'].includes(tunnelPhase);
  const tunnelStateDetail = tunnelState?.detail ?? '';
  const tunnelStateStarted = tunnelState?.startedAt ?? null;

  return h('div', { style: styles.card },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h('div', null,
        h('strong', null, '📱 手机访问 | Phone access'),
        h('div', { style: styles.muted }, '手机扫码打开的就是电脑上的这个界面，实时同步 | the phone shows this exact screen, live'),
      ),
      h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', textAlign: 'right' } },
        h('div', { style: { whiteSpace: 'nowrap' } }, '开发者：程序员少北晨'),
        h('div', { style: { whiteSpace: 'nowrap' } }, '⭐ 顺手留颗 Star，作者能高兴一整天'),
        h('a', { href: 'https://github.com/shaobeichen/dsh-pocket', target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-brand-primary,#4f6ef7)', fontSize: 12, lineHeight: 1.6, textDecoration: 'underline' } },
          '行，给你一颗 Star'),
      ),
    ),

    // 桌面端不显示更新/重启横幅（更新由 DSH Desktop 管理），也不需要额外提示

    // 重启后提示（进程在后台运行，停止方法）——左侧蓝色色条（桌面端不会触发本插件的自重启）
    !isDesktop && restartNotice ? h('div', { style: { ...styles.block, borderLeft: '4px solid var(--dsw-alias-brand-primary,#4f6ef7)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', padding: '10px 12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { fontWeight: 600, fontSize: 13 } }, '🔄 已重启 | Restarted'),
        h('button', { style: styles.btn, onClick: () => setRestartNotice(false) }, '知道了 | OK'),
      ),
      h('div', { style: styles.muted, marginTop: 4, wordBreak: 'break-all' }, `进程在后台运行（不挂终端）。如需停止：${status?.killHint ?? `lsof -ti :${status?.dshPort ?? 3080} | xargs kill -9`}`),
    ) : null,

    // 更新提示——左侧黄色色条（提示有新版本）；单状态：有更新/更新中/已更新自动重启，不并存
    // 桌面端不渲染（更新由 DSH Desktop 管理）
    !isDesktop && updateInfo ? h('div', { style: { ...styles.block, borderLeft: '4px solid var(--dsw-alias-state-warn-primary,#b45309)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', padding: '10px 12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { fontWeight: 600, fontSize: 13 } },
          updateInfo.updated
            ? `✅ 已更新 v${updateInfo.current}，重启生效 | Updated — restart to apply`
            : updateInfo.result === 'ok'
              ? (updateInfo.autoRestart ? `✅ 已更新 v${updateInfo.latest}，正在自动重启… | updated — restarting…` : `✅ 已更新 v${updateInfo.latest} | Updated`)
              : `📦 新版本 v${updateInfo.latest} | Update available`),
        updateInfo.result !== 'ok'
          ? h('button', { style: styles.primary, onClick: runUpdate, disabled: updateInfo.updating }, updateInfo.updating ? '更新中…' : `更新到 v${updateInfo.latest} | Update`)
          : updateInfo.autoRestart
            ? h('button', { style: styles.btn, disabled: true }, '正在重启生效… | restarting…')
            : h('button', { style: styles.primary, onClick: restartPocket, disabled: updateInfo.restarting }, updateInfo.restarting ? '重启中…' : '🔄 重启 dsh web 生效 | Restart now'),
      ),
      h('div', { style: styles.muted, marginTop: 4 },
        updateInfo.updating
          ? `⏳ 更新中（通常 1-2 分钟）· 已等待 ${elapsed(updateInfo.startedAt)} 秒 | updating (usually 1-2 min) · ${elapsed(updateInfo.startedAt)}s`
        : updateInfo.restarting
          ? `⏳ 正在重启生效（通常 10-30 秒）· 已等待 ${elapsed(updateInfo.startedAt)} 秒 | restarting (usually 10-30s) · ${elapsed(updateInfo.startedAt)}s`
        : updateInfo.result === 'ok'
          ? (updateInfo.autoRestart ? '✅ 已更新，正在自动重启生效，请稍候刷新 | updated — restarting automatically, refresh shortly'
            : '✅ 已更新，重启 dsh web 生效 | updated — restart dsh web')
        : updateInfo.result === 'fail' ? `❌ 失败：${updateInfo.output || '未知'}（手动更新：dsh plugin --profile web update dsh-pocket --latest -w）`
        : `当前 v${updateInfo.current} → 最新 v${updateInfo.latest}`),
    ) : null,

    // 局域网
    h('div', { style: styles.block },
      h('div', { style: { fontWeight: 600, fontSize: 13 } }, '📶 局域网（同一 WiFi）| LAN'),
      lanUrl
        ? h('div', null,
          h('img', { src: status.lanQr, alt: 'LAN QR', style: styles.qr }),
          h('div', { style: styles.code }, lanUrl),
          h('div', { style: styles.muted }, '手机连接同一 WiFi 后扫码即可打开'),
        )
        : h('div', { style: styles.muted }, '代理未就绪… | proxy starting…'),
    ),

    // 公网
    h('div', { style: styles.block },
      h('div', { style: { fontWeight: 600, fontSize: 13 } }, '🌐 公网（人在外面）| Anywhere'),
      tunnelUrl
        ? h('div', null,
          h('img', { src: status.tunnelQr, alt: 'Tunnel QR', style: styles.qr }),
          h('div', { style: styles.code }, tunnelUrl),
          h('div', { style: styles.muted }, '任何网络扫码即用（URL 每次重启自动换新）'),
          h('div', { style: styles.warn, marginTop: 4 }, '🔑 链接已泄露？重启 dsh web——URL 立即换新，旧链接作废，无安全风险 | URL leaked? Restart dsh web — the URL rotates and the old one dies'),
          h('button', { style: styles.btn, onClick: stopTunnel }, '关闭公网 | Stop'),
        )
        : h('div', null,
          h('button', { style: { ...styles.primary, margin: '8px 0' }, onClick: startTunnel, disabled: busy || tunnelStarting }, busy ? '开启中…' : '开启公网访问 | Enable anywhere'),
          tunnelStarting
            ? h('div', { style: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)' } },
              tunnelPhase === 'downloading'
                ? `⏳ 下载 cloudflared（首次约 20-50MB，通常 1-2 分钟；之后秒开）· 已等待 ${elapsed(tunnelStateStarted)} 秒`
                : `⏳ 连接 Cloudflare 边缘（通常 5-30 秒）· 已等待 ${elapsed(tunnelStateStarted)} 秒${elapsed(tunnelStateStarted) > 30 ? ' — 有点久？检查是否开着代理/VPN（Clash TUN 等）' : ''}`)
            : tunnelPhase === 'error'
              ? h('div', { style: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } },
                `❌ 开启失败：${tunnelStateDetail || '未知错误 | failed'}（可重试；若是代理/VPN 问题见 README 排障）`)
              : h('div', null,
                h('div', { style: styles.warn, marginTop: 4 }, '⚠️ DSH 能执行电脑代码：二维码/URL 就是钥匙，请勿发给别人 | the QR/URL is the key — never share it'),
                h('div', { style: styles.muted, marginTop: 4 }, '不慎泄露了？重启 dsh web，URL 自动换新、旧链接立即失效 | Leaked it? Restart dsh web — the URL rotates and the old one dies instantly'),
              ),
        ),
    ),

    error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 12, marginTop: 8 } }, `❌ ${error}`) : null,

    // 页面最底部：反馈入口
    h('div', { style: { ...styles.block, textAlign: 'center' } },
      h('a', { href: 'https://github.com/shaobeichen/dsh-pocket/issues', target: '_blank', rel: 'noreferrer', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)', textDecoration: 'none' } },
        '有问题？欢迎到 GitHub Issues 反馈 🙏 | Questions? Open an issue on GitHub'),
    ),
  );
}

export function apply(ctx) {
  // 移动端适配（dsh-web-mobile 移植）：抽屉布局/触控/安全区，仅窄屏生效
  mobileApply(ctx);

  const rpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(POCKET_RPC_CHANNEL, endpoint, payload, signal);

  // 设置一级入口（与 通用设置/模型/插件 同级，order 1 = 通用之后、最外层）
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'pocket',
        order: 1,
        label: () => '手机访问',
        inject: () => ({ rpcCall }),
      },
      PocketSettingsTab,
    ),
  );
}

export { name, inject, redactStatus };
