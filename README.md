# LinguaStream

[English](README.md) | [中文](README.zh-CN.md)

LinguaStream is a Chrome Manifest V3 extension that prepares a translated voice track for online videos. The current MVP focuses on YouTube and uses a **prepare first, then play** workflow instead of realtime tab-audio capture.

## What It Does

1. A local backend temporarily downloads YouTube media with `yt-dlp`.
2. Faster Whisper or Volcengine transcribes the video into timestamped English segments.
3. The extension translates the timeline into the selected target language.
4. The YouTube page speaks the translated timeline in sync with `video.currentTime`.
5. Translation timelines are cached, so the same video does not need to be translated again unless you force retry.

## Current Status

This is an MVP for local use and early open-source development.

- Supported site: YouTube video pages.
- Default ASR path: local backend + Faster Whisper.
- Optional ASR provider: Volcengine via the backend.
- Default TTS path: Chrome Web Speech API.
- Translation: public Google endpoint or a custom translation API.
- Realtime microphone/tab-audio ASR is intentionally disabled.

## Load the Extension Locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension/` folder.
5. Open a YouTube video.
6. Use the LinguaStream floating control in the lower-right corner of the video page.

Preparing a video does not automatically start speaking. After preparation finishes, use the floating control to play, pause, cancel, or retry the translated voice track.

## Run the Local Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8787
```

Windows PowerShell:

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8787
```

To prepare multiple videos at the same time, run the backend with multiple workers:

```bash
uvicorn server:app --host 127.0.0.1 --port 8787 --workers 2
```

The backend uses a per-video cache lock, so the same video is not downloaded or written twice concurrently. Different videos can download and transcribe in parallel. Faster Whisper defaults to one transcription task per worker to avoid saturating the CPU. Adjust it in `backend/config/helper.json`:

```json
{
  "whisperTranscribeConcurrency": 2
}
```

You can also override it temporarily with an environment variable:

```bash
LINGUASTREAM_WHISPER_TRANSCRIBE_CONCURRENCY=2 uvicorn server:app --host 127.0.0.1 --port 8787
```

Volcengine ASR is mostly network-bound and is usually better suited to preparing multiple videos concurrently.

In the extension popup, set:

- `ASR > Provider`: `Custom`
- `Basic > Backend URL`: `http://127.0.0.1:8787`

The extension calls:

- `POST /prepare-youtube`
- `GET /prepare-progress/<job_id>`

## Popup Settings

### Basic

- `Target Language`: translation and speech target language.

### Voice

- `Voice Provider`: `Browser` uses Chrome Web Speech API. `Volcengine` and `Google Cloud` synthesize audio directly from the extension. `Custom` is reserved for compatible external TTS endpoints.
- `Volcengine`: requires `APP ID`, `Access Token`, `Cluster`, and `Voice Type` from the Volcengine voice console. The default cluster is `volcano_tts`.
- `Google Cloud`: requires a Text-to-Speech API key. `Voice Name` is optional; leave it empty to let Google choose a voice for the target language.
- `Voice`: system/browser voice for the selected target language. Shown only for `Browser`.
- `Voice Volume`: translated speech volume.
- `Original Volume`: original video volume while translated voice playback is enabled. `100%` means no ducking.

### ASR

- `Provider`: `Custom` for a backend-compatible ASR path, or `Volcengine` through the backend.
- `Backend URL` lives in `Basic`; it is required for all ASR providers because the backend downloads media, extracts audio, and manages timeline preparation.
- `BaseURL`: required for `Custom`; initialized from `Basic > Backend URL`.
- `API Key`: optional for `Custom`.
- `Mode`: Volcengine currently uses `Flash / Turbo`.
- `APP ID` / `Access Token`: shown for Volcengine ASR. Copy both values from the Volcengine voice console. Current Volcengine support targets the recording-file recognition Turbo API.
- `Model`: Faster Whisper model such as `tiny.en`, or Volcengine model such as `bigmodel`.

### Translate

- `Provider`: public Google endpoint, DeepSeek, or custom API.
- `BaseURL`: custom translation endpoint.
- `API Key`: optional for custom APIs.
- `DeepSeek`: requires API Key and a model (`deepseek-chat` or `deepseek-reasoner`).

## Custom Translation API

When `Translate > Provider` is `Custom`, LinguaStream sends `POST` JSON:

```json
{
  "text": "recognized English text",
  "source": "en",
  "target": "zh-CN",
  "sourceLang": "en",
  "targetLang": "zh-CN"
}
```

If an API key is configured, it is sent as:

- `Authorization: Bearer <key>`
- `x-api-key: <key>`

