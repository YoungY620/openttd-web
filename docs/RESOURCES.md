# OpenTTD 资料汇编 / OpenTTD Resources

收集自官方与社区的权威资料，供复刻与开发参考。

## 官方

- 官网: https://www.openttd.org/
- 源代码: https://github.com/OpenTTD/OpenTTD (GPL-2.0)
- 官方 Wiki (玩法/机制手册): https://wiki.openttd.org/
- BaNaNaS 在线内容服务 (AI/GS 脚本、NewGRF、剧本): https://bananas.openttd.org/
- 开发文档 (Doxygen): https://docs.openttd.org/

## 关键 Wiki 条目（玩法机制）

- 新手教程: https://wiki.openttd.org/en/Manual/Tutorial
- 铁路建设: https://wiki.openttd.org/en/Manual/Railway%20construction
- 信号系统: https://wiki.openttd.org/en/Manual/Signals
- 货物运输与产业链: https://wiki.openttd.org/en/Manual/Industries#industry-chains
- 城镇增长: https://wiki.openttd.org/en/Manual/Towns
- 游戏机制: https://wiki.openttd.org/en/Manual/Game%20Mechanics
- 控制台命令: https://wiki.openttd.org/en/Manual/Console%20Commands
- AI 开发 (Squirrel API): https://wiki.openttd.org/en/Development/Script/Main%20Page
- AI/GS API 文档: https://docs.openttd.org/ai-api/ , https://docs.openttd.org/gs-api/

## 浏览器移植参考

- 上游 Emscripten 支持 (PR #8355, 1.11.0 起): https://github.com/OpenTTD/OpenTTD/pull/8355
- 运行时自动下载 OpenGFX (PR #11109): https://github.com/OpenTTD/OpenTTD/pull/11109
- 官方构建说明: `OpenTTD/os/emscripten/README.md`
- pelya 的触屏移植（GitHub Pages 托管实例）: https://github.com/pelya/openttd-touch-webapp → https://pelya.github.io/openttd-touch-webapp

## 基础素材（自由许可，可再分发）

- OpenGFX 7.1: https://cdn.openttd.org/opengfx-releases/7.1/opengfx-7.1-all.zip (GPL-2.0)
- OpenSFX 1.0.3: https://cdn.openttd.org/opensfx-releases/1.0.3/opensfx-1.0.3-all.zip (CC Sampling+/GPL 双许可)
- OpenMSX 0.4.2: https://cdn.openttd.org/openmsx-releases/0.4.2/openmsx-0.4.2-all.zip (GPL-2.0) — 体积较大，默认未打包，可在游戏内 "Check Online Content" 下载

## Kimi (Moonshot AI) API

- OpenAI 兼容接口: https://platform.moonshot.cn/docs
- Base URL: `https://api.moonshot.cn/v1`（国际站 `https://api.moonshot.ai/v1`）
- 模型名在面板中可配置，默认 `kimi-k3`
