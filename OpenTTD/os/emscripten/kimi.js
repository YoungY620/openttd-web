/*
 * Kimi AI player panel for OpenTTD (Emscripten build).
 *
 * Talks to Kimi (Moonshot AI) OpenAI-compatible chat-completions endpoints
 * using API keys configured by the user (stored in localStorage only,
 * never sent anywhere except the configured API base URL).
 *
 * The model drives the game through WASM bridge functions exported by the
 * patched engine:
 *   - em_openttd_state()    -> JSON snapshot of the running game
 *   - em_openttd_console()  -> executes an in-game console command
 *   - em_openttd_action()   -> executes a gameplay action as a given company
 *                              (build road/stop/depot, buy/start/sell vehicle, ...)
 *
 * Modes:
 *   - Co-pilot: chat / Think once / Autopilot for the local (human) company.
 *   - Battle:   N LLM agents each control their own company (created via the
 *               bundled "RemoteControl" placeholder AI) and play round-robin.
 */
(function () {
  "use strict";

  var LS_KEY = "kimi-openttd-settings-v1";

  var defaults = {
    baseUrl: "https://api.moonshot.cn/v1",
    apiKey: "",
    model: "kimi-k3",
    intervalSec: 45,
    autopilot: false,
    battle: {
      agents: [
        { name: "Agent A", model: "kimi-k3", apiKey: "" },
        { name: "Agent B", model: "kimi-k3", apiKey: "" },
      ],
      intervalSec: 60,
      running: false,
    },
  };

  var settings = loadSettings();
  var messages = []; // co-pilot chat history
  var running = false; // a co-pilot API turn is in flight
  var autopilotTimer = null;
  var gameReady = false;

  var battle = {
    round: 0,
    nextAgent: 0,
    timer: null,
    busy: false,
    histories: {}, // company index -> message array
  };

  function loadSettings() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        var merged = Object.assign({}, defaults, s);
        merged.battle = Object.assign({}, defaults.battle, s.battle || {});
        return merged;
      }
    } catch (e) { /* ignore */ }
    return JSON.parse(JSON.stringify(defaults));
  }

  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* WASM bridge helpers                                                */
  /* ------------------------------------------------------------------ */

  function bridgeAvailable() {
    return typeof Module !== "undefined" && typeof Module.ccall === "function" && gameReady;
  }

  function getGameState() {
    if (!bridgeAvailable()) return { error: "game engine not ready yet" };
    try {
      var json = Module.ccall("em_openttd_state", "string", [], []);
      return JSON.parse(json);
    } catch (e) {
      return { error: "failed to read game state: " + e };
    }
  }

  function runConsoleCommand(command) {
    if (!bridgeAvailable()) return "game engine not ready yet";
    try {
      Module.ccall("em_openttd_console", null, ["string"], [String(command)]);
      return "ok (console commands do not return output; use get_game_state to observe effects)";
    } catch (e) {
      return "error: " + e;
    }
  }

  function runGameAction(actionObj) {
    if (!bridgeAvailable()) return { ok: false, error: "game engine not ready yet" };
    try {
      var json = Module.ccall("em_openttd_action", "string", ["string"], [JSON.stringify(actionObj)]);
      return JSON.parse(json);
    } catch (e) {
      return { ok: false, error: "action bridge unavailable (needs latest game build): " + e };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tools                                                              */
  /* ------------------------------------------------------------------ */

  var toolGetState = {
    type: "function",
    function: {
      name: "get_game_state",
      description:
        "Get a JSON snapshot of the current OpenTTD game: date, paused flag, map size, all companies " +
        "(money, loan, value, income, expenses, AI/human, vehicle and station counts), top towns by " +
        "population and industry counts. Call this before making decisions.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };

  var toolConsole = {
    type: "function",
    function: {
      name: "run_console_command",
      description:
        "Execute one OpenTTD in-game console command. Useful commands: " +
        "'help', 'list_cmds', 'newgame', 'pause', 'unpause', 'save <name>', 'load <name>', " +
        "'list_settings <filter>', 'set <name> <value>', 'companies', 'list_ai', 'start_ai <name>', " +
        "'stop_ai <company#>', 'reload_ai <company#>', 'rescan_ai', 'list_gs', 'getdate', 'clear'. " +
        "Commands have no text output through this bridge; observe results with get_game_state.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The exact console command line." } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  };

  var toolAction = {
    type: "function",
    function: {
      name: "run_game_action",
      description:
        "Execute one gameplay action in OpenTTD as YOUR company. Actions (JSON arg 'action' plus params): " +
        "list_engines {vehicle_type:'road'|'rail'|'ship'|'aircraft'}; " +
        "query_tile {x,y}; find_town {name}; find_industries {x,y,radius,cargo?}; " +
        "build_road {x1,y1,x2,y2} (builds an L-shaped road between the tiles, X-first then Y); " +
        "build_road_stop {x,y,direction,truck:bool} and build_depot {x,y,direction}: place on a CLEAR tile " +
        "BESIDE the road (not on it); 'direction' is which side the entrance faces, i.e. from the stop/depot " +
        "tile toward the road: 'se' faces (x,y+1), 'nw' faces (x,y-1), 'ne' faces (x-1,y), 'sw' faces (x+1,y). " +
        "buy_vehicle {depot_x,depot_y,engine_id}; " +
        "add_order {vehicle_id,station_id,order_type:'goto'|'full_load'} (station_id from build_road_stop " +
        "or list_stations); " +
        "start_vehicle {vehicle_id}; stop_vehicle {vehicle_id}; sell_vehicle {vehicle_id}; " +
        "list_vehicles {}; list_stations {}. " +
        "Returns {ok:true,...} or {ok:false,error}. Coordinates are map tile coordinates.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string" },
        },
        additionalProperties: true,
      },
    },
  };

  function executeTool(name, argsJson, company) {
    var args = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch (e) { args = {}; }
    if (name === "get_game_state") return JSON.stringify(getGameState());
    if (name === "run_console_command") return JSON.stringify({ result: runConsoleCommand(args.command || "") });
    if (name === "run_game_action") {
      if (company !== undefined && company !== null && company >= 0) args.company = company;
      return JSON.stringify(runGameAction(args));
    }
    return JSON.stringify({ error: "unknown tool: " + name });
  }

  /* ------------------------------------------------------------------ */
  /* Kimi API                                                           */
  /* ------------------------------------------------------------------ */

  function apiRequest(opts, msgs, tools, onDone, onError) {
    var apiKey = opts.apiKey || settings.apiKey;
    if (!apiKey) {
      onError("No API key configured (panel settings, or per-agent key).");
      return;
    }
    var url = (opts.baseUrl || settings.baseUrl).replace(/\/+$/, "") + "/chat/completions";
    var body = {
      model: opts.model || settings.model,
      messages: msgs,
      temperature: 0.6,
      max_tokens: 4096,
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
    })
      .then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (t) { throw new Error("HTTP " + resp.status + ": " + t.slice(0, 500)); });
        }
        return resp.json();
      })
      .then(function (data) { onDone(data); })
      .catch(function (err) { onError(String(err && err.message ? err.message : err)); });
  }

  /* Run one full agent turn: up to maxRounds tool-call iterations. */
  function runAgentTurn(opts, onFinish) {
    var msgs = opts.messages;
    var tools = opts.tools;
    var company = opts.company;
    var onTool = opts.onTool || function () {};
    var rounds = 0;
    var maxRounds = opts.maxRounds || 8;

    function step() {
      apiRequest(opts, msgs, tools, function (data) {
        var choice = data.choices && data.choices[0];
        if (!choice || !choice.message) { onFinish("error: malformed API response"); return; }
        var msg = choice.message;
        msgs.push(msg);

        if (msg.tool_calls && msg.tool_calls.length > 0 && rounds < maxRounds) {
          rounds += 1;
          msg.tool_calls.forEach(function (tc) {
            var result = executeTool(tc.function.name, tc.function.arguments, company);
            onTool(tc.function.name, tc.function.arguments, result);
            msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
          });
          step();
          return;
        }
        onFinish(null, msg.content || "");
      }, function (err) { onFinish(err); });
    }
    step();
  }

  /* ------------------------------------------------------------------ */
  /* Co-pilot mode                                                      */
  /* ------------------------------------------------------------------ */

  var SYSTEM_PROMPT =
    "You are Kimi, an AI player embedded inside a real OpenTTD game running in the user's browser. " +
    "You observe the game with get_game_state and act through run_console_command and run_game_action.\n" +
    "Your role: co-pilot and strategist for the user's company. You can:\n" +
    "- analyze the economy/companies and give concrete, expert OpenTTD advice;\n" +
    "- build real transport routes via run_game_action (roads, stops, depots, vehicles, orders);\n" +
    "- start/stop/reload scripted AI competitors, tune settings, save/load games via run_console_command;\n" +
    "- explain mechanics (cargo chains, signals, town growth, subsidies) when asked.\n" +
    "Rules:\n" +
    "- Always check get_game_state before acting, and re-check after acting to confirm effects.\n" +
    "- If in_game is false, offer to start a game ('newgame') or wait for the user.\n" +
    "- Never run destructive commands (quit, restart, load, newgame) unless the user agreed first.\n" +
    "- Keep answers concise and practical. When on autopilot, act like a diligent assistant manager: " +
    "observe, fix problems, expand carefully, and report briefly what you did.";

  function runCopilot(text, isAutopilot, onFinish) {
    if (messages.length === 0) messages.push({ role: "system", content: SYSTEM_PROMPT });
    var content = text;
    if (isAutopilot) {
      content =
        "[Autopilot tick " + new Date().toLocaleTimeString() + "] Current game state:\n" +
        JSON.stringify(getGameState()) +
        "\nTake any useful actions now (or do nothing if all is well), then report briefly.";
    }
    messages.push({ role: "user", content: content });
    runAgentTurn(
      { messages: messages, tools: [toolGetState, toolConsole, toolAction], onTool: logTool },
      function (err, reply) { onFinish(err, reply); }
    );
  }

  /* ------------------------------------------------------------------ */
  /* Battle mode (agent vs agent)                                       */
  /* ------------------------------------------------------------------ */

  function battleSystemPrompt(agentName, company) {
    return (
      "You are " + agentName + ", an AI competitor in an OpenTTD agent-vs-agent battle. " +
      "You control company #" + company + " (your run_game_action calls automatically act as this company). " +
      "Other LLM agents control the rival companies; the winner has the highest company value.\n" +
      "Each of your turns you receive the full game state. Build a profitable transport company: " +
      "start with simple road routes (bus between towns, or coal/ore trucks from an industry to a " +
      "processing industry), then expand and diversify (rail for long/heavy routes). " +
      "Use list_engines to see vehicles you can buy, query_tile/find_town/find_industries to scout, " +
      "then build_road -> build_depot + build_road_stop -> buy_vehicle -> add_order -> start_vehicle.\n" +
      "Rules: spend carefully (watch money and loan), never give up, keep replies to 1-3 sentences. " +
      "If an action fails, read the error and adapt (terrain, money, existing road)."
    );
  }

  function aiCompanies(state) {
    return (state.companies || []).filter(function (c) { return c.is_ai; }).map(function (c) { return c.index; });
  }

  function startBattle() {
    var state = getGameState();
    if (state.error) { log("error", "Game not ready."); return; }
    log("info", "Battle: preparing companies...");
    if (!state.in_game) {
      runConsoleCommand("newgame");
      log("info", "Battle: new game started, generating map...");
      setTimeout(function () { setupBattleCompanies(0); }, 12000);
    } else {
      setupBattleCompanies(0);
    }
  }

  function setupBattleCompanies(attempt) {
    var wanted = settings.battle.agents.length;
    var state = getGameState();
    var ais = aiCompanies(state);
    if (ais.length < wanted && attempt < wanted * 3) {
      runConsoleCommand("start_ai RemoteControl");
      setTimeout(function () { setupBattleCompanies(attempt + 1); }, 4000);
      return;
    }
    state = getGameState();
    ais = aiCompanies(state);
    if (ais.length < wanted) {
      log("error", "Battle: could not create " + wanted + " AI companies (got " + ais.length + "). Check max_companies setting.");
      return;
    }
    settings.battle.agents.forEach(function (agent, i) {
      agent.company = ais[i];
      battle.histories[ais[i]] = [{ role: "system", content: battleSystemPrompt(agent.name, ais[i]) }];
    });
    battle.round = 0;
    battle.nextAgent = 0;
    settings.battle.running = true;
    saveSettings();
    updateBattleUI();
    log("info", "Battle started: " + settings.battle.agents.map(function (a) { return a.name + "=#" + a.company; }).join(" vs "));
    scheduleBattleTick(3000);
  }

  function stopBattle() {
    settings.battle.running = false;
    saveSettings();
    if (battle.timer) { clearTimeout(battle.timer); battle.timer = null; }
    updateBattleUI();
    log("info", "Battle stopped.");
  }

  function scheduleBattleTick(delayMs) {
    if (battle.timer) clearTimeout(battle.timer);
    if (!settings.battle.running) return;
    battle.timer = setTimeout(runBattleTick, delayMs);
  }

  function runBattleTick() {
    if (!settings.battle.running || battle.busy) return;
    var agents = settings.battle.agents;
    var agent = agents[battle.nextAgent % agents.length];
    battle.nextAgent += 1;
    if (battle.nextAgent % agents.length === 1) battle.round += 1;
    if (agent.company === undefined || agent.company === null) { scheduleBattleTick(5000); return; }

    battle.busy = true;
    updateBattleUI();
    var state = getGameState();
    updateScoreboard(state);
    var hist = battle.histories[agent.company] ||
      (battle.histories[agent.company] = [{ role: "system", content: battleSystemPrompt(agent.name, agent.company) }]);
    // Keep history bounded: system + last 12 messages.
    if (hist.length > 13) hist.splice(1, hist.length - 13);

    hist.push({
      role: "user",
      content: "[Round " + battle.round + "] Game state:\n" + JSON.stringify(state) + "\nYour move.",
    });

    runAgentTurn(
      {
        messages: hist,
        tools: [toolGetState, toolAction],
        company: agent.company,
        model: agent.model,
        apiKey: agent.apiKey,
        maxRounds: 6,
        onTool: function (name, args, result) { logTool(agent.name + ": " + name, args, result); },
      },
      function (err, reply) {
        battle.busy = false;
        if (err) log("error", agent.name + " error: " + err);
        else log("assistant", agent.name + " (#" + agent.company + "): " + reply);
        updateScoreboard(getGameState());
        scheduleBattleTick(Math.max(20, Number(settings.battle.intervalSec) || 60) * 1000);
      }
    );
  }

  function updateScoreboard(state) {
    if (!els.scoreboard || !state || !state.companies) return;
    var parts = settings.battle.agents.map(function (a) {
      var c = state.companies.find(function (x) { return x.index === a.company; });
      return a.name + ": " + (c ? "£" + Number(c.company_value).toLocaleString() : "?");
    });
    els.scoreboard.textContent = "Round " + battle.round + " | " + parts.join(" | ");
  }

  /* ------------------------------------------------------------------ */
  /* UI                                                                 */
  /* ------------------------------------------------------------------ */

  var els = {};

  function el(tag, attrs, parent) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") node.textContent = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function log(role, text) {
    var div = el("div", { class: "kimi-msg kimi-" + role }, els.log);
    div.textContent = text;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function logTool(name, args, result) {
    var div = el("div", { class: "kimi-msg kimi-tool" }, els.log);
    var short = args;
    try { short = JSON.stringify(JSON.parse(args)); } catch (e) { /* keep raw */ }
    div.textContent = "⚙ " + name + "(" + short + ")";
    div.title = result;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function buildUI() {
    var css = document.createElement("style");
    css.textContent =
      "#kimi-toggle{position:fixed;right:12px;bottom:12px;z-index:9999;background:#3a3a3a;color:#fcfcfc;" +
      "border:1px solid #a8a8a8;border-radius:4px;padding:8px 12px;font:bold 13px Tahoma,Arial,sans-serif;" +
      "cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.5)}" +
      "#kimi-toggle:hover{background:#4a4a4a}" +
      "#kimi-panel{position:fixed;right:12px;bottom:56px;width:420px;max-width:calc(100vw - 24px);height:74vh;" +
      "z-index:9999;background:#1e1e1e;color:#e8e8e8;border:1px solid #a8a8a8;border-radius:6px;display:none;" +
      "flex-direction:column;font:13px/1.4 Tahoma,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.6)}" +
      "#kimi-panel.open{display:flex}" +
      "#kimi-panel .kimi-head{padding:8px 10px;background:#3a3a3a;border-bottom:1px solid #555;" +
      "font-weight:bold;display:flex;justify-content:space-between;align-items:center}" +
      "#kimi-panel .kimi-head button{background:none;border:none;color:#aaa;cursor:pointer;font-size:14px}" +
      "#kimi-settings{padding:8px 10px;border-bottom:1px solid #444;display:none;flex-direction:column;gap:6px;max-height:45%;overflow-y:auto}" +
      "#kimi-settings.open{display:flex}" +
      "#kimi-settings label{display:flex;align-items:center;gap:6px;white-space:nowrap}" +
      "#kimi-settings label span{width:78px;color:#aaa}" +
      "#kimi-settings input{flex:1;background:#111;color:#eee;border:1px solid #555;border-radius:3px;padding:4px 6px;min-width:0}" +
      "#kimi-settings .kimi-sep{color:#c8b26a;font-size:12px;margin-top:4px}" +
      "#kimi-status{padding:4px 10px;color:#8bc34a;border-bottom:1px solid #444;font-size:12px;min-height:16px}" +
      "#kimi-score{padding:4px 10px;color:#ffd54f;border-bottom:1px solid #444;font-size:12px;display:none}" +
      "#kimi-log{flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:6px}" +
      ".kimi-msg{white-space:pre-wrap;word-break:break-word;border-radius:4px;padding:5px 8px}" +
      ".kimi-user{background:#2f4f6f;align-self:flex-end;max-width:90%}" +
      ".kimi-assistant{background:#2b2b2b}" +
      ".kimi-tool{background:#33302a;color:#c8b26a;font-size:12px;cursor:help}" +
      ".kimi-error{background:#5f2f2f}" +
      ".kimi-info{background:#26343a;color:#9fc5d8;font-size:12px}" +
      "#kimi-controls{display:flex;gap:6px;padding:6px 10px;border-top:1px solid #444;align-items:center;flex-wrap:wrap}" +
      "#kimi-controls input[type=text]{flex:1;background:#111;color:#eee;border:1px solid #555;border-radius:3px;padding:6px;min-width:120px}" +
      "#kimi-controls button{background:#3a3a3a;color:#eee;border:1px solid #777;border-radius:3px;padding:6px 10px;cursor:pointer}" +
      "#kimi-controls button:hover{background:#4a4a4a}" +
      "#kimi-controls button.active{background:#2e6b2e;border-color:#5cb85c}";
    document.head.appendChild(css);

    els.toggle = el("button", { id: "kimi-toggle", text: "Kimi AI" }, document.body);
    els.panel = el("div", { id: "kimi-panel" }, document.body);

    var head = el("div", { class: "kimi-head" }, els.panel);
    el("span", { text: "Kimi K3 AI Player" }, head);
    var headBtns = el("span", {}, head);
    els.settingsBtn = el("button", { text: "⚙", title: "Settings" }, headBtns);
    els.closeBtn = el("button", { text: "✕", title: "Close" }, headBtns);

    els.settingsDiv = el("div", { id: "kimi-settings" }, els.panel);
    function settingRow(label, key, type, placeholder, obj) {
      var target = obj || settings;
      var lab = el("label", {}, els.settingsDiv);
      el("span", { text: label }, lab);
      var inp = el("input", { type: type || "text", placeholder: placeholder || "" }, lab);
      inp.value = target[key];
      inp.addEventListener("change", function () {
        target[key] = type === "number" ? Number(inp.value) : inp.value;
        saveSettings();
      });
      return inp;
    }
    settingRow("API base", "baseUrl", "text", "https://api.moonshot.cn/v1");
    settingRow("API key", "apiKey", "password", "sk-...");
    settingRow("Model", "model", "text", "kimi-k3");
    settingRow("Tick (sec)", "intervalSec", "number");
    el("div", { class: "kimi-sep", text: "Battle agents (key empty = use main key)" }, els.settingsDiv);
    settings.battle.agents.forEach(function (agent, i) {
      settingRow("Agent " + (i + 1) + " name", "name", "text", "", agent);
      settingRow("  model", "model", "text", "kimi-k3", agent);
      settingRow("  api key", "apiKey", "password", "(main key)", agent);
    });
    settingRow("Battle tick", "intervalSec", "number", "60", settings.battle);

    els.status = el("div", { id: "kimi-status", text: "idle" }, els.panel);
    els.scoreboard = el("div", { id: "kimi-score" }, els.panel);
    els.log = el("div", { id: "kimi-log" }, els.panel);

    var controls = el("div", { id: "kimi-controls" }, els.panel);
    els.input = el("input", { type: "text", placeholder: "Ask Kimi about your game..." }, controls);
    els.askBtn = el("button", { text: "Ask" }, controls);
    els.thinkBtn = el("button", { text: "Think once" }, controls);
    els.autoBtn = el("button", { text: "Autopilot: off" }, controls);
    els.battleBtn = el("button", { text: "Battle: off", title: "Start an agent-vs-agent battle" }, controls);

    els.toggle.addEventListener("click", function () { els.panel.classList.toggle("open"); });
    els.closeBtn.addEventListener("click", function () { els.panel.classList.remove("open"); });
    els.settingsBtn.addEventListener("click", function () { els.settingsDiv.classList.toggle("open"); });

    function ask() {
      var text = els.input.value.trim();
      if (!text || running) return;
      els.input.value = "";
      log("user", text);
      runCopilotInteractive(text);
    }
    els.askBtn.addEventListener("click", ask);
    els.input.addEventListener("keydown", function (e) { if (e.key === "Enter") ask(); });

    els.thinkBtn.addEventListener("click", function () {
      if (running) return;
      runCopilotInteractive(
        "Look at the current game state and tell me the most useful thing to do next. " +
        "You may take the action yourself if it is safe."
      );
    });

    els.autoBtn.addEventListener("click", function () {
      settings.autopilot = !settings.autopilot;
      saveSettings();
      updateAutopilot();
    });

    els.battleBtn.addEventListener("click", function () {
      if (settings.battle.running) stopBattle();
      else startBattle();
    });

    log("info",
      "Configure your Moonshot API key in ⚙ settings. Co-pilot: chat / Think once / Autopilot. " +
      "Battle: agents each drive their own company. Keys stay in this browser (localStorage).");
    updateAutopilot();
    updateBattleUI();
  }

  function runCopilotInteractive(text) {
    if (running) return;
    running = true;
    setStatus("thinking...");
    runCopilot(text, false, function (err, reply) {
      running = false;
      if (err) { log("error", "Error: " + err); setStatus("error"); }
      else { log("assistant", reply); setStatus("idle"); }
    });
  }

  function runAutopilotTick() {
    if (running || !settings.autopilot) return;
    running = true;
    setStatus("autopilot thinking...");
    runCopilot("", true, function (err, reply) {
      running = false;
      if (err) { log("error", "Autopilot error: " + err); setStatus("autopilot error"); }
      else { log("assistant", reply); setStatus("autopilot on"); }
    });
  }

  function updateAutopilot() {
    if (autopilotTimer) { clearInterval(autopilotTimer); autopilotTimer = null; }
    els.autoBtn.textContent = "Autopilot: " + (settings.autopilot ? "on" : "off");
    els.autoBtn.classList.toggle("active", settings.autopilot);
    if (settings.autopilot) {
      var ms = Math.max(15, Number(settings.intervalSec) || 45) * 1000;
      autopilotTimer = setInterval(runAutopilotTick, ms);
      runAutopilotTick();
      setStatus("autopilot on");
    } else {
      setStatus("idle");
    }
  }

  function updateBattleUI() {
    els.battleBtn.textContent = "Battle: " + (settings.battle.running ? "on" : "off");
    els.battleBtn.classList.toggle("active", settings.battle.running);
    els.scoreboard.style.display = settings.battle.running ? "block" : "none";
    if (settings.battle.running) setStatus(battle.busy ? "battle: agent thinking..." : "battle running");
  }

  /* ------------------------------------------------------------------ */
  /* Boot: wait until the game runtime is ready                         */
  /* ------------------------------------------------------------------ */

  function init() {
    buildUI();
    if (typeof Module !== "undefined" && Array.isArray(Module.postRun)) {
      Module.postRun.push(function () {
        gameReady = true;
        setStatus("game engine ready");
      });
    } else {
      var poll = setInterval(function () {
        if (typeof Module !== "undefined" && typeof Module.ccall === "function") {
          clearInterval(poll);
          gameReady = true;
          setStatus("game engine ready");
        }
      }, 1000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
