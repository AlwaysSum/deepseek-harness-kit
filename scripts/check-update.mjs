// Verify sidebar bottom buttons, update modal flow, version footer.
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

  console.log("sidebar bottom buttons:", await ev(`[...document.querySelectorAll('.side-btn')].map(b => b.title)`));
  console.log("version footer:", await ev(`document.querySelector('#sidebar-footer')?.textContent`));

  // click update button -> modal opens, check_update runs
  await ev(`document.querySelector('#btn-sidebar-update').click()`);
  await sleep(1500);
  console.log("update modal hidden:", await ev(`document.querySelector('#modal-update').hidden`));
  console.log("update text:", await ev(`document.querySelector('#update-text')?.textContent`));

  // direct check_update invoke to see backend result
  const info = await ev(`window.__TAURI_INTERNALS__.invoke('check_update').then(i => JSON.stringify({ current: i.current, latest: i.latest, has_update: i.has_update, error: i.error }))`);
  console.log("check_update result:", info);

  // settings button opens settings modal
  await ev(`document.querySelector('#modal-update').hidden = true`);
  await ev(`document.querySelector('#btn-sidebar-settings').click()`);
  await sleep(500);
  console.log("settings modal hidden:", await ev(`document.querySelector('#modal-settings').hidden`));
  await ev(`document.querySelector('#modal-settings').hidden = true`);
  ws.close();
})().catch((e) => {
  console.error("[FAIL]", e.message);
  process.exit(1);
});
