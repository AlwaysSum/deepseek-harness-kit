// Verify the light/white theme is applied.
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
  const out = await ev(`JSON.stringify({
    bodyBg: getComputedStyle(document.body).backgroundColor,
    sidebarBg: getComputedStyle(document.querySelector('#sidebar')).backgroundColor,
    titleColor: getComputedStyle(document.querySelector('.panel-title h1')).color,
    btnBg: getComputedStyle(document.querySelector('#btn-primary')).backgroundImage,
    cardBg: getComputedStyle(document.querySelector('.card')).backgroundColor,
    textColor: getComputedStyle(document.querySelector('.card-detail')).color,
    logBg: getComputedStyle(document.querySelector('.log-console')).backgroundColor,
  })`);
  console.log(JSON.stringify(JSON.parse(out), null, 2));
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
