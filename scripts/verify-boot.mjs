// Headless-Chrome boot verification for the OpenTTD WASM site.
// Usage: node scripts/verify-boot.mjs [url] [waitMs]
// Launches headless Chrome via CDP, waits for the game to boot, then reports
// the loading-box title, console errors, and saves a screenshot.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const url = process.argv[2] || "http://localhost:8931/";
const waitMs = Number(process.argv[3] || 45000);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  `--remote-debugging-port=${PORT}`,
  "--no-first-run",
  "--user-data-dir=/tmp/openttd-verify-profile",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("chrome devtools not reachable");
}

const consoleMessages = [];

async function main() {
  const wsUrl = await getTarget();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      consoleMessages.push(`[${msg.params.type}] ${text}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      consoleMessages.push(`[EXCEPTION] ${JSON.stringify(msg.params.exceptionDetails).slice(0, 500)}`);
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });

  console.log(`waiting ${waitMs / 1000}s for game to boot...`);
  await sleep(waitMs);

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  const report = await evalJs(`(() => ({
    title: document.getElementById("title")?.textContent ?? null,
    message: document.getElementById("message")?.textContent ?? null,
    boxError: document.getElementById("box")?.className ?? null,
    hasModule: typeof Module !== "undefined",
    hasCcall: typeof Module !== "undefined" && typeof Module.ccall === "function",
    kimiPanel: !!document.getElementById("kimi-panel"),
    kimiToggle: !!document.getElementById("kimi-toggle"),
  }))()`);

  // Try the WASM bridge if the runtime is up.
  const bridge = await evalJs(`(() => {
    try {
      if (typeof Module === "undefined" || typeof Module.ccall !== "function") return "ccall unavailable";
      const s = Module.ccall("em_openttd_state", "string", [], []);
      return s ? s.slice(0, 400) : "empty";
    } catch (e) { return "bridge error: " + e; }
  })()`);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const file = "/tmp/openttd-boot.png";
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));

  console.log(JSON.stringify({ report, bridge, screenshot: file }, null, 2));
  console.log("=== console messages (last 20) ===");
  consoleMessages.slice(-20).forEach((m) => console.log(m));

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
