# Sprint 36 — 语音/视频交互（0.9.0）

> 状态：**🛠 开发中（暂不提交，待用户确认）**
> 需求：三模式交互齐备（CLI / Web / 语音视频同一内核不同"设备"）
> 设计依据：`docs/AIOS-架构升级方案.md` §4.5.1 语音/视频 + 实机约束（Windows、无原生编译环境、网络可用性）
> 前置：Sprint 35（0.8.0）已提交

## ⚠️ 范围调整（实机验证后，用户拍板）

**语音输入（ASR）放弃**——实机多次尝试失败：
- Chrome Web Speech API 依赖 Google 云端识别（当前网络不可达，识别无结果）
- edge-tts 微软接口 403（第三方接口限制）
- speech-asr（sherpa-onnx WASM 本地识别）模型经 hf-mirror 下载部署成功、init/录音/音频流全正常，但**识别器始终无输出**（VAD 全程 isEmpty、手动模式结果亦空；模型 .data 哈希验证完整、非解压损坏）——本地模型链路在当前环境无法闭环

**收敛后的 Sprint 36 范围**：
- ✅ **多模态图片/附件上传**（P0 已完成）：粘贴/选择/拖拽图片 → 随消息发送 → 多模态 content 组装（需视觉模型）；图片按钮移至输入区模式按钮（对话/智能体协作/双专家辩论）左侧
- ✅ **后端 TTS/media 通道**（保留）：`tts-provider`（edge-tts 自实现 WS 客户端 + sherpa 探测降级）、`/api/v1/audio` WS（media-server）、多模态消息链路（types/content/agent-loop/server）——服务后端/未来非浏览器客户端
- ⏭ 语音输入 UI 与相关依赖（speech-asr、VoiceBar、模型目录、/media 托管）已移除；语音闭环留待网络/模型环境可行时重启


---

## 一、目标与闭环

```
语音输入:  Web 按住说话 → 浏览器 ASR（Web Speech API，零依赖）→ 文本进 chat
语音输出:  回复文本 → 后端 TTS adapter（edge-tts 在线 / sherpa-onnx 本地备选）→ WS 音频流 → Web Audio 播放
视觉输入:  Web 粘贴/截图/文件 → base64 → 多模态消息 → model-router → 视觉模型
```

**统一原则**：CLI / Web / 语音视频共享同一内核（chat 会话、agent-loop、model-router）；语音主战场在 Web（终端无标准音频），CLI 提供 `/voice` 状态透传与 `/tts` 测试命令。

## 二、模块设计

### 1. TTS 方案（实机调整：edge-tts 403 → 浏览器 speechSynthesis）
- **默认：浏览器 speechSynthesis**（系统语音，零依赖、离线、中文支持；Web 主战场）
- **后端 TTS adapter 保留**（`src/media/tts-provider.ts` + `edge-tts.ts` 自实现 WS 客户端 + sherpa 探测降级）——服务后端/未来非浏览器客户端；实测 edge-tts 微软接口 403（第三方接口限制），sherpa-onnx VITS 本地模型 P1
- `/api/v1/audio` WS 音频通道（media-server，provider 可注入）已实现并测试通过

### 2. ASR 方案（实机调整：外部服务不可用 → 本地 WASM 离线识别）
- **默认：speech-asr（sherpa-onnx WASM 浏览器端本地识别）**——纯离线、隐私、不依赖外部网络
  - 实测发现：Chrome Web Speech API 依赖 Google 云端识别（当前网络不可达，识别无结果）；edge-tts 403
  - 模型：`sherpa-onnx-wasm-asr-1pass.zip`（243MB，含 Zipformer 中文 + Silero VAD + 标点）经 **hf-mirror.com** 下载，解压至 `data/media/models/asr/sherpa-onnx-wasm-asr-1pass/`
  - 服务器 `/media/` 静态路由托管模型（.wasm/.data/.js 正确 mime），`/api/v1/media` 端点返回模型就绪状态
  - VoiceBar：模型就绪 → SpeechASR（vadMode silero 自动分段、标点恢复、onResult 发送）；模型缺失 → 明确提示下载路径
- **备选**：Whisper API adapter（需 key）；Web Speech API 仅网络通畅环境可用

### 3. 模型下载管理器（`src/media/download-manager.ts`）
- 管理 `data/media/models/`（TTS VITS / ASR sherpa 模型包）
- 能力：URL 下载 + **进度回调**（字节/总长）+ **断点续传**（Range 头 + 本地 .part）+ 校验（大小/hash）+ 离线包导入（手动放置即识别）
- 供 Web「语音」设置区显示模型状态/下载进度（WS 事件 `media/download`）

### 4. media-server（`src/media/media-server.ts`）
- WS 通道 `/api/v1/audio`（复用 server.ts WS 基础设施）：客户端发 `{type:"tts", text, voice?}` → 服务端流式回 `{type:"tts:frame", audio:<base64>}` / `{type:"tts:end"}`；可并发多路（按 reqId）
- 独立于 event-bus（面向单个客户端连接的请求/响应），请求带 reqId 关联
- 鉴权：与现有 WS 一致（无鉴权，内网工具）

