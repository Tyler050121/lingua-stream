import hashlib
import json
import os
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
from pydantic import BaseModel, HttpUrl
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError


DEFAULT_MODEL = os.environ.get("LINGUASTREAM_ASR_MODEL", "tiny.en")
DEFAULT_OPENAI_MODEL = os.environ.get("LINGUASTREAM_OPENAI_ASR_MODEL", "whisper-1")
DEFAULT_DEVICE = os.environ.get("LINGUASTREAM_ASR_DEVICE", "cpu")
DEFAULT_COMPUTE_TYPE = os.environ.get("LINGUASTREAM_ASR_COMPUTE_TYPE", "int8")
VERBOSE = os.environ.get("LINGUASTREAM_ASR_VERBOSE", "1") != "0"
YTDLP_COOKIES_BROWSER = os.environ.get("LINGUASTREAM_YTDLP_COOKIES_BROWSER", "").strip()
YTDLP_COOKIES_FILE = os.environ.get("LINGUASTREAM_YTDLP_COOKIES_FILE", "").strip()
CANARY_PROFILE_PATH = Path.home() / "Library/Application Support/Google/Chrome Canary"
CACHE_ROOT = Path(
    os.environ.get(
        "LINGUASTREAM_CACHE_DIR",
        str(Path(__file__).resolve().parent / "cache"),
    )
)

app = FastAPI(title="LinguaStream Local ASR")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

model_cache = {}
progress_jobs = {}


class PrepareYouTubeRequest(BaseModel):
    url: HttpUrl
    model: str = ""
    language: str = "en"
    job_id: str = ""
    recognizer_provider: str = "custom"
    recognizer_api_key: str = ""


@app.get("/health")
def health():
    return {"ok": True, "default_model": DEFAULT_MODEL}


@app.get("/prepare-progress/{job_id}")
def prepare_progress(job_id: str):
    job = progress_jobs.get(safe_name(job_id))
    if not job:
        return {
            "ok": False,
            "phase": "idle",
            "progress": 0,
            "text": "",
        }
    return {"ok": True, **job}


@app.get("/")
def root():
    return {
        "ok": True,
        "service": "LinguaStream local helper",
        "prepare_endpoint": "/prepare-youtube",
        "note": "Configure the extension popup endpoint as http://127.0.0.1:8787",
    }


@app.get("/transcribe")
def transcribe_disabled():
    return {
        "ok": False,
        "message": "Realtime /transcribe is disabled. Use POST /prepare-youtube.",
    }


@app.get("/favicon.ico")
@app.get("/apple-touch-icon.png")
@app.get("/apple-touch-icon-precomposed.png")
def empty_icon():
    return Response(status_code=204)


@app.post("/prepare-youtube")
@app.post("/transform")
def prepare_youtube(payload: PrepareYouTubeRequest):
    provider = normalize_recognizer_provider(payload.recognizer_provider)
    model_name = payload.model.strip() or (DEFAULT_OPENAI_MODEL if provider == "openai" else DEFAULT_MODEL)
    language = payload.language or "en"
    job_id = safe_name(payload.job_id or "")
    update_progress(job_id, "starting", "正在读取视频信息...", 2)
    cache_dir = CACHE_ROOT / cache_key_for_url(str(payload.url))
    cache_dir.mkdir(parents=True, exist_ok=True)
    timeline_path = cache_dir / f"timeline-{safe_name(provider)}-{safe_name(model_name)}-{safe_name(language)}.json"

    cached = load_cached_timeline(timeline_path)
    if cached:
        cleanup_cached_media(cache_dir)
        update_progress(job_id, "ready", f"已复用英文时间线：{len(cached.get('segments') or [])} 段", 35)
        log_event("prepare", f"cache hit: {len(cached.get('segments') or [])} segments: {cached.get('title') or payload.url}")
        return cached

    if provider == "openai":
        update_progress(job_id, "metadata", "准备使用 OpenAI 识别...", 3)
    else:
        update_progress(job_id, "loading_model", f"正在加载 Whisper {model_name}...", 3)
        whisper = get_model(model_name)
    cleanup_cached_media(cache_dir)
    try:
        audio_path, metadata = download_audio(str(payload.url), cache_dir, job_id)
    except DownloadError as error:
        update_progress(job_id, "error", "下载失败", 0)
        raise HTTPException(
            status_code=502,
            detail=(
                "yt-dlp could not download this YouTube video. "
                "Try setting LINGUASTREAM_YTDLP_COOKIES_FILE=/path/to/cookies.txt, "
                "or LINGUASTREAM_YTDLP_COOKIES_BROWSER=safari/chrome with a browser that is logged into YouTube. "
                f"Original error: {error}"
            ),
        ) from error
    try:
        if provider == "openai":
            timeline, detected_language, duration = transcribe_with_openai(
                audio_path,
                model_name,
                language,
                payload.recognizer_api_key.strip(),
                job_id,
            )
        else:
            update_progress(job_id, "transcribing", "下载完成，正在识别英文...", 32)
            segments, info = whisper.transcribe(
                audio_path,
                language=language,
                beam_size=1,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            timeline = [
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": segment.text.strip(),
                }
                for segment in segments
                if segment.text.strip()
            ]
            detected_language = info.language
            duration = info.duration
        update_progress(job_id, "ready", f"识别完成：{len(timeline)} 段", 35)
    finally:
        cleanup_cached_media(cache_dir)

    result = {
        "ok": True,
        "title": metadata.get("title") or "",
        "duration": metadata.get("duration") or duration,
        "language": detected_language,
        "model": model_name,
        "provider": provider,
        "cache_dir": str(cache_dir),
        "media_path": "",
        "cached": False,
        "segments": timeline,
    }
    timeline_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    log_event("prepare", f"{len(timeline)} segments: {metadata.get('title') or payload.url}")
    return result


