// Reload app page, explicitly reload iframe, then wait longer for its execution context.
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

  const contexts = [];
  const orig = ws.onmessage;
  ws.onmessage = (mEv) => {
    const m = JSON.parse(mEv.data);
    if (m.method === "Runtime.executionContextCreated" && m.params?.context?.auxData) {
      contexts.push(m.params.context);
    }
    orig(mEv);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.reload", { ignoreCache: true });
  await sleep(3000);
  // explicitly reload the iframe
  await ev(`document.querySelector('#btn-refresh').click()`);
  console.log("waiting for iframe context (up to 20s)…");
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const c = contexts.find((x) => (x.origin || "").includes("127.0.0.1"));
    if (c) {
      const res = await send("Runtime.evaluate", {
        contextId: c.id,
        expression: `JSON.stringify({ title: document.title, url: location.href, bodyLen: document.body.innerHTML.length })`,
        returnByValue: true,
      });
      console.log("IFRAME LOADED:", res?.result?.value ?? JSON.stringify(res));
      ws.close();
      return;
    }
  }
  console.log("contexts:", contexts.map((c) => `${c.id}:${c.origin}`).join(", "));
  console.log("IFRAME CONTEXT NOT FOUND");
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
