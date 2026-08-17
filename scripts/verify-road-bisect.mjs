// Bisect the build_road std::bad_alloc: build tile-by-tile on a clear row.
import { spawn } from "node:child_process";

const url = process.argv[2] || "http://localhost:8931/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9336;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--no-first-run", "--user-data-dir=/tmp/openttd-verify-bisect", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await res.json()).find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { }
    await sleep(500);
  }
  throw new Error("devtools not reachable");
}

async function main() {
  const ws = new WebSocket(await getTarget());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      if (text.includes("[kimi]")) console.log("  console:", text);
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable");
  await send("Page.navigate", { url });

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __jsError: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
    return r.result?.result?.value;
  };
  const act = (obj) => evalJs(`JSON.parse(Module.ccall("em_openttd_action", "string", ["string"], [${JSON.stringify(JSON.stringify(obj))}]))`);
  const cmd = (c) => evalJs(`Module.ccall("em_openttd_console", null, ["string"], [${JSON.stringify(c)}]), "sent"`);

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const v = await evalJs(`typeof Module !== "undefined" && typeof Module.ccall === "function" && (() => { try { Module.ccall("em_openttd_state", "string", [], []); return true; } catch (e) { return false; } })()`);
    if (v === true) { up = true; break; }
  }
  if (!up) throw new Error("no boot");

  await cmd("newgame");
  await sleep(15000);

  // Pick a row clear of everything near map center.
  const state = await evalJs(`JSON.parse(Module.ccall("em_openttd_state", "string", [], []))`);
  const cy = Math.floor(state.map_y / 2);
  let row = null;
  outer: for (let y = cy - 20; y < cy + 20; y++) {
    for (let x = 20; x < state.map_x - 30; x++) {
      let ok = true;
      for (let i = 0; i < 6; i++) {
        const q = await act({ action: "query_tile", x: x + i, y });
        if (q.type !== "clear") { ok = false; break; }
      }
      if (ok) { row = { x, y }; break outer; }
    }
  }
  console.log("row:", JSON.stringify(row));

  for (let i = 0; i < 5; i++) {
    const r = await act({ action: "build_road", x1: row.x + i, y1: row.y, x2: row.x + i + 1, y2: row.y });
    console.log(`tile ${row.x + i}->${row.x + i + 1}:`, JSON.stringify(r));
  }
  // Also single-tile calls.
  for (let i = 0; i < 3; i++) {
    const r = await act({ action: "build_road", x1: 30 + i, y1: row.y + 3, x2: 30 + i, y2: row.y + 3 });
    console.log(`single ${30 + i}:`, JSON.stringify(r));
  }

  ws.close(); chrome.kill(); process.exit(0);
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
