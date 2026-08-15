// Check log console rendering and current nav structure.
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
  console.log(
    "log console rect:",
    await ev(`(() => { const r = document.querySelector('.log-console').getBoundingClientRect(); return JSON.stringify({w: r.width, h: r.height, top: r.top}); })()`)
  );
  console.log(
    "nav items:",
    await ev(`[...document.querySelectorAll('.nav-item')].map(n => n.textContent.trim().replace(/\\s+/g,' '))`)
  );
  console.log("active view:", await ev(`document.querySelector('.view.active')?.id`));
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
