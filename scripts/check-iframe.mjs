// Quick check: is the harness page embedded in the iframe?
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
  console.log("active view:", await ev("document.querySelector('.view.active')?.id"));
  console.log("iframe src:", await ev("document.querySelector('#harness-frame')?.src"));
  console.log("page overlay hidden:", await ev("document.querySelector('#page-overlay')?.hidden"));
  console.log("iframe title:", await ev("document.querySelector('#harness-frame')?.contentDocument?.title"));
  console.log("iframe body len:", await ev("document.querySelector('#harness-frame')?.contentDocument?.body?.innerHTML?.length"));
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
