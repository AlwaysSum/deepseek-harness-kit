// Inspect frame tree and iframe element state via CDP.
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

  await send("Page.enable");
  const tree = await send("Page.getFrameTree");
  const walk = (f, depth) => {
    console.log(`${"  ".repeat(depth)}frame id=${f.frame.id.slice(0, 12)} url=${(f.frame.url || "").slice(0, 90)}`);
    for (const c of f.childFrames || []) walk(c, depth + 1);
  };
  if (tree?.frameTree) walk(tree.frameTree, 0);

  console.log("active view:", await ev("document.querySelector('.view.active')?.id"));
  console.log("iframe src:", await ev("document.querySelector('#harness-frame')?.src"));
  console.log("iframe attrs:", await ev("document.querySelector('#harness-frame')?.outerHTML?.slice(0,200)"));
  console.log("service pill:", await ev("document.querySelector('#status-pill')?.textContent"));
  console.log("primary btn:", await ev("document.querySelector('#btn-primary')?.textContent"));
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
