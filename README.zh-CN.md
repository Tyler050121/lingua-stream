# LinguaStream

[English](README.md) | [中文](README.zh-CN.md)

LinguaStream 是一个 Chrome Manifest V3 扩展，用于给在线视频生成翻译后的语音轨。当前 MVP 优先支持 YouTube，并采用 **先生成时间线，再播放声译** 的工作流，不再走实时标签页音频识别。

## 功能概览

1. 本地 helper 使用 `yt-dlp` 临时下载 YouTube 媒体。
2. Faster Whisper 或 OpenAI 将整条视频转写成带时间戳的英文片段。
3. 扩展把时间线翻译成你选择的目标语言。
4. YouTube 页面根据 `video.currentTime` 同步播放翻译后的语音。
5. 翻译结果会缓存，同一个视频不需要每次重新翻译，除非你主动重做。

## 当前状态

这是一个适合本地使用和早期开源迭代的 MVP。

- 支持站点：YouTube 视频页。
- 默认识别路径：本地 helper + Faster Whisper。
- 可选识别提供商：通过本地 helper 调 OpenAI。
- 默认朗读路径：Chrome Web Speech API。
- 翻译：公共 Google 接口或自定义翻译 API。
- 实时麦克风 / 标签页音频识别已关闭。

## 本地加载扩展

1. 打开 `chrome://extensions`。
2. 开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择项目根目录。
5. 打开一个 YouTube 视频。
6. 使用视频右下角的 LinguaStream 浮动控制条。

准备视频不会自动开始朗读。准备完成后，可以在右下角浮动控制条里播放、暂停、取消或重做声译。

## 启动本地 Helper

```bash
cd tools/local-asr
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8787
```

在扩展 popup 中设置：

- `ASR > Provider`: `Custom`
- `ASR > BaseURL`: `http://127.0.0.1:8787`

扩展内部会调用：

- `POST /prepare-youtube`
- `GET /prepare-progress/<job_id>`

## Popup 设置说明

### Basic

- `Target Language`：翻译和朗读的目标语言。

### Voice

- `Voice Provider`：`Browser` 使用 Chrome Web Speech API；`Custom` 是为后续外部 TTS 服务预留的配置。
- `Voice`：当前目标语言下的系统 / 浏览器声音。
- `Voice Volume`：翻译语音音量。
- `Original Volume`：声译播放期间原视频音量。`100%` 表示不压低原声。

### ASR

- `Provider`：`Custom` 表示本地 helper；`OpenAI` 表示通过本地 helper 调 OpenAI 识别。
- `BaseURL`：`Custom` 时填写本地 helper 地址；选择 OpenAI 时会显示并锁定 OpenAI base URL。
- `API Key`：OpenAI ASR 必填；自定义 helper 服务可按需填写。
- `Model`：Faster Whisper 模型，例如 `tiny.en`；或 OpenAI 模型，例如 `whisper-1`。

### Translate

- `Provider`：公共 Google 接口或自定义 API。
- `BaseURL`：自定义翻译接口地址。
- `API Key`：自定义 API 可按需填写。

## 自定义翻译 API

当 `Translate > Provider` 选择 `Custom` 时，LinguaStream 会发送 `POST` JSON：

```json
{
  "text": "recognized English text",
  "source": "en",
  "target": "zh-CN",
  "sourceLang": "en",
  "targetLang": "zh-CN"
}
```

如果配置了 API Key，会通过以下 header 发送：

- `Authorization: Bearer <key>`
- `x-api-key: <key>`

支持纯文本响应，也支持这些 JSON 字段：

- `translation`
- `translatedText`
- `text`
- `result`
- `data.translation`
- `data.translatedText`
- `translations[0]`
- `choices[0].message.content`

## 缓存

英文识别时间线默认缓存在：

```text
tools/local-asr/cache/
```

YouTube 视频通常对应：

```text
tools/local-asr/cache/youtube-<video_id>/
```

媒体文件只是临时文件，转写完成后会删除。可以用环境变量修改缓存位置：

```bash
LINGUASTREAM_CACHE_DIR=/absolute/path/to/cache uvicorn server:app --host 127.0.0.1 --port 8787
```

翻译后的时间线缓存在 Chrome 扩展存储中。需要强制重新翻译时，使用右下角浮动控制条的重做操作。

## YouTube 下载说明

默认情况下，本地 helper 不读取浏览器 cookies。

如果 YouTube 返回 `HTTP Error 403: Forbidden`，可以用浏览器 cookies 启动 helper：

```bash
LINGUASTREAM_YTDLP_COOKIES_BROWSER=chrome uvicorn server:app --host 127.0.0.1 --port 8787
```

Chrome Canary：

```bash
LINGUASTREAM_YTDLP_COOKIES_BROWSER=chrome_canary uvicorn server:app --host 127.0.0.1 --port 8787
```

如果浏览器 cookies 触发钥匙串密码弹窗或读取失败，可以导出 Netscape 格式的 `cookies.txt`：

```bash
LINGUASTREAM_YTDLP_COOKIES_FILE=/absolute/path/to/cookies.txt uvicorn server:app --host 127.0.0.1 --port 8787
```

## 项目结构

```text
manifest.json                  Chrome MV3 manifest
background/service-worker.js    设置、准备流程编排、翻译桥接
popup/                          扩展 popup UI
src/content/control-button.js   YouTube 页面右下角浮动控制条
src/content/content-script.js   与视频时间同步的声译播放逻辑
tools/local-asr/server.py       本地 yt-dlp + Faster Whisper/OpenAI helper
assets/                         图标和品牌资源
```

## 已知限制

- 当前 MVP 主要支持 YouTube。
- 部分视频可能会阻止 `yt-dlp` 下载。
- 第一次准备可能较慢，因为需要下载、识别和翻译。
- `tiny.en` 速度快但准确率较低，更大的 Whisper 模型会更准但更耗 CPU。
- 浏览器内置 TTS 质量取决于 Chrome、操作系统和已安装声音。
- 公共 Google 翻译接口不是正式 API，可能限流或失效。
- 商业化版本应使用稳定后端服务处理 ASR、翻译和 TTS。

## 隐私说明

API Key 存储在 `chrome.storage.local`。识别后的文本可能会发送到你选择的翻译服务。如果选择 OpenAI ASR，本地 helper 会把音频发送给 OpenAI。使用第三方服务前，请自行确认对应服务的隐私政策。
