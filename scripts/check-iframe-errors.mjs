// Reload iframe and capture console/network errors from WebView2.
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
  await send("Log.enable");
  await send("Network.enable");
  const events = [];
  const orig = ws.onmessage;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Log.entryAdded" || m.method === "Runtime.consoleAPICalled" || m.method === "Runtime.exceptionThrown") {
      events.push(JSON.stringify(m).slice(0, 400));
    }
    if (m.method === "Network.loadingFailed") {
      events.push(`loadingFailed: ${m.params.errorText} ${m.params.blockedReason || ""}`);
    }
    orig(ev);
  };

  // click the refresh button to reload the iframe
  await send("Runtime.evaluate", {
    expression: `document.querySelector('#btn-refresh').click()`,
    returnByValue: true,
  });
  await sleep(4000);

  console.log("events:", events.length ? events.join("\n") : "(none)");
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
