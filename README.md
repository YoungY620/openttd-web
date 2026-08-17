# OpenTTD Web — 浏览器版 OpenTTD + Kimi K3 AI 玩家

在浏览器中游玩完整的 [OpenTTD](https://www.openttd.org/)（Transport Tycoon Deluxe 开源复刻），
由官方上游源码（master 分支）经 Emscripten 编译为 WebAssembly，通过 GitHub Pages 对外提供服务。
内置由 **Kimi K3**（Moonshot AI，用户自配 API Key）驱动的 AI 玩家面板。

## 在线游玩

部署后访问: `https://<your-name>.github.io/openttd-web/`

## 功能

- 完整 OpenTTD 单机玩法：铁路/公路/水运/航空运输网络、产业链、城镇、财政补贴、存档读档等
- 基础素材自包含：构建时打包 OpenGFX（图形）+ OpenSFX（音效），无运行时外部依赖
- 游戏内 "Check Online Content" 可下载 AI 脚本、GameScript、NewGRF、音乐包（经官方 WebSocket 代理）
- 存档持久化在浏览器 IndexedDB
- **Kimi AI 玩家面板**（右下角按钮）：
  - 配置 Moonshot API Key / Base URL / 模型名（仅存浏览器 localStorage）
  - 与 Kimi 对话获取经营策略建议
  - "Think once"：让 Kimi 观察当前局面并给出/执行下一步操作
  - "Autopilot"：按间隔自动观察局面并行动
  - **Battle 对战**：多个 LLM Agent 各自控制一家公司（经内置占位 AI `RemoteControl` 创建），
    回合制轮流决策，积分榜实时对比公司价值；每个 Agent 可配不同模型/API Key
- **AI 实际操作能力**（WASM 动作桥 `em_openttd_action`，14 种动作）：
  列引擎、查询地块、找城镇/产业、建公路、建车站/车库、买车、下订单、启停/出售车辆、
  列车辆/车站——Kimi 能真正修路、开线、运营，而不只是聊天或开关内置 AI

## 架构

```
┌──────────── GitHub Pages (静态托管) ────────────┐
│ index.html (openttd.html + Kimi 面板 UI)         │
│ openttd.js / openttd.wasm / openttd.data        │
│ kimi.js  ──fetch──> Moonshot API (Kimi K3)      │
└──────────────────────────────────────────────────┘
        │ Module.ccall
        ▼
  em_openttd_state()     —— C++ 桥：游戏状态 JSON 快照
  em_openttd_console()   —— C++ 桥：执行游戏内控制台命令
  em_openttd_action()    —— C++ 桥：14 种玩法动作（建路/站/车库/买车/订单/启停），
                            支持以指定公司身份执行（Battle 对战核心）
```

- `OpenTTD/` — 上游源码（vendored），改动点：
  - `src/emscripten/kimi_bridge.cpp` — 状态/控制台桥（仅 `#ifdef __EMSCRIPTEN__`）
  - `src/emscripten/kimi_actions.cpp` — 玩法动作桥（新增）
  - `CMakeLists.txt` — 导出桥函数、条件打包 `vendor/baseset` 与 `vendor/ai`
  - `os/emscripten/shell.html` — 加载 `kimi.js`
  - `os/emscripten/kimi.js` — Kimi AI 面板（新增，含 Battle 对战）
  - `vendor/ai/RemoteControl/` — 占位 Squirrel AI（Battle 用，自身不做决策）
- `.github/workflows/deploy.yml` — CI 构建 WASM 并部署 GitHub Pages
- `scripts/build-local.sh` — 本地 Docker 复现 CI 构建
- `scripts/verify-*.mjs` — headless Chrome (CDP) 验证：启动/控制台/动作全链路
- `docs/RESOURCES.md` — OpenTTD 资料汇编（wiki/源码/素材/移植参考）

## 本地构建

需要 Docker。镜像固定为 `emscripten/emsdk:6.0.1`（与上游 CI 一致）。

```bash
scripts/build-local.sh
python3 -m http.server -d site 8000   # http://localhost:8000
```

## 性能说明

- 单线程 WASM（官方 Emscripten 构建不使用 pthreads），因此**不需要** COOP/COEP 响应头，可直接托管于 GitHub Pages
- Release 构建 **-O3 + ThinLTO**（`INTERPROCEDURAL_OPTIMIZATION_RELEASE`），`WASM_BIGINT`，内存按需增长
- 传输实测（GitHub Pages gzip）：`openttd.wasm` 10.3MB→**3.2MB**，`openttd.data` 21MB→**16.2MB**，JS ~62KB，首次加载合计约 19.6MB，之后走浏览器 HTTP 缓存
- 基础素材（OpenGFX/OpenSFX）打包进 `.data`，无运行时外部下载；存档走 IndexedDB 异步落盘
- 渲染为 SDL2 软件光栅化到 Canvas；OpenTTD 是 2D 精灵引擎，WebGPU 对其无直接收益（强行移植渲染管线的成本远高于收益）。可扩展方向：`-sLZ4` 进一步压缩 `.data`、提高 `INITIAL_MEMORY` 减少堆增长停顿

## 已知限制

- 仅内置英文语言包（上游 Emscripten 构建未编译 FreeType/ICU，无法渲染中文；接入方案见 pelya 移植）
- 暂不支持联机对战大厅直连（WebSocket 代理可连官方服务器，未默认开启）
- 浏览器可能清理 IndexedDB 中的存档（页面会有提示）

## 许可

- OpenTTD 及本仓库对上游源码的修改：GPL-2.0（见 `OpenTTD/COPYING.md`）
- OpenGFX: GPL-2.0；OpenSFX: CC Sampling+ / GPL-2.0
- `kimi.js` 等新增脚本：GPL-2.0
