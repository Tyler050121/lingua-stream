# LinguaStream

[English](README.md) | [中文](README.zh-CN.md)

LinguaStream is a Chrome Manifest V3 extension that prepares a translated voice track for online videos. The current MVP focuses on YouTube and uses a **prepare first, then play** workflow instead of realtime tab-audio capture.

## What It Does

1. A local helper temporarily downloads YouTube media with `yt-dlp`.
2. Faster Whisper or OpenAI transcribes the video into timestamped English segments.
3. The extension translates the timeline into the selected target language.
4. The YouTube page speaks the translated timeline in sync with `video.currentTime`.
5. Translation timelines are cached, so the same video does not need to be translated again unless you force retry.

## Current Status

This is an MVP for local use and early open-source development.

- Supported site: YouTube video pages.
- Default ASR path: local helper + Faster Whisper.
- Optional ASR provider: OpenAI via the local helper.
- Default TTS path: Chrome Web Speech API.
- Translation: public Google endpoint or a custom translation API.
- Realtime microphone/tab-audio ASR is intentionally disabled.

## Load the Extension Locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the project root folder.
5. Open a YouTube video.
6. Use the LinguaStream floating control in the lower-right corner of the video page.

Preparing a video does not automatically start speaking. After preparation finishes, use the floating control to play, pause, cancel, or retry the translated voice track.

## Run the Local Helper

```bash
cd tools/local-asr
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8787
```

In the extension popup, set:

- `ASR > Provider`: `Custom`
- `ASR > BaseURL`: `http://127.0.0.1:8787`

The extension calls:

- `POST /prepare-youtube`
- `GET /prepare-progress/<job_id>`

## Popup Settings

### Basic

- `Target Language`: translation and speech target language.

### Voice

- `Voice Provider`: `Browser` uses Chrome Web Speech API. `Custom` is reserved for future external TTS providers.
- `Voice`: system/browser voice for the selected target language.
- `Voice Volume`: translated speech volume.
- `Original Volume`: original video volume while translated voice playback is enabled. `100%` means no ducking.

### ASR

- `Provider`: `Custom` for the local helper, or `OpenAI` through the local helper.
- `BaseURL`: local helper URL for `Custom`; OpenAI base URL is shown but locked when OpenAI is selected.
- `API Key`: required for OpenAI ASR, optional for custom helper services.
- `Model`: Faster Whisper model such as `tiny.en`, or OpenAI model such as `whisper-1`.

### Translate

- `Provider`: public Google endpoint or custom API.
- `BaseURL`: custom translation endpoint.
- `API Key`: optional for custom APIs.

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
tools/local-asr/cache/
```

For YouTube videos, the folder usually looks like:

```text
tools/local-asr/cache/youtube-<video_id>/
```

Media files are temporary and are deleted after transcription. To move the cache:

```bash
LINGUASTREAM_CACHE_DIR=/absolute/path/to/cache uvicorn server:app --host 127.0.0.1 --port 8787
```

Translated timelines are cached in Chrome extension storage. Use the retry action in the floating control to force a fresh translation pass.

## YouTube Download Notes

By default, the helper does not read browser cookies.

If YouTube returns `HTTP Error 403: Forbidden`, run the helper with browser cookies:

```bash
LINGUASTREAM_YTDLP_COOKIES_BROWSER=chrome uvicorn server:app --host 127.0.0.1 --port 8787
```

For Chrome Canary:

```bash
LINGUASTREAM_YTDLP_COOKIES_BROWSER=chrome_canary uvicorn server:app --host 127.0.0.1 --port 8787
```

If browser cookies trigger Keychain prompts or fail, export YouTube cookies to a Netscape-format `cookies.txt` file:

```bash
LINGUASTREAM_YTDLP_COOKIES_FILE=/absolute/path/to/cookies.txt uvicorn server:app --host 127.0.0.1 --port 8787
```

## Project Structure

```text
manifest.json                  Chrome MV3 manifest
background/service-worker.js    Settings, preparation orchestration, translation bridge
popup/                          Extension popup UI
src/content/control-button.js   YouTube floating control
src/content/content-script.js   Timeline playback synced to video time
tools/local-asr/server.py       Local yt-dlp + Faster Whisper/OpenAI helper
assets/                         Icons and brand assets
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

API keys are stored in `chrome.storage.local`. Recognized text may be sent to the selected translation provider. If OpenAI ASR is selected, audio is sent by the local helper to OpenAI. Review provider policies before using third-party services.
