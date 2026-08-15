// Verify the iframe (http://127.0.0.1:3080) actually loaded by evaluating in its CDP execution context.
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

  await send("Runtime.enable");
  const contexts = [];
  const origOnMessage = ws.onmessage;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.executionContextCreated" && m.params?.context?.auxData?.frameId) {
      contexts.push(m.params.context);
    }
    origOnMessage(ev);
  };
  await sleep(1500);
  console.log("execution contexts:");
  for (const c of contexts) {
    console.log(`  id=${c.id} origin=${c.origin} url=${(c.auxData?.url || "").slice(0, 80)}`);
  }
  const frameCtx = contexts.find((c) => (c.origin || "").includes("127.0.0.1"));
  if (frameCtx) {
    const res = await send("Runtime.evaluate", {
      contextId: frameCtx.id,
      expression: `JSON.stringify({ title: document.title, h1: document.querySelector('h1,title,header')?.textContent?.trim().slice(0,60), bodyLen: document.body.innerHTML.length, url: location.href })`,
      returnByValue: true,
    });
    console.log("iframe content:", res?.result?.value ?? JSON.stringify(res));
  } else {
    console.log("iframe context NOT found — iframe may be blocked (mixed content / CSP)");
  }
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