def normalize_recognizer_provider(provider: str):
    return "openai" if str(provider or "").strip().lower() == "openai" else "custom"


def transcribe_with_openai(audio_path: str, model_name: str, language: str, api_key: str, job_id: str = ""):
    if not api_key:
        raise HTTPException(status_code=400, detail="OpenAI ASR provider requires an API key")

    update_progress(job_id, "transcribing", "下载完成，正在调用 OpenAI 识别...", 32)
    headers = {"Authorization": f"Bearer {api_key}"}
    data = {
        "model": model_name or DEFAULT_OPENAI_MODEL,
        "language": language,
        "response_format": "verbose_json",
        "timestamp_granularities[]": "segment",
    }
    with open(audio_path, "rb") as audio_file:
        response = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers=headers,
            data=data,
            files={"file": audio_file},
            timeout=(15, 600),
        )

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"OpenAI transcription failed with HTTP {response.status_code}: {response.text[:500]}",
        )

    payload = response.json()
    raw_segments = payload.get("segments") or []
    timeline = [
        {
            "start": float(segment.get("start") or 0),
            "end": float(segment.get("end") or 0),
            "text": str(segment.get("text") or "").strip(),
        }
        for segment in raw_segments
        if str(segment.get("text") or "").strip()
    ]
    if not timeline and payload.get("text"):
        timeline = [{"start": 0.0, "end": float(payload.get("duration") or 0), "text": payload["text"].strip()}]
    return timeline, payload.get("language") or language, float(payload.get("duration") or 0)


def download_audio(url: str, output_dir: Path, job_id: str = ""):
    output_template = str(Path(output_dir) / "source.%(ext)s")
    options = {
        "outtmpl": output_template,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/121.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
        "progress_hooks": [make_progress_hook(job_id)],
    }
    if YTDLP_COOKIES_FILE:
        options["cookiefile"] = YTDLP_COOKIES_FILE
    elif YTDLP_COOKIES_BROWSER:
        options["cookiesfrombrowser"] = cookies_from_browser_arg(YTDLP_COOKIES_BROWSER)

    try:
        metadata, filename = run_ytdlp(url, output_dir, options, job_id)
    except DownloadError as error:
        if YTDLP_COOKIES_FILE or not YTDLP_COOKIES_BROWSER:
            raise
        log_event("yt-dlp", f"browser cookies failed, retrying without cookies: {error}")
        options.pop("cookiesfrombrowser", None)
        metadata, filename = run_ytdlp(url, output_dir, options, job_id)
    return str(filename), metadata


