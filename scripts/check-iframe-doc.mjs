// Determine what the harness-frame actually contains, and whether ANY http iframe executes.
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

  // 1) harness-frame contentDocument (readable => blank/error page)
  const doc = await ev(`
    (() => {
      const f = document.querySelector('#harness-frame');
      try {
        const d = f.contentDocument;
        if (!d) return 'contentDocument: null (cross-origin, real page loaded)';
        const html = d.documentElement?.outerHTML || '';
        return 'contentDocument READABLE, len=' + html.length + ', head=' + html.slice(0, 200);
      } catch (e) { return 'contentDocument threw: ' + e.message; }
    })()
  `);
  console.log("[harness-frame]", doc);

  // 2) dynamic iframe to example.com — check context + contentDocument
  const ex = await ev(`
    (async () => {
      const f = document.createElement('iframe');
      f.id = 'test-example';
      document.body.appendChild(f);
      await new Promise(res => { f.onload = res; f.onerror = res; setTimeout(res, 5000); f.src = 'http://example.com/'; });
      try {
        const d = f.contentDocument;
        if (!d) return 'example.com: contentDocument null (cross-origin)';
        return 'example.com: READABLE len=' + (d.documentElement?.outerHTML?.length || 0) + ' title=' + d.title;
      } catch (e) { return 'example.com threw: ' + e.message; }
    })()
  `);
  console.log("[example.com]", ex);
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
