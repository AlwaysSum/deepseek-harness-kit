// Remove leftover test iframes from the app DOM.
(async () => {
  const ts = await (await fetch("http://127.0.0.1:9222/json")).json();
  const t = ts.find((x) => x.type === "page" && /tauri|localhost/.test(x.url));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const p = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) {
      p.get(m.id)(m.result);
      p.delete(m.id);
    }
  };
  const s = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      p.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const r = await s("Runtime.evaluate", {
    expression: `document.querySelector('#test-example')?.remove(); 'cleaned'`,
    returnByValue: true,
  });
  console.log(r.result.value);
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
