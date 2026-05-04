# LinguaStream

[English](README.md) | [中文](README.zh-CN.md)

LinguaStream 是一个 Chrome Manifest V3 扩展，用于给在线视频生成翻译后的语音轨。当前 MVP 优先支持 YouTube，并采用 **先生成时间线，再播放声译** 的工作流，不再走实时标签页音频识别。

## 功能概览

1. 本地后端使用 `yt-dlp` 临时下载 YouTube 媒体。
2. Faster Whisper 或火山引擎将整条视频转写成带时间戳的英文片段。
3. 扩展把时间线翻译成你选择的目标语言。
4. YouTube 页面根据 `video.currentTime` 同步播放翻译后的语音。
5. 翻译结果会缓存，同一个视频不需要每次重新翻译，除非你主动重做。

## 当前状态

这是一个适合本地使用和早期开源迭代的 MVP。

- 支持站点：YouTube 视频页。
- 默认识别路径：本地后端 + Faster Whisper。
- 可选识别提供商：通过后端调火山引擎。
- 默认朗读路径：Chrome Web Speech API。
- 翻译：公共 Google 接口或自定义翻译 API。
- 实时麦克风 / 标签页音频识别已关闭。

## 本地加载扩展

1. 打开 `chrome://extensions`。
2. 开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择 `extension/` 目录。
5. 打开一个 YouTube 视频。
6. 使用视频右下角的 LinguaStream 浮动控制条。

准备视频不会自动开始朗读。准备完成后，可以在右下角浮动控制条里播放、暂停、取消或重做声译。

## 启动本地后端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8787
```

Windows PowerShell：

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8787
```

如果希望多个视频同时准备，可以启动多个 backend worker：

```bash
uvicorn server:app --host 127.0.0.1 --port 8787 --workers 2
```

同一个视频会用缓存锁去重，避免重复下载和重复写入时间线。不同视频可以并发下载和识别。Faster Whisper 默认每个 worker 内只同时跑 1 个转写任务，避免 CPU 被打满。可以在 `backend/config/helper.json` 里调整：

```json
{
  "whisperTranscribeConcurrency": 2
}
```

也可以用环境变量临时覆盖：

```bash
LINGUASTREAM_WHISPER_TRANSCRIBE_CONCURRENCY=2 uvicorn server:app --host 127.0.0.1 --port 8787
```

火山引擎识别主要是网络请求，通常更适合并发准备多个视频。

在扩展 popup 中设置：

- `ASR > Provider`: `Custom`
- `Basic > Backend URL`: `http://127.0.0.1:8787`

扩展内部会调用：

- `POST /prepare-youtube`
- `GET /prepare-progress/<job_id>`

## Popup 设置说明

### Basic

- `Target Language`：翻译和朗读的目标语言。

### Voice

- `Voice Provider`：`Browser` 使用 Chrome Web Speech API；`Volcengine` 和 `Google Cloud` 会由扩展前端直接请求语音合成 API；`Custom` 预留给兼容的外部 TTS 接口。
- `Volcengine`：需要填写火山语音控制台里的 `APP ID`、`Access Token`、`Cluster` 和 `Voice Type`。默认 cluster 是 `volcano_tts`。
- `Google Cloud`：需要 Text-to-Speech API Key。`Voice Name` 可留空，由 Google 按目标语言自动选择声音。
- `Voice`：当前目标语言下的系统 / 浏览器声音，仅在 `Browser` provider 下显示。
- `Voice Volume`：翻译语音音量。
- `Original Volume`：声译播放期间原视频音量。`100%` 表示不压低原声。

### ASR

- `Provider`：`Custom` 表示兼容后端识别路径；`Volcengine` 表示通过后端调火山引擎识别。
- `Backend URL` 在 `Basic` 里配置；所有 ASR provider 都需要它，因为后端负责下载视频、抽取音频和生成时间线。
- `BaseURL`：`Custom` 必填，初始值来自 `Basic > Backend URL`。
- `API Key`：`Custom` 可按需填写。
- `Mode`：火山引擎当前使用 `Flash / Turbo`。
- `APP ID` / `Access Token`：选择火山引擎 ASR 时显示，直接复制火山语音控制台里的两个字段。当前火山支持对接的是录音文件识别极速版。
- `Model`：Faster Whisper 模型，例如 `tiny.en`；火山引擎模型可留空使用默认 `bigmodel`。

### Translate

