# Sprint 43 — 语音输入（离线 ASR）+ TTS 补齐（1.1.0）

> 状态：✅ **开发完成（757 测试全绿，待用户验收，未提交）**
> 需求：三模式交互补全「语音输入」——Sprint 36 因网络受限放弃，本次经 spike 验证选定 **sherpa-onnx 非流式 ASR（paraformer-zh）**：全离线、中文质量实测最优、无加载兼容坑；顺带把设备 Tab 里 sherpa TTS 的 P1 桩填真
> 前置：1.0.0（Sprint 42 待验收提交）

## 一、目标

1. **离线中文语音输入**：Web 按住说话 → 录音 → WS 上行 → 后端 paraformer-zh 识别 → 文本回填输入框（可编辑后发送）
2. **模型管理**：`data/media/models/{asr,tts}/` 就绪探测 + **hf-mirror 一键下载**（镜像已验证可达；huggingface.co 直连超时）+ 手动放置离线包指引
3. **TTS 补齐**：sherpa-onnx vits-zh-ll 真实现（替换抛错桩），edge-tts 在线降级保留；Web「朗读」可选走离线 TTS
4. **设备 Tab 真实化**：asr/tts 状态按模型就绪动态展示（不再写死 disabled）

## 二、设计

### 1. 依赖与加载（spike 已验证）

- `sherpa-onnx-node` **锁定 1.10.46**（1.13.7 流式路径在此环境原生崩溃；1.10.46 非流式全链路验证通过）；平台包 `sherpa-onnx-win-x64` 自动带入（prebuilt DLL，无编译）
- ESM 集成：`import sherpa from "sherpa-onnx-node"`（default import，spike8.mjs 已证可行）；CJS 内部互操作无坑（transformers.js 的嵌套 ESM/DLL 问题不存在于 sherpa）
- API（1.10.46）：`OfflineRecognizer`（createStream → acceptWaveform → decode → getResult）、`OfflineTts.generate({text, sid, speed})`、`LinearResampler`、`readWave/writeWave`；config 键 camelCase，transducer 模型键为 `transducer`（非 zipformer），TTS lexicon/dictDir 在 `model.vits` 内层

### 2. 模型管理（src/media/model-manager.ts，新增）

```
data/media/models/asr/  model.onnx + tokens.txt + am.mvn        （paraformer-zh int8，232MB）
data/media/models/tts/  model.onnx + tokens.txt + lexicon.txt + dict/ + *.fst   （vits-zh-ll，115MB+）
```

- `isAsrReady(dataDir)` / `isTtsReady(dataDir)`：必需文件存在校验（缺一即未就绪，detail 注明缺哪个）
- `downloadModel(kind, onProgress?)`：**hf-mirror 源**（`https://hf-mirror.com/<repo>/resolve/main/<file>`，已实测 200）；顺序下载 + 校验大小非零；失败返回可读错误（网络/磁盘）；**不做断点续传**（v1 简单重试）
- 文件清单表（repo/文件名/size）集中在 manager 内；模型 repo 版本固定（避免漂移）
- 手动放置离线包：README + 设备 Tab 指引（放对路径即识别就绪，零代码）

### 3. ASR 服务（src/media/asr.ts，新增，同构 tts-provider）

```ts
interface AsrProvider { readonly engine: string; transcribe(samples: Float32Array, sampleRate: number): Promise<{ text: string }> }
class SherpaAsrProvider implements AsrProvider   // OfflineRecognizer(paraformer-zh)，懒初始化（首次调用加载）
resolveAsrProvider(dataDir): AsrProvider | null  // 就绪 → sherpa；否则 null（detail 指引下载）
```

- **非流式**（按住说话→录完→识别）：spike 证实此场景足够，且绕开本环境流式崩溃路径
- 音频预处理：Web 端采集 48kHz → 前端线性降采样 16k → WS 上行 PCM；后端兜底用 `LinearResampler` 二次确认（防御端上采样错误）
- 单例缓存 provider（进程内复用，避免重复加载 232MB 模型）；模型缺失时明确报错不虚假成功

### 4. WS 双向通道（media-server.ts 扩展 `/api/v1/audio`）

