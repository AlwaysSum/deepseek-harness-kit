// End-to-end smoke test for dsh-desktop via WebView2 CDP.
// Usage: node scripts/test-cdp.mjs [--deploy] [--port 9222]
// Requires the app launched with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const doDeploy = args.includes("--deploy");
const portIdx = args.indexOf("--port");
const cdpPort = Number(portIdx >= 0 ? args[portIdx + 1] : 9222) || 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error("ws error: " + e.message));
  });
}

let msgId = 0;
const pending = new Map();
function send(ws, method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 30000);
  });
}

function wire(ws) {
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };
}

async function evalJs(ws, expression, awaitPromise = true) {
  const res = await send(ws, "Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error("page exception: " + JSON.stringify(res.exceptionDetails).slice(0, 500));
  }
  return res.result?.value;
}

async function main() {
  // 1) wait for the app webview target
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await getTargets();
      target = targets.find((t) => t.type === "page" && /tauri|localhost|127\.0\.0\.1/.test(t.url));
      if (target) break;
    } catch {}
    await sleep(1000);
  }
  if (!target) throw new Error("app webview target not found on CDP port " + cdpPort);

  const ws = await connect(target.webSocketDebuggerUrl);
  wire(ws);
  await send(ws, "Runtime.enable");

  // 2) basic UI checks
  const title = await evalJs(ws, "document.title");
  const sidebar = await evalJs(ws, "!!document.querySelector('#sidebar')");
  const navBtn = await evalJs(ws, "document.querySelector('#nav-harness')?.textContent?.trim()");
  console.log(`[ui] title=${JSON.stringify(title)} sidebar=${sidebar} nav=${JSON.stringify(navBtn)}`);
  if (!sidebar || !navBtn) throw new Error("UI did not render sidebar/nav");

  // 3) get_status
  const status = await evalJs(
    ws,
    `window.__TAURI_INTERNALS__.invoke('get_status').then(s => ({
      node: s.node, dsh: s.dsh,
      service: s.service, busy: s.busy, port: s.settings.port }))`
  );
  console.log("[status]", JSON.stringify(status, null, 2));
  if (status.service?.running) {
    console.log("[status] service already running on port " + status.port);
  }

  if (!doDeploy) {
    console.log("[ok] smoke test passed (no deploy requested)");
    ws.close();
    return;
  }

  // 4) trigger deploy and watch logs until busy clears
  console.log("[deploy] invoking deploy…");
  await evalJs(ws, `window.__TAURI_INTERNALS__.invoke('deploy', { force: false })`, false);
  // capture console output
  const logs = [];
  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.consoleAPICalled") {
        logs.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    } catch {}
  });
  await send(ws, "Runtime.enable");

  // poll status until not busy
  let last = "";
  for (let i = 0; i < 2400; i++) {
    await sleep(5000);
    let s;
    try {
      s = await evalJs(ws, `window.__TAURI_INTERNALS__.invoke('get_status')`);
    } catch {
      continue;
    }
    const line = `[poll ${(i * 5).toFixed(0)}s] busy=${s.busy} node=${s.node?.ok} dsh=${s.dsh?.ready} service=${s.service?.running}`;
    if (line !== last) {
      console.log(line);
      last = line;
    }
    if (s.busy === false && s.dsh?.ready) break;
    if (s.busy === false && !s.dsh?.ready && i > 5) {
      console.error("[deploy] deploy seems to have failed early (dsh not ready)");
      process.exitCode = 1;
      break;
    }
  }

  const final = await evalJs(ws, `window.__TAURI_INTERNALS__.invoke('get_status')`);
  console.log("[final]", JSON.stringify({ dsh: final.dsh, service: final.service, busy: final.busy }, null, 2));
  console.log("[logs tail]", logs.slice(-30).join("\n"));
  console.log("[done]");
  ws.close();
}

main().catch((e) => {
  console.error("[FAIL]", e);
  process.exit(1);
});