Supported responses include plain text or JSON fields such as:

- `translation`
- `translatedText`
- `text`
- `result`
- `data.translation`
- `data.translatedText`
- `translations[0]`
- `choices[0].message.content`

## Cache

English ASR timelines are cached under:

```text
backend/cache/
```

For YouTube videos, the folder usually looks like:

```text
backend/cache/youtube-<video_id>/
```

Media files are temporary and are deleted after transcription. To move the cache:

```bash
LINGUASTREAM_CACHE_DIR=/absolute/path/to/cache uvicorn server:app --host 127.0.0.1 --port 8787
```

Translated timelines are cached in Chrome extension storage. Use the retry action in the floating control to force a fresh translation pass.

Translation runs with bounded background concurrency. Edit `extension/config/runtime.js` to tune it:

- Google: up to 6 segments at once.
- DeepSeek: up to 10 segments at once.
- Custom API: up to 4 segments at once.

Concurrency only affects fresh translations. Cached sentences are reused immediately.

## YouTube Download Notes

By default, the backend does not read browser cookies.

If YouTube returns `HTTP Error 403: Forbidden`, run the backend with browser cookies:

```bash
LINGUASTREAM_YTDLP_COOKIES_BROWSER=chrome uvicorn server:app --host 127.0.0.1 --port 8787
```

Windows PowerShell uses `$env:`:

```powershell
$env:LINGUASTREAM_YTDLP_COOKIES_BROWSER="chrome"
uvicorn server:app --host 127.0.0.1 --port 8787
```

For Chrome Canary:

```bash
LINGUASTREAM_YTDLP_COOKIES_BROWSER=chrome_canary uvicorn server:app --host 127.0.0.1 --port 8787
```

The backend auto-detects common Chrome / Chrome Canary / Edge / Brave profile roots for the current operating system. For non-standard installs, override the profile root explicitly:

```bash
LINGUASTREAM_YTDLP_COOKIES_BROWSER=chrome_canary \
LINGUASTREAM_YTDLP_BROWSER_PROFILE="/absolute/path/to/browser/profile/root" \
uvicorn server:app --host 127.0.0.1 --port 8787
```

If browser cookies trigger Keychain prompts or fail, export YouTube cookies to a Netscape-format `cookies.txt` file:

```bash
LINGUASTREAM_YTDLP_COOKIES_FILE=/absolute/path/to/cookies.txt uvicorn server:app --host 127.0.0.1 --port 8787
```

## Windows Support

The Chrome extension can be loaded on Windows Chrome / Edge Chromium. The local backend also supports Windows with Python 3.10+ and `ffmpeg` on `PATH`.

Browser cookie auto-detection covers common Windows profile roots:

- Chrome: `%LOCALAPPDATA%\Google\Chrome\User Data`
- Chrome Canary: `%LOCALAPPDATA%\Google\Chrome SxS\User Data`
- Edge: `%LOCALAPPDATA%\Microsoft\Edge\User Data`
- Brave: `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data`

On macOS and Linux, the backend uses an OS file lock to deduplicate the same video across worker processes. On Windows, it falls back to an in-process lock, so single-worker usage is fine; with `--workers 2+`, two separate Windows worker processes may still start the same video at the same time. Different videos can still be prepared concurrently.

## Project Structure

```text
extension/                      Chrome unpacked extension root
extension/manifest.json         Chrome MV3 manifest
extension/background/           Settings, preparation orchestration, translation bridge
extension/popup/                Extension popup UI
extension/content/              YouTube floating control and synced playback
backend/                        Local yt-dlp + Faster Whisper/Volcengine backend
backend/config/helper.json      Backend concurrency configuration
backend/cache/                  Ignored local ASR timeline cache
media/                          Brand/video source assets, not loaded by Chrome
scratch/                        Ignored image generation experiments
```

## Known Limitations

- The MVP currently targets YouTube only.
- Some videos may block `yt-dlp` downloads.
- First preparation can take time because it downloads, transcribes, and translates the video.
- `tiny.en` is fast but less accurate than larger Whisper models.
- Browser TTS voice quality depends on Chrome, the operating system, and installed voices.
- The public Google translation endpoint is unofficial and may be rate-limited or become unavailable.
- A production version should use stable backend services for ASR, translation, and TTS.

## Privacy Notes

API keys are stored in `chrome.storage.local`. Recognized text may be sent to the selected translation provider. If Volcengine ASR is selected, audio is sent by the backend to Volcengine. If Volcengine or Google Cloud TTS is selected, translated text is sent directly from the extension to that TTS provider. Review provider policies before using third-party services.
