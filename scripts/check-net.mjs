// Determine if network access works from the tauri page (fetch) vs iframe navigation being blocked.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let target;
  for (let i = 0; i < 20; i++) {
    try {
      const ts = await (await fetch("http://127.0.0.1:9222/json")).json();
      target = ts.find((t) => t.type === "page" && /tauri|localhost/.test(t.url));
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

  console.log("location.href:", await ev("location.href"));
  console.log(
    "fetch 127.0.0.1:3080:",
    await ev(
      `fetch('http://127.0.0.1:3080/').then(r => 'HTTP ' + r.status).catch(e => 'ERR ' + e.message)`
    )
  );
  console.log(
    "iframe load event:",
    await ev(
      `new Promise(res => { const f = document.createElement('iframe'); f.onload = () => res('loaded'); f.onerror = () => res('error'); f.src = 'http://127.0.0.1:3080/'; setTimeout(() => res('timeout-no-event'), 4000); document.body.appendChild(f); })`
    )
  );
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
