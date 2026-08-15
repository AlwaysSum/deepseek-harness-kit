// Verify: two nav items, welcome logs, log console visible in control view, view switching.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let target;
  for (let i = 0; i < 30; i++) {
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

  console.log("nav items:", await ev(`[...document.querySelectorAll('.nav-item')].map(n => n.textContent.trim().replace(/\\s+/g, ' '))`));
  console.log("nav icon size:", await ev(`document.querySelector('.nav-item svg')?.getAttribute('width')`));
  console.log("logo size:", await ev(`getComputedStyle(document.querySelector('.logo')).width`));

  // welcome logs should exist in #log
  console.log("log lines on launch:", await ev(`document.querySelector('#log')?.childElementCount`));
  console.log("log text:", JSON.stringify(await ev(`document.querySelector('#log')?.innerText`)));

  // switch to control view and check log console has size
  await ev(`document.querySelector('#nav-console').click()`);
  await sleep(500);
  console.log("active view after nav-console:", await ev(`document.querySelector('.view.active')?.id`));
  console.log(
    "log console rect in control:",
    await ev(`(() => { const r = document.querySelector('.log-console').getBoundingClientRect(); return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }); })()`)
  );

  // switch to page view
  await ev(`document.querySelector('#nav-harness').click()`);
  await sleep(800);
  console.log("active view after nav-harness:", await ev(`document.querySelector('.view.active')?.id`));
  console.log("iframe src:", await ev(`document.querySelector('#harness-frame')?.src`));
  ws.close();
})().catch((e) => {
  console.error("[FAIL]", e.message);
  process.exit(1);
});
