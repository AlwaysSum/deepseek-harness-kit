// Final check: modal & overlay hidden on launch, status ok.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let target;
  for (let i = 0; i < 20; i++) {
    try {
      const ts = await (await fetch("http://127.0.0.1:9222/json")).json();
      target = ts.find((t) => t.type === "page" && /tauri/.test(t.url));
      if (target) break;
    } catch {}
    await sleep(500);
  }
  if (!target) throw new Error("no target");
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
  console.log("modal display:", await ev("getComputedStyle(document.querySelector('#modal-settings')).display"));
  console.log("overlay display:", await ev("getComputedStyle(document.querySelector('#page-overlay')).display"));
  console.log("status pill:", await ev("document.querySelector('#status-pill')?.textContent"));
  console.log("dsh badge:", await ev("document.querySelector('#badge-dsh')?.textContent"));
  console.log("dsh detail:", await ev("document.querySelector('#detail-dsh')?.textContent"));
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