def run_ytdlp(url: str, output_dir: str, options: dict, job_id: str = ""):
    update_progress(job_id, "metadata", "正在读取视频格式...", 4)
    with YoutubeDL({**options, "skip_download": True}) as ydl:
        metadata = ydl.extract_info(url, download=False)
        format_id = choose_audio_format(metadata)
        log_event("yt-dlp", f"selected format {format_id}")

    update_progress(job_id, "downloading", "正在下载音频 0%", 5)
    with YoutubeDL({**options, "format": format_id}) as ydl:
        metadata = ydl.extract_info(url, download=True)
        filename = Path(ydl.prepare_filename(metadata))
        if not filename.exists():
            candidates = sorted(Path(output_dir).glob("source.*"))
            if not candidates:
                raise FileNotFoundError("yt-dlp did not produce an audio file")
            filename = candidates[0]
    return metadata, filename


def make_progress_hook(job_id: str):
    def hook(info: dict):
        status = info.get("status")
        if status == "downloading":
            downloaded = info.get("downloaded_bytes") or 0
            total = info.get("total_bytes") or info.get("total_bytes_estimate") or 0
            if total:
                ratio = max(0, min(1, downloaded / total))
                percent = round(ratio * 100)
                progress = 5 + round(ratio * 25)
                update_progress(job_id, "downloading", f"正在下载音频 {percent}%", progress)
            else:
                update_progress(job_id, "downloading", "正在下载音频...", 8)
        elif status == "finished":
            update_progress(job_id, "downloaded", "下载完成，正在处理音频...", 30)

    return hook


def update_progress(job_id: str, phase: str, text: str, progress: int):
    if not job_id:
        return
    progress_jobs[safe_name(job_id)] = {
        "phase": phase,
        "text": text,
        "progress": max(0, min(100, int(progress))),
        "updated_at": time.time(),
    }


def load_cached_timeline(path: Path):
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    data["cached"] = True
    data["cache_dir"] = str(path.parent)
    data["media_path"] = ""
    return data


def cleanup_cached_media(cache_dir: Path):
    for path in Path(cache_dir).glob("source.*"):
        if path.is_file() and path.suffix != ".json":
            try:
                path.unlink()
            except OSError:
                pass


def cache_key_for_url(url: str):
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    query = parse_qs(parsed.query)
    video_id = ""
    if "youtube.com" in host:
        video_id = (query.get("v") or [""])[0]
    elif "youtu.be" in host:
        video_id = parsed.path.strip("/").split("/")[0]

    if video_id:
        return f"youtube-{safe_name(video_id)}"

    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    return f"url-{digest}"


def safe_name(value: str):
    return "".join(char if char.isalnum() or char in {"-", "_", "."} else "_" for char in value)[:80] or "default"


def choose_audio_format(metadata: dict) -> str:
    formats = metadata.get("formats") or []
    combined_fallback = [
        item for item in formats
        if item.get("format_id")
        and item.get("acodec") not in {None, "none"}
        and item.get("vcodec") not in {None, "none"}
        and item.get("protocol") in {None, "https", "http"}
    ]
    for preferred_id in ("18", "22"):
        if any(item.get("format_id") == preferred_id for item in combined_fallback):
            return preferred_id

    audio_only = [
        item for item in formats
        if item.get("format_id")
        and item.get("acodec") not in {None, "none"}
        and item.get("vcodec") in {None, "none"}
        and item.get("protocol") in {None, "https", "http"}
    ]
    candidates = combined_fallback or audio_only
    if not candidates:
        raise DownloadError("No downloadable audio format was found")

    def score(item):
        ext_score = {"m4a": 0, "webm": 1, "mp4": 2}.get(item.get("ext"), 3)
        abr = item.get("abr") or item.get("tbr") or 9999
        return (ext_score, abs(float(abr) - 128))

    return min(candidates, key=score)["format_id"]


def cookies_from_browser_arg(browser: str):
    normalized = browser.strip().lower().replace("-", "_")
    if normalized in {"chrome_canary", "canary"}:
        return ("chrome", str(CANARY_PROFILE_PATH), None, None)
    return (browser,)


def get_model(model_name: str):
    if model_name not in model_cache:
        model_cache[model_name] = WhisperModel(
            model_name,
            device=DEFAULT_DEVICE,
            compute_type=DEFAULT_COMPUTE_TYPE,
        )
    return model_cache[model_name]


def log_event(kind: str, message: str):
    if VERBOSE:
        print(f"[LinguaStream ASR] {kind}: {message}", flush=True)