### 5. 多模态消息（`src/types.ts` + chat 组装层）
- `Message.content` 扩展：`string | Array<{type:"text",text}|{type:"image_url",image_url:{url:"data:image/..."}}>`
- chat 流程（server.ts /chat 与 web 端）组装：图片输入 → 首条 user 消息 content 为数组（文本 + image_url）
- model-router / openai-compatible：content 数组直接透传 SDK（天然支持）；**能力标记**：配置 `models.json` profile 加 `vision: true`（默认 false），视觉模型（deepseek-vl / gpt-4o 等）才允许图片消息，否则提示"当前模型不支持视觉"
- 会话持久化：图片消息 content 序列化存储（session-store 已按 JSON 存 content，兼容）

### 6. Web UI
- `VoiceBar.svelte`：底部输入区语音按钮（**按住说话** mic 键 + 音波动画）；**语音会话模式开关**（回复自动 TTS 朗读）；音量/音色选择（读设置）
- `ImageInput`：聊天输入框支持**粘贴图片 / 拖拽 / 文件选择** → 缩略图预览 → 随消息发送（base64 data URL）
- `audio` 播放：WS `tts:frame` 累积 → Blob → `Audio.play()`；连播队列
- SystemPanel「语音」设置区：TTS provider 选择（edge-tts/sherpa）、音色、ASR 状态（Web Speech 可用性）、模型下载进度

### 7. CLI
- `/voice`：查看语音能力状态（provider/模型/下载状态），透传指向 Web 端
- `/tts <文本>`：测试 TTS 合成（输出 WAV 到 data/media/out/，供人工检查；终端不播放）

## 三、范围

| 优先级 | 内容 |
|--------|------|
| **P0** | TTS adapter（edge-tts）+ media-server WS 音频通道 + Web VoiceBar（Web Speech 识别 + 播放）+ 语音会话模式 |
| **P0** | 多模态消息组装 + ImageInput（粘贴/截图/文件上传） + vision 能力标记 |
| **P1** | 下载管理器框架 + sherpa-onnx VITS 本地 TTS 备选（离线降级，Windows prebuild 验证） |
| **P2** | Whisper API ASR adapter / sherpa-onnx ASR |

**不做**：实时视频通话/摄像头流（仅静态截图/图片）；TUI 实时语音；多人语音。

## 四、涉及文件

- `src/media/tts-provider.ts`、`src/media/asr-provider.ts`、`src/media/download-manager.ts`、`src/media/media-server.ts`（新）
- `src/server.ts`（/api/v1/audio WS、/media 状态端点）、`src/index.ts`（装配）
- `src/types.ts`（多模态 content + vision 标记）、`src/core/model-router.ts`（vision 透传校验）
- `src/core/llm/openai-compatible.ts`（content 数组透传确认）
- `web/src/components/VoiceBar.svelte`、`ImageInput`（新）、`ChatPanel.svelte`（接入）、`SystemPanel.svelte`（语音设置区）
- `package.json`（edge-tts 依赖）
- 测试：`test/media-*.test.ts`（TTS mock/降级、download-manager 断点续传、media-server WS、多模态组装）

## 五、测试计划

- TTS：edge-tts adapter（mock 合成返回帧）、sherpa 缺失时自动降级、provider 解析
- download-manager：进度回调、断点续传（伪造 .part 续传）、hash 校验失败清理
- media-server：WS 发 tts 请求 → 收帧 → end；未知 reqId 容错；并发多路
- 多模态：消息组装（文本+图片 content 数组）、非 vision 模型拒绝图片、session 持久化 round-trip
- 回归：524 全绿
- 实机：Web 按住说话 → 中文识别 → chat 回复 → TTS 朗读（含断网降级 sherpa）；粘贴图片 → 视觉模型回答

## 六、实机验证清单

1. Web 按住说话"帮我生成一个番茄钟" → 识别 → 生成应用 → 回复朗读
2. 语音会话模式开关 → 后续回复自动朗读；切换音色
3. 断网（或停 edge-tts 接口）→ TTS 自动降级本地 sherpa（若已装模型）
4. 粘贴一张图片提问"这是什么" → 多模态回复（需配置视觉模型）
5. 模型下载管理：下载 VITS 模型 → 进度条 → 完成 → 本地 TTS 可用

## 七、风险与取舍

| 风险 | 应对 |
|------|------|
| **sherpa-onnx Windows 原生绑定编译失败**（无 VS 环境） | P0 不依赖它（edge-tts 纯 JS）；P1 验证 npm prebuild，失败则降级为"手动放置模型包 + 文档说明"，本地 TTS 作为增强而非必需 |
| edge-tts 依赖微软在线接口（断网失效） | 自动降级本地；降级不可用时报清晰错误提示（语音功能需网络或本地模型） |
| Web Speech API 仅 Chrome/Edge | VoiceBar 探测可用性，不可用时禁用并提示安装 Chrome/Edge；Whisper adapter 作为替代路径（P2） |
| 当前默认模型 deepseek-v4-flash 可能不支持视觉 | vision 能力标记按 profile 配置；截图提问需用户在 /config 配置视觉模型，否则明确报错 |
| 多模态 content 数组破坏现有消息存储/回放 | session-store 按 JSON 存 content 已兼容；回放渲染对数组做文本提取（图片显示缩略图占位） |

---

## 附：Sprint 37/38 路线（后续，待本 sprint 完成后规划）

- Sprint 37（0.10.0）— 进化引擎（观察→提案→评测→推广→回滚 + 能力自生长）
- Sprint 38（1.0.0）— AI OS 1.0 整合（控制台/安全加固/示例 .aw 包/正式文档）
