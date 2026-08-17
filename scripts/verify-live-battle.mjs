// Minimal live-site battle probe: boots, checks em_openttd_action export,
// starts RemoteControl AI, acts as that company.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const url = process.argv[2] || "https://youngy620.github.io/openttd-web/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9337;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--no-first-run", "--user-data-dir=/tmp/openttd-verify-live", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
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
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __jsError: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
    return r.result?.result?.value;
  };
  const state = () => evalJs(`JSON.parse(Module.ccall("em_openttd_state", "string", [], []))`);
  const act = (obj) => evalJs(`JSON.parse(Module.ccall("em_openttd_action", "string", ["string"], [${JSON.stringify(JSON.stringify(obj))}]))`);
  const cmd = (c) => evalJs(`Module.ccall("em_openttd_console", null, ["string"], [${JSON.stringify(c)}]), "sent"`);

  let up = false;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const v = await evalJs(`typeof Module !== "undefined" && typeof Module.ccall === "function" && (() => { try { Module.ccall("em_openttd_action", "string", ["string"], ['{"action":"query_tile","x":1,"y":1}']); return true; } catch (e) { return false; } })()`);
    if (v === true) { up = true; break; }
    if (i % 10 === 9) console.log(`waiting for boot... ${(i + 1) * 2}s`);
  }
  if (!up) throw new Error("game did not boot within 180s");
  console.log("booted; action bridge exported: OK");

  await cmd("newgame");
  await sleep(15000);
  let s = await state();
  console.log("newgame:", JSON.stringify({ in_game: s.in_game, companies: s.companies?.length }));

  const eng = await act({ action: "list_engines", vehicle_type: "road" });
  console.log("action list_engines:", eng.ok, "count:", eng.engines?.length);

  await cmd("start_ai RemoteControl");
  await sleep(6000);
  s = await state();
  const ai = (s.companies || []).find((c) => c.is_ai);
  console.log("RemoteControl company:", ai ? `#${ai.index}` : "FAILED", "| act-as-AI:", JSON.stringify(await act({ action: "list_engines", vehicle_type: "road", company: ai?.index ?? -1 })).slice(0, 60));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync("/tmp/openttd-live-battle.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot: /tmp/openttd-live-battle.png");

  ws.close(); chrome.kill(); process.exit(0);
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