- `Provider`：公共 Google 接口、DeepSeek 或自定义 API。
- `BaseURL`：自定义翻译接口地址。
- `API Key`：自定义 API 可按需填写。
- `DeepSeek`：需要 API Key 和 model，可选 `deepseek-chat` / `deepseek-reasoner`。

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
backend/cache/
```

YouTube 视频通常对应：

```text
backend/cache/youtube-<video_id>/
```

媒体文件只是临时文件，转写完成后会删除。可以用环境变量修改缓存位置：

```bash
LINGUASTREAM_CACHE_DIR=/absolute/path/to/cache uvicorn server:app --host 127.0.0.1 --port 8787
```

翻译后的时间线缓存在 Chrome 扩展存储中。需要强制重新翻译时，使用右下角浮动控制条的重做操作。

翻译阶段在扩展后台使用有限并发，配置文件是 `extension/config/runtime.js`：

- Google：最多 6 条字幕同时翻译。
- DeepSeek：最多 10 条字幕同时翻译。
- Custom API：最多 4 条字幕同时翻译。

并发只影响未命中缓存的新翻译。已缓存的句子会直接复用。

## YouTube 下载说明

默认情况下，本地后端不读取浏览器 cookies。

如果 YouTube 返回 `HTTP Error 403: Forbidden`，可以用浏览器 cookies 启动后端：

```bash
LINGUASTREAM_YTDLP_COOKIES_BROWSER=chrome uvicorn server:app --host 127.0.0.1 --port 8787
```

Windows PowerShell 用 `$env:`：

```powershell
$env:LINGUASTREAM_YTDLP_COOKIES_BROWSER="chrome"
uvicorn server:app --host 127.0.0.1 --port 8787
```

Chrome Canary：

```bash
LINGUASTREAM_YTDLP_COOKIES_BROWSER=chrome_canary uvicorn server:app --host 127.0.0.1 --port 8787
```

后端会按系统自动探测常见 Chrome / Chrome Canary / Edge / Brave profile 路径。特殊安装位置可以手动指定：

```bash
LINGUASTREAM_YTDLP_COOKIES_BROWSER=chrome_canary \
LINGUASTREAM_YTDLP_BROWSER_PROFILE="/absolute/path/to/browser/profile/root" \
uvicorn server:app --host 127.0.0.1 --port 8787
```

如果浏览器 cookies 触发钥匙串密码弹窗或读取失败，可以导出 Netscape 格式的 `cookies.txt`：

```bash
LINGUASTREAM_YTDLP_COOKIES_FILE=/absolute/path/to/cookies.txt uvicorn server:app --host 127.0.0.1 --port 8787
```

## Windows 支持

Chrome 扩展本身可以在 Windows 版 Chrome / Edge Chromium 中加载。本地后端也支持 Windows，需要 Python 3.10+，并且如果使用火山引擎或需要抽取音频，建议把 `ffmpeg` 加到 `PATH`。

浏览器 cookies 自动探测覆盖常见 Windows profile 路径：

- Chrome：`%LOCALAPPDATA%\Google\Chrome\User Data`
- Chrome Canary：`%LOCALAPPDATA%\Google\Chrome SxS\User Data`
- Edge：`%LOCALAPPDATA%\Microsoft\Edge\User Data`
- Brave：`%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data`

macOS 和 Linux 下后端会用系统文件锁，避免多个 worker 对同一个视频重复生成。Windows 下会降级为进程内锁，所以单 worker 没问题；如果用 `--workers 2+`，两个 Windows worker 进程仍可能同时开始同一个视频。不同视频并发准备不受影响。

## 项目结构

```text
extension/                      Chrome 已解压扩展根目录
extension/manifest.json         Chrome MV3 manifest
extension/background/           设置、准备流程编排、翻译桥接
extension/popup/                扩展 popup UI
extension/content/              YouTube 浮动控制条和同步播放逻辑
backend/                        本地 yt-dlp + Faster Whisper/火山引擎后端
backend/config/helper.json      后端并发配置
backend/cache/                  已忽略的本地识别时间线缓存
media/                          品牌和视频素材，不会被 Chrome 加载
scratch/                        已忽略的图片生成实验文件
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

API Key 存储在 `chrome.storage.local`。识别后的文本可能会发送到你选择的翻译服务。如果选择火山引擎 ASR，后端会把音频发送给火山引擎。如果选择火山引擎或 Google Cloud TTS，扩展会把翻译后的文本直接发送给对应 TTS 服务商。使用第三方服务前，请自行确认对应服务的隐私政策。
