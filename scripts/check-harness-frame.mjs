// Listen for the harness-frame load event from within the app page.
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

  const result = await ev(`
    (async () => {
      const f = document.querySelector('#harness-frame');
      const before = f.src;
      const evt = await new Promise(res => {
        let done = false;
        const finish = (what) => { if (!done) { done = true; res(what); } };
        f.addEventListener('load', () => finish('load-event'));
        f.addEventListener('error', () => finish('error-event'));
        setTimeout(() => finish('timeout(6s)'), 6000);
        f.src = 'http://127.0.0.1:3080/';
      });
      return JSON.stringify({ before, after: f.src, evt });
    })()
  `);
  console.log("harness-frame:", result);
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
