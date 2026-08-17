// Console-bridge gameplay smoke test: boots the game, starts a new game via
// em_openttd_console("newgame"), pauses/unpauses, and validates state changes.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const url = process.argv[2] || "http://localhost:8931/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--no-first-run", "--user-data-dir=/tmp/openttd-verify-profile2", "about:blank",
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
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });

  // Wait until ccall is available (game booted).
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const r = await send("Runtime.evaluate", { expression: `typeof Module !== "undefined" && typeof Module.ccall === "function" && (() => { try { Module.ccall("em_openttd_state", "string", [], []); return true; } catch (e) { return false; } })()`, returnByValue: true });
    if (r.result?.result?.value === true) { up = true; break; }
  }
  if (!up) throw new Error("game did not boot within 120s");
  console.log("booted. starting new game via console bridge...");

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };
  const state = () => evalJs(`JSON.parse(Module.ccall("em_openttd_state", "string", [], []))`);
  const cmd = (c) => evalJs(`Module.ccall("em_openttd_console", null, ["string"], [${JSON.stringify(c)}]), "sent"`);

  console.log("cmd newgame:", await cmd("newgame"));
  await sleep(15000); // map generation takes a moment

  let s = await state();
  console.log("after newgame:", JSON.stringify({ in_game: s.in_game, year: s.date?.year, map: [s.map_x, s.map_y], companies: (s.companies || []).length, towns: s.town_count, industries: s.industry_count, local_company: s.local_company }));

  console.log("cmd pause:", await cmd("pause"));
  await sleep(1000);
  s = await state();
  console.log("paused?", s.paused);
  console.log("cmd unpause:", await cmd("unpause"));
  await sleep(1000);
  s = await state();
  console.log("paused?", s.paused, "| money:", s.companies?.[0]?.money, "| name:", s.companies?.[0]?.name);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync("/tmp/openttd-newgame.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot: /tmp/openttd-newgame.png");
  console.log("js exceptions:", errors.length ? errors : "none");

  ws.close(); chrome.kill(); process.exit(0);
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
