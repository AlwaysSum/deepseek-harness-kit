// Test: does the log console receive lines after start_service?
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

  // capture console errors
  await send("Runtime.enable");
  const errors = [];
  const orig = ws.onmessage;
  ws.onmessage = (mEv) => {
    const m = JSON.parse(mEv.data);
    if (m.method === "Runtime.exceptionThrown") {
      errors.push(m.params.exceptionDetails?.exception?.description || "exception");
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    orig(mEv);
  };

  console.log("log child count before:", await ev(`document.querySelector('#log')?.childElementCount`));
  console.log(
    "invoke start_service:",
    await ev(`window.__TAURI_INTERNALS__.invoke('start_service').then(() => 'OK', (e) => 'ERR: ' + e)`)
  );
  await sleep(3000);
  console.log("log child count after:", await ev(`document.querySelector('#log')?.childElementCount`));
  console.log("log text:", JSON.stringify(await ev(`document.querySelector('#log')?.innerText`)));
  console.log("js errors:", errors.length ? errors : "(none)");
  ws.close();
})().catch((e) => {
  console.error("[FAIL]", e.message);
  process.exit(1);
});
