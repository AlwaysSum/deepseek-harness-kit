// E2E for the npx-based flow: modal hidden, status, deploy(npx fetch), start, iframe, stop.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let target;
  for (let i = 0; i < 30; i++) {
    try {
      const ts = await (await fetch("http://127.0.0.1:9222/json")).json();
      target = ts.find((t) => t.type === "page" && /tauri|localhost/.test(t.url));
      if (target) break;
    } catch {}
    await sleep(500);
  }
  if (!target) throw new Error("no app target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m.result);
      pend.delete(m.id);
    }
  };
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
      ?.result?.value;
  const invoke = (cmd, args = {}) =>
    ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(
      () => 'OK', (e) => 'ERR: ' + e
    )`);

  // 1) modal must be hidden (the bug: was always visible)
  const modalDisplay = await ev(
    `getComputedStyle(document.querySelector('#modal-settings')).display`
  );
  console.log("[modal] display:", modalDisplay, modalDisplay === "none" ? "✓ hidden" : "✗ VISIBLE (BUG)");
  const overlayDisplay = await ev(
    `getComputedStyle(document.querySelector('#page-overlay')).display`
  );
  console.log("[overlay] display:", overlayDisplay, overlayDisplay === "none" ? "✓ hidden" : "✗ VISIBLE");

  // 2) status shape
  const s0 = await ev(`window.__TAURI_INTERNALS__.invoke('get_status')`);
  console.log("[status]", JSON.stringify({
    node: s0.node, dsh: s0.dsh, service: s0.service, busy: s0.busy, port: s0.settings.port }, null, 2));

  // 3) use a free port for testing
  const cur = await ev(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
  await invoke("set_settings", { settings: { ...cur, port: 3099 } });

  // 4) deploy (npx fetch) — runs async, watch busy
  console.log("[deploy] invoking deploy…");
  await ev(`window.__TAURI_INTERNALS__.invoke('deploy', { force: false })`, false);
  let done = false;
  for (let i = 0; i < 300; i++) {
    await sleep(5000);
    let s;
    try { s = await ev(`window.__TAURI_INTERNALS__.invoke('get_status')`); } catch { continue; }
    const line = `[poll ${Math.round(i * 5)}s] busy=${s.busy} dsh=${s.dsh?.ready} running=${s.service?.running} port=${s.settings?.port}`;
    if (i % 4 === 0) console.log(line);
    if (!s.busy && s.dsh?.ready && s.service?.running) { done = true; console.log(line); break; }
    if (!s.busy && !s.dsh?.ready) { console.log(line); console.log("[deploy] FAILED — dsh not ready"); break; }
  }
  const s1 = await ev(`window.__TAURI_INTERNALS__.invoke('get_status')`);
  console.log("[deploy] final:", JSON.stringify({ dsh: s1.dsh, service: s1.service, busy: s1.busy }));

  // 5) iframe + page view
  await sleep(2000);
  console.log("[page] active view:", await ev(`document.querySelector('.view.active')?.id`));
  console.log("[page] iframe src:", await ev(`document.querySelector('#harness-frame')?.src`));
  const ts2 = await (await fetch("http://127.0.0.1:9222/json")).json();
  console.log("[page] CDP targets:", ts2.map((t) => `${t.type}|${t.url}`).join("  "));

  // 6) stop
  console.log("[stop] invoking stop_service…");
  console.log("[stop] result:", await invoke("stop_service"));
  await sleep(3000);
  const s3 = await ev(`window.__TAURI_INTERNALS__.invoke('get_status')`);
  console.log("[stop] final:", JSON.stringify({ running: s3.service?.running, busy: s3.busy }));

  // 7) restore port
  const cur2 = await ev(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
  await invoke("set_settings", { settings: { ...cur2, port: 3080 } });
  console.log("[done]");
  ws.close();
})().catch((e) => {
  console.error("[FAIL]", e.message);
  process.exit(1);
});
