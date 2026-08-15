// E2E: set port 3099, start_service, wait ready, verify iframe, stop_service, verify stopped.
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

  // 1) change port to 3099
  const cur = await ev(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
  const newSettings = { ...cur, port: 3099 };
  console.log("[settings] set port ->", await invoke("set_settings", { settings: newSettings }));

  // 2) start service
  console.log("[start] invoking start_service…");
  const startResult = await invoke("start_service");
  console.log("[start] result:", startResult);

  // 3) wait until service.running on 3099
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const s = await ev(`window.__TAURI_INTERNALS__.invoke('get_status')`);
    if (s.service?.running && s.settings?.port === 3099) {
      console.log(`[start] READY after ~${(i + 1) * 2}s: ${s.service.url} pid=${s.service.pid}`);
      break;
    }
    if (i % 15 === 0) console.log(`[start] waiting… busy=${s.busy} running=${s.service?.running}`);
  }
  const after = await ev(`window.__TAURI_INTERNALS__.invoke('get_status')`);
  console.log("[start] final:", JSON.stringify({ running: after.service?.running, url: after.service?.url, pid: after.service?.pid, busy: after.busy }));

  // 4) check iframe now points at 3099
  await sleep(2000);
  console.log("[page] active view:", await ev(`document.querySelector('.view.active')?.id`));
  console.log("[page] iframe src:", await ev(`document.querySelector('#harness-frame')?.src`));

  // 5) verify the 3099 page loads (target check)
  const ts2 = await (await fetch("http://127.0.0.1:9222/json")).json();
  console.log("[page] CDP targets:", ts2.map((t) => `${t.type}|${t.url}`).join("  "));

  // 6) stop service
  console.log("[stop] invoking stop_service…");
  const stopResult = await invoke("stop_service");
  console.log("[stop] result:", stopResult);
  await sleep(3000);
  const s3 = await ev(`window.__TAURI_INTERNALS__.invoke('get_status')`);
  console.log("[stop] final:", JSON.stringify({ running: s3.service?.running, url: s3.service?.url, busy: s3.busy }));

  // restore port 3080
  const cur2 = await ev(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
  await invoke("set_settings", { settings: { ...cur2, port: 3080 } });
  console.log("[done]");
  ws.close();
})().catch((e) => {
  console.error("[FAIL]", e.message);
  process.exit(1);
});
