// Full gameplay-chain test for em_openttd_action:
// newgame -> list engines -> scout towns -> build road -> depot -> stops ->
// buy vehicle -> orders -> start vehicle -> verify state. Also tests acting
// as a RemoteControl (battle) company via the "company" parameter.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const url = process.argv[2] || "http://localhost:8931/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9335;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--no-first-run", "--user-data-dir=/tmp/openttd-verify-actions", "about:blank",
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
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __jsError: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
    return r.result?.result?.value;
  };
  const state = () => evalJs(`JSON.parse(Module.ccall("em_openttd_state", "string", [], []))`);
  const act = (obj) => evalJs(`JSON.parse(Module.ccall("em_openttd_action", "string", ["string"], [${JSON.stringify(JSON.stringify(obj))}]))`);
  const cmd = (c) => evalJs(`Module.ccall("em_openttd_console", null, ["string"], [${JSON.stringify(c)}]), "sent"`);

  // Wait for boot.
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const v = await evalJs(`typeof Module !== "undefined" && typeof Module.ccall === "function" && (() => { try { Module.ccall("em_openttd_action", "string", ["string"], ['{"action":"query_tile","x":1,"y":1}']); return true; } catch (e) { return false; } })()`);
    if (v === true) { up = true; break; }
  }
  if (!up) throw new Error("game did not boot within 120s");
  console.log("booted, action bridge reachable");

  await cmd("newgame");
  await sleep(15000);
  let s = await state();
  console.log("newgame:", JSON.stringify({ in_game: s.in_game, towns: s.town_count, companies: s.companies?.length }));
  const t0 = s.towns[0].name, t1 = s.towns[1].name;

  const engines = await act({ action: "list_engines", vehicle_type: "road" });
  console.log("engines:", engines.ok, "count:", engines.engines?.length, JSON.stringify(engines.engines?.[0]));
  const engineId = engines.engines?.[0]?.id;

  const townA = await act({ action: "find_town", name: t0 });
  const townB = await act({ action: "find_town", name: t1 });
  console.log("townA:", JSON.stringify(townA), "townB:", JSON.stringify(townB));

  // Scout east of town A for a straight row of 8 clear tiles (like the LLM would).
  let row = null;
  outer: for (let y = townA.y - 10; y < townA.y + 10; y++) {
    for (let x = townA.x; x < townA.x + 40; x++) {
      let clear = 0;
      for (let i = 0; i < 8; i++) {
        const q = await act({ action: "query_tile", x: x + i, y });
        if (q.type !== "clear") { clear = 0; break; }
        clear++;
      }
      if (clear === 8) { row = { x, y }; break outer; }
    }
  }
  console.log("clear row:", JSON.stringify(row));

  const road = await act({ action: "build_road", x1: row.x, y1: row.y, x2: row.x + 7, y2: row.y });
  console.log("build_road:", JSON.stringify(road));

  // Depot/stops go on clear tiles beside the road, entrance facing the road.
  const depot = await act({ action: "build_depot", x: row.x + 1, y: row.y - 1, direction: "se" });
  console.log("build_depot:", JSON.stringify(depot));

  let stopA = await act({ action: "build_road_stop", x: row.x + 3, y: row.y - 1, direction: "se", truck: false });
  if (!stopA.ok) stopA = await act({ action: "build_road_stop", x: row.x + 3, y: row.y + 1, direction: "nw", truck: false });
  console.log("stopA:", JSON.stringify(stopA));
  let stopB = await act({ action: "build_road_stop", x: row.x + 5, y: row.y - 1, direction: "se", truck: false });
  if (!stopB.ok) stopB = await act({ action: "build_road_stop", x: row.x + 5, y: row.y + 1, direction: "nw", truck: false });
  console.log("stopB:", JSON.stringify(stopB));

  const buy = await act({ action: "buy_vehicle", depot_x: row.x + 1, depot_y: row.y - 1, engine_id: engineId });
  console.log("buy_vehicle:", JSON.stringify(buy));

  if (buy.ok) {
    console.log("orderA:", JSON.stringify(await act({ action: "add_order", vehicle_id: buy.vehicle_id, station_id: stopA.station_id, order_type: "full_load" })));
    console.log("orderB:", JSON.stringify(await act({ action: "add_order", vehicle_id: buy.vehicle_id, station_id: stopB.station_id })));
    console.log("start:", JSON.stringify(await act({ action: "start_vehicle", vehicle_id: buy.vehicle_id })));
    console.log("list_vehicles:", JSON.stringify(await act({ action: "list_vehicles" })));
    console.log("list_stations:", JSON.stringify(await act({ action: "list_stations" })));
  }

  // Battle-company impersonation: create a RemoteControl company and act as it.
  await cmd("start_ai RemoteControl");
  await sleep(6000);
  s = await state();
  const ai = (s.companies || []).find((c) => c.is_ai);
  console.log("AI company:", JSON.stringify(ai && { index: ai.index, name: ai.name, is_ai: ai.is_ai }));
  if (ai) {
    const asAi = await act({ action: "list_engines", vehicle_type: "road", company: ai.index });
    console.log("act-as-AI list_engines:", asAi.ok, "count:", asAi.engines?.length);
    const badCompany = await act({ action: "list_engines", vehicle_type: "road", company: 99 });
    console.log("invalid company rejected:", JSON.stringify(badCompany));
  }

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync("/tmp/openttd-actions.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot: /tmp/openttd-actions.png");

  ws.close(); chrome.kill(); process.exit(0);
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
