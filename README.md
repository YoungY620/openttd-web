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
  - "Autopilot"：按间隔自动观察局面并行动（启动/停止 AI 公司、调整设置、存读档等控制台操作）

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
```

- `OpenTTD/` — 上游源码（vendored），改动点：
  - `src/emscripten/kimi_bridge.cpp` — 新增的 JS↔WASM 桥（仅 `#ifdef __EMSCRIPTEN__`）
  - `CMakeLists.txt` — 导出桥函数、条件打包 `vendor/baseset`
  - `os/emscripten/shell.html` — 加载 `kimi.js`
  - `os/emscripten/kimi.js` — Kimi AI 面板（新增）
- `.github/workflows/deploy.yml` — CI 构建 WASM 并部署 GitHub Pages
- `scripts/build-local.sh` — 本地 Docker 复现 CI 构建
- `docs/RESOURCES.md` — OpenTTD 资料汇编（wiki/源码/素材/移植参考）

## 本地构建

需要 Docker。镜像固定为 `emscripten/emsdk:6.0.1`（与上游 CI 一致）。

```bash
scripts/build-local.sh
python3 -m http.server -d site 8000   # http://localhost:8000
```

## 性能说明

- 单线程 WASM（官方 Emscripten 构建不使用 pthreads），因此**不需要** COOP/COEP 响应头，可直接托管于 GitHub Pages
- Release 构建（-O3）、`WASM_BIGINT`、内存按需增长（`ALLOW_MEMORY_GROWTH`）
- 基础素材打包进 `.data`，首次加载后由浏览器 HTTP 缓存（GitHub Pages 自带缓存头）
- 渲染为 SDL2 软件光栅化到 Canvas；OpenTTD 本身是 2D 精灵引擎，WebGPU 无直接收益。可扩展的优化方向：`-flto`、链接时代码瘦身、IndexedDB 存档异步化等

## 已知限制

- 仅内置英文语言包（上游 Emscripten 构建未编译 FreeType/ICU，无法渲染中文；接入方案见 pelya 移植）
- 暂不支持联机对战大厅直连（WebSocket 代理可连官方服务器，未默认开启）
- 浏览器可能清理 IndexedDB 中的存档（页面会有提示）

## 许可

- OpenTTD 及本仓库对上游源码的修改：GPL-2.0（见 `OpenTTD/COPYING.md`）
- OpenGFX: GPL-2.0；OpenSFX: CC Sampling+ / GPL-2.0
- `kimi.js` 等新增脚本：GPL-2.0