现有 TTS 协议保持；新增 ASR 消息：

```
→ { type:"asr", reqId, audio:<base64 16k PCM>, sampleRate }
← { type:"asr:result", reqId, text }       成功
← { type:"asr:error",  reqId, message }    失败（模型未装/识别异常）
```

- 一次性整段上传（按住说话时长 ≤60s，JSON base64 体积可接受；流式帧留后续）
- `createAudioWs` 注入 `asrProvider?`（index.ts 闭包 resolve；测试 mock）

### 5. Web 语音输入（InputArea 麦克风按钮 + VoiceBar）

- 输入区新增 🎤 按钮：**按住说话 → 松开停止**（`getUserMedia` + AudioContext 采集 Float32Array PCM → 前端 16k 降采样 → WS 发送）；识别中显示状态（录音中/识别中）
- 结果**回填输入框**（不直接发送——用户可编辑后再发）
- 启用条件：浏览器麦克风权限 + 后端 `GET /devices` asr 就绪（WS 握手前先拉状态）；未就绪点击提示「语音模型未安装：设置→设备→一键下载 / `/media download asr`」
- 错误反馈：权限拒绝 / 模型缺失 / 识别失败分别提示

### 6. TTS 补齐（tts-provider.ts 改造）

- `SherpaTtsProvider`：vits-zh-ll（`model.vits` 内层含 lexicon/dictDir + 顶层 ruleFsts）`generate({text, sid, speed})` → 转 Buffer 流/整段；模型未就绪时抛错由外层降级 edge-tts（现有链路）
- `resolveTtsProvider`：sherpa 就绪 → sherpa；否则 edge-tts（现状）；两者皆不可用抛错（现状）
- Web「朗读」按钮（可选）：调 `/api/v1/audio` WS TTS 走 sherpa 离线合成（浏览器 speechSynthesis 保留为兜底）

### 7. 设备 Tab 状态真实化（status.ts）

- `asr: { enabled: isAsrReady, engine: "sherpa-paraformer-zh", detail: 就绪/缺失文件/未下载 }`
- `tts: { engine: 实际解析结果, localModelReady, detail }`（sherpa 就绪时不再写 edge-tts）
- 新增 `modelStatus: { asrReady, ttsReady }` 供 Web 按钮门控

### 8. CLI `/media`

- `media status`：asr/tts 模型就绪状态 + 缺失文件清单 + 建议命令
- `media download asr|tts`：hf-mirror 下载（进度行；失败可重跑，幂等跳过已存在文件）
- 并入 commands（新 commands/media.ts 或并入既有设备命令——**新增 media.ts**，kebab-case）

### 9. 测试

- model-manager：就绪探测（缺文件各分支）、下载 URL 构造、幂等跳过、失败错误
- asr：resolveAsrProvider 就绪/未就绪、provider 缓存、mock transcribe、resampler（16k→8k 等）、**真实识别冒烟测试**（可选 `describe.skipIf(!process.env.RUN_MEDIA_SMOKE)`，模型存在时本地跑，不进 CI）
- WS：asr 协议分发（mock asrProvider：成功/模型缺失/异常）、TTS 回归
- devices 端点：asr/tts 状态按就绪动态
- CLI：media status/download 解析与分发
- 全量验证链：`npm run build && npm run lint && npm test && npm run web:build` + web tsc 0 错误

## 四、风险

- 模型体积（ASR 232MB + TTS 115MB + dict）→ 下载管理器 + 手动放置；后续可换更小模型（zipformer-ctc 等，未验证列入后续）
- 浏览器采集兼容（AudioContext 采样率差异）→ 前端降采样 + 后端 LinearResampler 双保险；录音 ≤60s 上限
- 原生绑定在新平台（非 win-x64）→ npm 平台包机制自动带对应二进制；文档注明 Windows 已实测
- 一次性整段上传带宽 → 16k PCM base64 ≈ 1MB/min，可接受；流式帧留后续
- 版本锁定 1.10.46 → 不随依赖升级漂移；升级需重新跑冒烟测试

## 五、版本

1.1.0：package.json → CHANGELOG.md → README 徽章（提交时同步）
