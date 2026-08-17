/*
 * Kimi AI player panel for OpenTTD (Emscripten build).
 *
 * Talks to a Kimi (Moonshot AI) OpenAI-compatible chat-completions endpoint
 * using an API key configured by the user (stored in localStorage only,
 * never sent anywhere except the configured API base URL).
 *
 * The model drives the game through two WASM bridge functions exported by
 * the patched engine:
 *   - em_openttd_state()   -> JSON snapshot of the running game
 *   - em_openttd_console() -> executes an in-game console command
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
  };

  var settings = loadSettings();
  var messages = []; // chat history sent to the API
  var running = false; // an API turn is in flight
  var autopilotTimer = null;
  var gameReady = false;

  function loadSettings() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) return Object.assign({}, defaults, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return Object.assign({}, defaults);
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

  var tools = [
    {
      type: "function",
      function: {
        name: "get_game_state",
        description:
          "Get a JSON snapshot of the current OpenTTD game: date, paused flag, map size, all companies " +
          "(money, loan, value, income, expenses, AI/human, vehicle and station counts), top towns by " +
          "population and industry counts. Call this before making decisions.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "run_console_command",
        description:
          "Execute one OpenTTD in-game console command. Useful commands: " +
          "'help', 'list_cmds', 'newgame' (start a new random game), 'pause', 'unpause', " +
          "'save <name>', 'load <name>', 'list_settings <filter>', 'set <name> <value>' (change a setting), " +
          "'companies' (list companies), 'list_ai' (list installed AI scripts), 'start_ai <name>' (start an AI " +
          "company), 'stop_ai <company#>', 'reload_ai <company#>', 'rescan_ai' (rescan AI scripts after " +
          "downloading one via Check Online Content), 'list_gs', 'getdate', 'clear'. " +
          "Commands have no text output through this bridge; observe results with get_game_state.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The exact console command line to execute." },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
  ];

  function executeTool(name, argsJson) {
    var args = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch (e) { args = {}; }
    if (name === "get_game_state") return JSON.stringify(getGameState());
    if (name === "run_console_command") return JSON.stringify({ result: runConsoleCommand(args.command || "") });
    return JSON.stringify({ error: "unknown tool: " + name });
  }

  /* ------------------------------------------------------------------ */
  /* Kimi API                                                           */
  /* ------------------------------------------------------------------ */

  var SYSTEM_PROMPT =
    "You are Kimi, an AI player embedded inside a real OpenTTD game running in the user's browser. " +
    "You can observe the game with the get_game_state tool and act through the run_console_command tool, " +
    "which executes commands in the OpenTTD console.\n" +
    "Your role: be the user's co-pilot and strategist. You can:\n" +
    "- analyze the economy and companies and give concrete, expert OpenTTD advice;\n" +
    "- start/stop/reload scripted AI competitors (list_ai, start_ai, stop_ai, reload_ai, rescan_ai);\n" +
    "- tune game settings (list_settings, set), pause/unpause, save/load games, start new games;\n" +
    "- explain mechanics (cargo chains, signals, town growth, subsidies) when asked.\n" +
    "Rules:\n" +
    "- Always check get_game_state before acting, and re-check after acting to confirm the effect.\n" +
    "- If in_game is false, offer to start a game ('newgame') or wait for the user.\n" +
    "- Never run destructive commands (quit, restart, load, newgame) unless the user asked for it " +
    "or you told them first and they agreed.\n" +
    "- Keep answers concise and practical. When on autopilot, act like a diligent assistant manager: " +
    "observe, fix problems, and report briefly what you did.";

  function apiRequest(msgs, withTools, onDone, onError) {
    if (!settings.apiKey) {
      onError("No API key configured. Open the Kimi panel settings and paste your Moonshot API key.");
      return;
    }
    var url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    var body = {
      model: settings.model,
      messages: msgs,
      temperature: 0.6,
      max_tokens: 4096,
    };
    if (withTools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.apiKey,
      },
      body: JSON.stringify(body),
    })
      .then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (t) {
            throw new Error("HTTP " + resp.status + ": " + t.slice(0, 500));
          });
        }
        return resp.json();
      })
      .then(function (data) { onDone(data); })
      .catch(function (err) { onError(String(err && err.message ? err.message : err)); });
  }

  /* Run one full agent turn: up to maxRounds tool-call iterations. */
  function runAgentTurn(userText, isAutopilot, onFinish) {
    if (messages.length === 0) {
      messages.push({ role: "system", content: SYSTEM_PROMPT });
    }
    var content = userText;
    if (isAutopilot) {
      var state = getGameState();
      content =
        "[Autopilot tick " + new Date().toLocaleTimeString() + "] Current game state:\n" +
        JSON.stringify(state) +
        "\nTake any useful actions now (or do nothing if all is well), then report briefly.";
    }
    messages.push({ role: "user", content: content });

    var rounds = 0;
    var maxRounds = 8;

    function step() {
      apiRequest(messages, true, function (data) {
        var choice = data.choices && data.choices[0];
        if (!choice || !choice.message) { onFinish("error: malformed API response"); return; }
        var msg = choice.message;
        messages.push(msg);

        if (msg.tool_calls && msg.tool_calls.length > 0 && rounds < maxRounds) {
          rounds += 1;
          msg.tool_calls.forEach(function (tc) {
            var result = executeTool(tc.function.name, tc.function.arguments);
            logTool(tc.function.name, tc.function.arguments, result);
            messages.push({ role: "tool", tool_call_id: tc.id, content: result });
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
    var div = el("div", { class: "kimi-msg kimi-tool", title: result }, els.log);
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
      "#kimi-panel{position:fixed;right:12px;bottom:56px;width:400px;max-width:calc(100vw - 24px);height:70vh;" +
      "z-index:9999;background:#1e1e1e;color:#e8e8e8;border:1px solid #a8a8a8;border-radius:6px;display:none;" +
      "flex-direction:column;font:13px/1.4 Tahoma,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.6)}" +
      "#kimi-panel.open{display:flex}" +
      "#kimi-panel .kimi-head{padding:8px 10px;background:#3a3a3a;border-bottom:1px solid #555;" +
      "font-weight:bold;display:flex;justify-content:space-between;align-items:center}" +
      "#kimi-panel .kimi-head button{background:none;border:none;color:#aaa;cursor:pointer;font-size:14px}" +
      "#kimi-settings{padding:8px 10px;border-bottom:1px solid #444;display:none;flex-direction:column;gap:6px}" +
      "#kimi-settings.open{display:flex}" +
      "#kimi-settings label{display:flex;align-items:center;gap:6px;white-space:nowrap}" +
      "#kimi-settings label span{width:78px;color:#aaa}" +
      "#kimi-settings input{flex:1;background:#111;color:#eee;border:1px solid #555;border-radius:3px;padding:4px 6px;min-width:0}" +
      "#kimi-status{padding:4px 10px;color:#8bc34a;border-bottom:1px solid #444;font-size:12px;min-height:16px}" +
      "#kimi-log{flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:6px}" +
      ".kimi-msg{white-space:pre-wrap;word-break:break-word;border-radius:4px;padding:5px 8px}" +
      ".kimi-user{background:#2f4f6f;align-self:flex-end;max-width:90%}" +
      ".kimi-assistant{background:#2b2b2b}" +
      ".kimi-tool{background:#33302a;color:#c8b26a;font-size:12px;cursor:help}" +
      ".kimi-error{background:#5f2f2f}" +
      ".kimi-info{background:#26343a;color:#9fc5d8;font-size:12px}" +
      "#kimi-controls{display:flex;gap:6px;padding:6px 10px;border-top:1px solid #444;align-items:center}" +
      "#kimi-controls input[type=text]{flex:1;background:#111;color:#eee;border:1px solid #555;border-radius:3px;padding:6px}" +
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
    function settingRow(label, key, type, placeholder) {
      var lab = el("label", {}, els.settingsDiv);
      el("span", { text: label }, lab);
      var inp = el("input", { type: type || "text", placeholder: placeholder || "" }, lab);
      inp.value = settings[key];
      inp.addEventListener("change", function () {
        settings[key] = type === "number" ? Number(inp.value) : inp.value;
        saveSettings();
      });
      return inp;
    }
    settingRow("API base", "baseUrl", "text", "https://api.moonshot.cn/v1");
    settingRow("API key", "apiKey", "password", "sk-...");
    settingRow("Model", "model", "text", "kimi-k3");
    settingRow("Tick (sec)", "intervalSec", "number");

    els.status = el("div", { id: "kimi-status", text: "idle" }, els.panel);
    els.log = el("div", { id: "kimi-log" }, els.panel);

    var controls = el("div", { id: "kimi-controls" }, els.panel);
    els.input = el("input", { type: "text", placeholder: "Ask Kimi about your game..." }, controls);
    els.askBtn = el("button", { text: "Ask" }, controls);
    els.thinkBtn = el("button", { text: "Think once" }, controls);
    els.autoBtn = el("button", { text: "Autopilot: off" }, controls);

    els.toggle.addEventListener("click", function () { els.panel.classList.toggle("open"); });
    els.closeBtn.addEventListener("click", function () { els.panel.classList.remove("open"); });
    els.settingsBtn.addEventListener("click", function () { els.settingsDiv.classList.toggle("open"); });

    function ask() {
      var text = els.input.value.trim();
      if (!text || running) return;
      els.input.value = "";
      log("user", text);
      runInteractive(text);
    }
    els.askBtn.addEventListener("click", ask);
    els.input.addEventListener("keydown", function (e) { if (e.key === "Enter") ask(); });

    els.thinkBtn.addEventListener("click", function () {
      if (running) return;
      log("info", "Thinking...");
      runInteractive(
        "Look at the current game state and tell me the most useful thing to do next. " +
        "You may take the action yourself if it is safe."
      );
    });

    els.autoBtn.addEventListener("click", function () {
      settings.autopilot = !settings.autopilot;
      saveSettings();
      updateAutopilot();
    });

    log("info",
      "Configure your Moonshot API key in ⚙ settings, then chat or enable autopilot. " +
      "The key is stored only in this browser (localStorage).");
    updateAutopilot();
  }

  function runInteractive(text) {
    if (running) return;
    running = true;
    setStatus("thinking...");
    runAgentTurn(text, false, function (err, reply) {
      running = false;
      if (err) { log("error", "Error: " + err); setStatus("error"); }
      else { log("assistant", reply); setStatus("idle"); }
    });
  }

  function runAutopilotTick() {
    if (running || !settings.autopilot) return;
    running = true;
    setStatus("autopilot thinking...");
    runAgentTurn("", true, function (err, reply) {
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
