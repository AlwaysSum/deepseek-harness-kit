// Connect to the harness OOPIF target and verify its rendered content.
(async () => {
  const ts = await (await fetch("http://127.0.0.1:9222/json")).json();
  const iframeTarget = ts.find((t) => t.type === "iframe" && t.url.includes("127.0.0.1:3080"));
  if (!iframeTarget) throw new Error("harness iframe target not found");
  const ws = new WebSocket(iframeTarget.webSocketDebuggerUrl);
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
  console.log("title:", await ev("document.title"));
  console.log("url:", await ev("location.href"));
  console.log(
    "body preview:",
    await ev("document.body?.innerText?.slice(0, 200)?.replace(/\\s+/g, ' ')")
  );
  console.log("react mounted:", await ev("!!document.querySelector('#root, [data-dsh], main, .app')"));
  ws.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
