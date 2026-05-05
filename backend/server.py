import base64
import contextlib
import hashlib
import json
import os
import platform
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
from pydantic import BaseModel, HttpUrl
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

try:
    import fcntl
except ImportError:
    fcntl = None


CONFIG_PATH = Path(
    os.environ.get(
        "LINGUASTREAM_BACKEND_CONFIG",
        os.environ.get(
            "LINGUASTREAM_HELPER_CONFIG",
            str(Path(__file__).resolve().parent / "config" / "helper.json"),
        ),
    )
)
HELPER_CONFIG = {}
try:
    HELPER_CONFIG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    HELPER_CONFIG = {}

DEFAULT_MODEL = os.environ.get("LINGUASTREAM_ASR_MODEL", "tiny.en")
DEFAULT_VOLCENGINE_MODEL = os.environ.get("LINGUASTREAM_VOLCENGINE_ASR_MODEL", "bigmodel")
VOLCENGINE_ASR_ENDPOINT = os.environ.get(
    "LINGUASTREAM_VOLCENGINE_ASR_ENDPOINT",
    "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
)
DEFAULT_DEVICE = os.environ.get("LINGUASTREAM_ASR_DEVICE", "cpu")
DEFAULT_COMPUTE_TYPE = os.environ.get("LINGUASTREAM_ASR_COMPUTE_TYPE", "int8")
WHISPER_TRANSCRIBE_CONCURRENCY = max(
    1,
    int(
        os.environ.get(
            "LINGUASTREAM_WHISPER_TRANSCRIBE_CONCURRENCY",
            str(HELPER_CONFIG.get("whisperTranscribeConcurrency", 1)),
        )
        or "1"
    ),
)
VERBOSE = os.environ.get("LINGUASTREAM_ASR_VERBOSE", "1") != "0"
YTDLP_COOKIES_BROWSER = os.environ.get("LINGUASTREAM_YTDLP_COOKIES_BROWSER", "").strip()
YTDLP_COOKIES_FILE = os.environ.get("LINGUASTREAM_YTDLP_COOKIES_FILE", "").strip()
YTDLP_BROWSER_PROFILE = os.environ.get("LINGUASTREAM_YTDLP_BROWSER_PROFILE", "").strip()
CACHE_ROOT = Path(
    os.environ.get(
        "LINGUASTREAM_CACHE_DIR",
        str(Path(__file__).resolve().parent / "cache"),
    )
)
PROGRESS_ROOT = CACHE_ROOT / ".progress"

app = FastAPI(title="LinguaStream Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

model_cache = {}
progress_jobs = {}
whisper_transcribe_locks = {}
video_cache_locks = {}
model_cache_lock = threading.Lock()


class PrepareVideoRequest(BaseModel):
    url: HttpUrl
    model: str = ""
    language: str = "en"
    job_id: str = ""
    recognizer_provider: str = "custom"
    recognizer_api_key: str = ""


@app.get("/health")
def health():
    return {
        "ok": True,
        "default_model": DEFAULT_MODEL,
    }


@app.get("/prepare-progress/{job_id}")
def prepare_progress(job_id: str):
    job = progress_jobs.get(safe_name(job_id)) or load_progress(job_id)
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
        "service": "LinguaStream backend",
        "prepare_endpoint": "/prepare-video",
        "legacy_prepare_endpoint": "/prepare-youtube",
        "note": "Configure the extension popup endpoint as http://127.0.0.1:8787",
    }


@app.get("/transcribe")
def transcribe_disabled():
    return {
        "ok": False,
        "message": "Realtime /transcribe is disabled. Use POST /prepare-video.",
    }


@app.get("/favicon.ico")
@app.get("/apple-touch-icon.png")
@app.get("/apple-touch-icon-precomposed.png")
def empty_icon():
    return Response(status_code=204)


@app.post("/prepare-video")
@app.post("/prepare-youtube")
@app.post("/transform")
def prepare_video(payload: PrepareVideoRequest):
    platform_info = platform_info_for_url(str(payload.url))
    provider = normalize_recognizer_provider(payload.recognizer_provider)
    model_name = payload.model.strip() or default_model_for_provider(provider)
    language = payload.language or "en"
    job_id = safe_name(payload.job_id or "")
    update_progress(job_id, "starting", "正在读取视频信息...", 2)
    cache_dir = CACHE_ROOT / platform_info["cache_key"]
    cache_dir.mkdir(parents=True, exist_ok=True)
    timeline_path = cache_dir / f"timeline-{safe_name(provider)}-{safe_name(model_name)}-{safe_name(language)}.json"

    with video_cache_lock(cache_dir):
        cached = load_cached_timeline(timeline_path)
        if cached:
            cleanup_cached_media(cache_dir)
            update_progress(job_id, "ready", f"已复用英文时间线：{len(cached.get('segments') or [])} 段", 35)
            log_event("prepare", f"cache hit: {len(cached.get('segments') or [])} segments: {cached.get('title') or payload.url}")
            return cached

    with video_cache_lock(cache_dir):
        cached = load_cached_timeline(timeline_path)
        if cached:
            cleanup_cached_media(cache_dir)
            update_progress(job_id, "ready", f"已复用英文时间线：{len(cached.get('segments') or [])} 段", 35)
            log_event("prepare", f"cache hit after wait: {len(cached.get('segments') or [])} segments: {cached.get('title') or payload.url}")
            return cached

        if provider == "volcengine":
            update_progress(job_id, "metadata", "准备使用火山引擎识别...", 3)
        else:
            update_progress(job_id, "loading_model", f"正在加载 Whisper {model_name}...", 3)
            whisper = get_model(model_name)
        cleanup_cached_media(cache_dir)
        try:
            audio_path, metadata = download_audio(str(payload.url), cache_dir, job_id, platform_info)
        except DownloadError as error:
            cleanup_cached_media(cache_dir)
            update_progress(job_id, "error", "下载失败", 0)
            raise HTTPException(
                status_code=502,
                detail=(
                    f"yt-dlp could not download this {platform_info['label']} video. "
                    "Try setting LINGUASTREAM_YTDLP_COOKIES_FILE=/path/to/cookies.txt, "
                    f"or LINGUASTREAM_YTDLP_COOKIES_BROWSER=safari/chrome with a browser that is logged into {platform_info['label']}. "
                    f"Original error: {error}"
                ),
            ) from error
        except Exception as error:
            cleanup_cached_media(cache_dir)
            update_progress(job_id, "error", "下载失败", 0)
            raise HTTPException(
                status_code=502,
                detail=f"yt-dlp could not prepare media for this {platform_info['label']} video. Original error: {error}",
            ) from error
        try:
            if provider == "volcengine":
                audio_path = prepare_audio_for_volcengine(audio_path, cache_dir, job_id)
                timeline, detected_language, duration = transcribe_with_volcengine(
                    audio_path,
                    model_name,
                    language,
                    payload.recognizer_api_key.strip(),
                    job_id,
                )
            else:
                update_progress(job_id, "transcribing", "下载完成，正在识别英文...", 32)
                with whisper_transcribe_slot(model_name):
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

        if not timeline:
            update_progress(job_id, "error", "未识别到语音", 0)
            raise HTTPException(
                status_code=422,
                detail=(
                    "The backend did not detect any usable speech segments. "
                    "This can happen when the video has little speech, the downloaded format contains no usable audio, "
                    "or the selected ASR provider returned an empty result."
                ),
            )

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
        write_json_atomic(timeline_path, result)
        log_event("prepare", f"{len(timeline)} segments: {metadata.get('title') or payload.url}")
        return result


def normalize_recognizer_provider(provider: str):
    normalized = str(provider or "").strip().lower()
    if normalized == "volcengine":
        return normalized
    return "custom"


def default_model_for_provider(provider: str):
    if provider == "volcengine":
        return DEFAULT_VOLCENGINE_MODEL
    return DEFAULT_MODEL


def transcribe_with_volcengine(audio_path: str, model_name: str, language: str, api_key: str, job_id: str = ""):
    if not api_key:
        raise HTTPException(status_code=400, detail="Volcengine ASR provider requires an AppKey")

    update_progress(job_id, "transcribing", "下载完成，正在调用火山引擎识别...", 32)
    path = Path(audio_path)
    audio_bytes = path.read_bytes()
    if len(audio_bytes) > 100 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Volcengine ASR input must be no larger than 100MB")

    app_key, access_key = parse_volcengine_credentials(api_key)
    headers = {
        "Content-Type": "application/json",
        "X-Api-Resource-Id": "volc.bigasr.auc_turbo",
        "X-Api-Request-Id": str(uuid.uuid4()),
        "X-Api-Sequence": "-1",
    }
    if access_key:
        headers["X-Api-App-Key"] = app_key
        headers["X-Api-Access-Key"] = access_key
    else:
        headers["X-Api-Key"] = app_key
    request_body = {
        "user": {
            "uid": app_key,
        },
        "audio": {
            "data": base64.b64encode(audio_bytes).decode("ascii"),
        },
        "request": {
            "model_name": model_name or DEFAULT_VOLCENGINE_MODEL,
        },
    }
    response = requests.post(
        VOLCENGINE_ASR_ENDPOINT,
        headers=headers,
        json=request_body,
        timeout=(15, 600),
    )

    volc_status = response.headers.get("X-Api-Status-Code", "")
    volc_message = response.headers.get("X-Api-Message", "")
    volc_logid = response.headers.get("X-Tt-Logid", "")

    if response.status_code >= 400:
        log_event("volcengine", f"HTTP {response.status_code}: {response.text[:500]}")
        detail = format_volcengine_error(response, volc_status, volc_message, volc_logid, app_key)
        raise HTTPException(
            status_code=502,
            detail=detail,
        )
    if volc_status and volc_status != "20000000":
        log_event("volcengine", f"code {volc_status}: {volc_message} logid={volc_logid}")
        raise HTTPException(
            status_code=502,
            detail=(
                f"Volcengine transcription failed with code {volc_status}"
                f"{f': {volc_message}' if volc_message else ''}"
                f"{f' logid={volc_logid}' if volc_logid else ''}"
            ),
        )

    payload = response.json()
    status_code = str(payload.get("code") or payload.get("status_code") or payload.get("status") or "")
    if status_code and status_code not in {"0", "1000", "success", "Success"}:
        log_event("volcengine", f"payload error: {json.dumps(payload, ensure_ascii=False)[:500]}")
        raise HTTPException(
            status_code=502,
            detail=f"Volcengine transcription failed: {json.dumps(payload, ensure_ascii=False)[:500]}",
        )

    result = payload.get("result") or payload
    raw_utterances = (
        result.get("utterances")
        or result.get("segments")
        or result.get("sentences")
        or []
    )
    timeline = [segment for segment in (volcengine_utterance_to_segment(item) for item in raw_utterances) if segment]
    if not timeline:
        text = str(result.get("text") or payload.get("text") or "").strip()
        if text:
            duration = parse_duration_seconds(result)
            timeline = [{"start": 0.0, "end": duration, "text": text}]
    duration = max((segment["end"] for segment in timeline), default=parse_duration_seconds(result))
    return timeline, language, float(duration or 0)


def format_volcengine_error(response, status_code: str = "", message: str = "", logid: str = "", app_key: str = ""):
    response_text = response.text[:500]
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    header = payload.get("header") if isinstance(payload, dict) else {}
    volc_code = str(status_code or header.get("code") or "")
    volc_message = str(message or header.get("message") or "").strip()
    volc_logid = str(logid or header.get("logid") or header.get("reqid") or "").strip()

    if response.status_code == 401 or "Invalid X-Api-Key" in response_text or volc_code == "45000010":
        return (
            "Volcengine ASR rejected the API key. "
            "For the new console, paste the App Key from Doubao Voice / API Key management. "
            "For the old console, paste AppKey:AccessKey. "
            "Also confirm the volc.bigasr.auc_turbo resource is enabled."
            f"{f' logid={volc_logid}' if volc_logid else ''}"
        )
    if volc_code == "45000030" or "requested resource not granted" in response_text:
        app_hint = mask_secret(app_key)
        return (
            "Volcengine ASR resource is not granted. LinguaStream currently calls the "
            "recording-file recognition Turbo API, which requires the volc.bigasr.auc_turbo "
            "resource. Check that the APP ID/API Key used here is the one from the Turbo tab, "
            "not the Standard tab, and that the selected application shows Turbo service enabled."
            f"{f' app={app_hint}' if app_hint else ''}"
            f"{f' logid={volc_logid}' if volc_logid else ''}"
        )

    return (
        f"Volcengine transcription failed with HTTP {response.status_code}"
        f"{f' code {volc_code}' if volc_code else ''}"
        f"{f': {volc_message}' if volc_message else ''}"
        f"{f' logid={volc_logid}' if volc_logid else ''}"
        f": {response_text}"
    )


def parse_volcengine_credentials(value: str):
    parts = [
        part.strip()
        for part in str(value or "").replace("\n", ":").replace(",", ":").split(":")
        if part.strip()
    ]
    app_key = parts[0] if parts else ""
    access_key = parts[1] if len(parts) > 1 else ""
    if not app_key:
        raise HTTPException(status_code=400, detail="Volcengine AppKey is empty")
    return app_key, access_key


def mask_secret(value: str):
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) <= 8:
        return f"{text[:2]}***{text[-2:]}"
    return f"{text[:4]}***{text[-4:]}"


def prepare_audio_for_volcengine(audio_path: str, cache_dir: Path, job_id: str = ""):
    path = Path(audio_path)
    if path.suffix.lower() in {".mp3", ".wav", ".ogg"}:
        return str(path)

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise HTTPException(
            status_code=502,
            detail=(
                "Volcengine ASR only accepts audio files such as MP3/WAV/OGG. "
                "Install ffmpeg so LinguaStream can extract audio from the downloaded video media."
            ),
        )

    output_path = Path(cache_dir) / "source.asr.mp3"
    update_progress(job_id, "converting", "下载完成，正在抽取音频...", 31)
    command = [
        ffmpeg,
        "-y",
        "-i",
        str(path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        str(output_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0 or not output_path.exists():
        message = (completed.stderr or completed.stdout or "unknown ffmpeg error").strip()
        log_event("ffmpeg", message[:500])
        raise HTTPException(
            status_code=502,
            detail=f"Failed to extract MP3 audio for Volcengine ASR: {message[:500]}",
        )
    return str(output_path)


def volcengine_utterance_to_segment(item: dict):
    if not isinstance(item, dict):
        return None
    text = str(item.get("text") or item.get("utterance") or item.get("sentence") or "").strip()
    if not text:
        return None
    start = first_number(item, "start_time", "start", "start_ms", "begin_time", "begin")
    end = first_number(item, "end_time", "end", "end_ms", "stop_time", "stop")
    start = normalize_volcengine_time(start)
    end = normalize_volcengine_time(end)
    if end <= start:
        end = start + max(1.2, min(6, len(text) / 6))
    return {
        "start": start,
        "end": end,
        "text": text,
    }


def first_number(item: dict, *keys: str):
    for key in keys:
        value = item.get(key)
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str) and value.strip():
            try:
                return float(value)
            except ValueError:
                continue
    return 0.0


def normalize_volcengine_time(value: float):
    value = float(value or 0)
    return value / 1000 if value > 1000 else value


def parse_duration_seconds(result: dict):
    duration = first_number(result, "duration", "audio_duration", "duration_ms")
    return normalize_volcengine_time(duration)

def download_audio(url: str, output_dir: Path, job_id: str = "", platform_info: dict | None = None):
    platform_info = platform_info or platform_info_for_url(url)
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
            "Referer": platform_info["referer"],
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
    safe_job_id = safe_name(job_id)
    progress_jobs[safe_job_id] = {
        "phase": phase,
        "text": text,
        "progress": max(0, min(100, int(progress))),
        "updated_at": time.time(),
    }
    save_progress(safe_job_id, progress_jobs[safe_job_id])


def load_progress(job_id: str):
    path = progress_path(job_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def save_progress(job_id: str, payload: dict):
    try:
        PROGRESS_ROOT.mkdir(parents=True, exist_ok=True)
        write_json_atomic(progress_path(job_id), payload)
    except OSError:
        pass


def progress_path(job_id: str):
    return PROGRESS_ROOT / f"{safe_name(job_id)}.json"


def write_json_atomic(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


@contextlib.contextmanager
def video_cache_lock(cache_dir: Path):
    cache_dir.mkdir(parents=True, exist_ok=True)
    lock_path = cache_dir / ".prepare.lock"
    if not fcntl:
        lock = get_video_cache_thread_lock(cache_dir)
        lock.acquire()
        try:
            yield
        finally:
            lock.release()
        return

    with lock_path.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def get_video_cache_thread_lock(cache_dir: Path):
    key = str(cache_dir.resolve())
    with model_cache_lock:
        if key not in video_cache_locks:
            video_cache_locks[key] = threading.Lock()
        return video_cache_locks[key]


@contextlib.contextmanager
def whisper_transcribe_slot(model_name: str):
    slot = get_whisper_transcribe_lock(model_name)
    slot.acquire()
    try:
        yield
    finally:
        slot.release()


def get_whisper_transcribe_lock(model_name: str):
    key = safe_name(model_name)
    if key not in whisper_transcribe_locks:
        whisper_transcribe_locks[key] = threading.BoundedSemaphore(WHISPER_TRANSCRIBE_CONCURRENCY)
    return whisper_transcribe_locks[key]


def load_cached_timeline(path: Path):
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    segments = data.get("segments")
    if not isinstance(segments, list) or not segments:
        try:
            path.unlink()
            log_event("prepare", f"removed empty timeline cache: {path.name}")
        except OSError:
            pass
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
    return platform_info_for_url(url)["cache_key"]


def platform_info_for_url(url: str):
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    query = parse_qs(parsed.query)

    if "youtube.com" in host:
        video_id = (query.get("v") or [""])[0]
        if video_id:
            return {
                "name": "youtube",
                "label": "YouTube",
                "cache_key": f"youtube-{safe_name(video_id)}",
                "referer": "https://www.youtube.com/",
            }
    if "youtu.be" in host:
        video_id = parsed.path.strip("/").split("/")[0]
        if video_id:
            return {
                "name": "youtube",
                "label": "YouTube",
                "cache_key": f"youtube-{safe_name(video_id)}",
                "referer": "https://www.youtube.com/",
            }

    bilibili_id = bilibili_video_id(parsed)
    if bilibili_id:
        part = (query.get("p") or [""])[0]
        cache_id = f"{bilibili_id}-p{part}" if part else bilibili_id
        return {
            "name": "bilibili",
            "label": "Bilibili",
            "cache_key": f"bilibili-{safe_name(cache_id)}",
            "referer": "https://www.bilibili.com/",
        }

    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    return {
        "name": "url",
        "label": "online",
        "cache_key": f"url-{digest}",
        "referer": f"{parsed.scheme}://{host}/" if parsed.scheme and host else "https://www.youtube.com/",
    }


def bilibili_video_id(parsed):
    host = parsed.netloc.lower()
    if "b23.tv" in host:
        short_id = parsed.path.strip("/").split("/")[0]
        return short_id or ""
    if "bilibili.com" not in host:
        return ""

    parts = [part for part in parsed.path.split("/") if part]
    for part in parts:
        if part.startswith(("BV", "bv", "av", "AV", "ep", "EP", "ss", "SS", "md", "MD")):
            return part
    return ""


def safe_name(value: str):
    return "".join(char if char.isalnum() or char in {"-", "_", "."} else "_" for char in value)[:80] or "default"


def choose_audio_format(metadata: dict) -> str:
    formats = metadata.get("formats") or []
    combined_fallback = [
        item for item in formats
        if item.get("format_id")
        and item.get("acodec") not in {None, "none"}
        and item.get("vcodec") not in {None, "none"}
    ]
    for preferred_id in ("18", "22"):
        if any(item.get("format_id") == preferred_id for item in combined_fallback):
            return preferred_id

    audio_only = [
        item for item in formats
        if item.get("format_id")
        and item.get("acodec") not in {None, "none"}
        and item.get("vcodec") in {None, "none"}
    ]
    candidates = audio_only or combined_fallback
    if not candidates:
        raise DownloadError("No downloadable audio format was found")

    def score(item):
        ext_score = {"m4a": 0, "webm": 1, "mp4": 2}.get(item.get("ext"), 3)
        abr = item.get("abr") or item.get("tbr") or 9999
        return (ext_score, abs(float(abr) - 128))

    return min(candidates, key=score)["format_id"]


def cookies_from_browser_arg(browser: str):
    normalized = browser.strip().lower().replace("-", "_")
    if YTDLP_BROWSER_PROFILE:
        return (yt_dlp_browser_name(normalized), YTDLP_BROWSER_PROFILE, None, None)
    profile_path = detect_browser_profile_path(normalized)
    if profile_path:
        return (yt_dlp_browser_name(normalized), str(profile_path), None, None)
    return (browser,)


def yt_dlp_browser_name(normalized: str):
    if normalized in {"chrome_canary", "canary", "chromium", "google_chrome"}:
        return "chrome"
    if normalized in {"edge", "microsoft_edge"}:
        return "edge"
    if normalized in {"brave", "brave_browser"}:
        return "brave"
    return normalized.replace("_", "-")


def detect_browser_profile_path(normalized: str):
    candidates = browser_profile_candidates(normalized)
    for candidate in candidates:
        if candidate.exists():
            return candidate
    if candidates:
        log_event(
            "cookies",
            f"no profile path found for {normalized}; tried: {', '.join(str(path) for path in candidates)}",
        )
    return None


def browser_profile_candidates(normalized: str):
    home = Path.home()
    system = platform.system().lower()
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    app_data = os.environ.get("APPDATA", "")

    browser_paths = {
        "darwin": {
            "chrome": [home / "Library/Application Support/Google/Chrome"],
            "google_chrome": [home / "Library/Application Support/Google/Chrome"],
            "chrome_canary": [home / "Library/Application Support/Google/Chrome Canary"],
            "canary": [home / "Library/Application Support/Google/Chrome Canary"],
            "chromium": [home / "Library/Application Support/Chromium"],
            "edge": [home / "Library/Application Support/Microsoft Edge"],
            "microsoft_edge": [home / "Library/Application Support/Microsoft Edge"],
            "brave": [home / "Library/Application Support/BraveSoftware/Brave-Browser"],
            "brave_browser": [home / "Library/Application Support/BraveSoftware/Brave-Browser"],
        },
        "windows": {
            "chrome": [Path(local_app_data) / "Google/Chrome/User Data"] if local_app_data else [],
            "google_chrome": [Path(local_app_data) / "Google/Chrome/User Data"] if local_app_data else [],
            "chrome_canary": [Path(local_app_data) / "Google/Chrome SxS/User Data"] if local_app_data else [],
            "canary": [Path(local_app_data) / "Google/Chrome SxS/User Data"] if local_app_data else [],
            "chromium": [Path(local_app_data) / "Chromium/User Data"] if local_app_data else [],
            "edge": [Path(local_app_data) / "Microsoft/Edge/User Data"] if local_app_data else [],
            "microsoft_edge": [Path(local_app_data) / "Microsoft/Edge/User Data"] if local_app_data else [],
            "brave": [Path(local_app_data) / "BraveSoftware/Brave-Browser/User Data"] if local_app_data else [],
            "brave_browser": [Path(local_app_data) / "BraveSoftware/Brave-Browser/User Data"] if local_app_data else [],
        },
        "linux": {
            "chrome": [
                home / ".config/google-chrome",
                home / ".config/google-chrome-beta",
                home / ".config/google-chrome-unstable",
            ],
            "google_chrome": [
                home / ".config/google-chrome",
                home / ".config/google-chrome-beta",
                home / ".config/google-chrome-unstable",
            ],
            "chrome_canary": [
                home / ".config/google-chrome-unstable",
                home / ".config/google-chrome",
            ],
            "canary": [
                home / ".config/google-chrome-unstable",
                home / ".config/google-chrome",
            ],
            "chromium": [home / ".config/chromium"],
            "edge": [home / ".config/microsoft-edge"],
            "microsoft_edge": [home / ".config/microsoft-edge"],
            "brave": [home / ".config/BraveSoftware/Brave-Browser"],
            "brave_browser": [home / ".config/BraveSoftware/Brave-Browser"],
        },
    }

    if system.startswith("darwin"):
        key = "darwin"
    elif system.startswith("win"):
        key = "windows"
    else:
        key = "linux"

    candidates = browser_paths.get(key, {}).get(normalized, [])
    if normalized == "firefox" and app_data:
        candidates.append(Path(app_data) / "Mozilla/Firefox")
    return candidates


def get_model(model_name: str):
    with model_cache_lock:
        if model_name not in model_cache:
            model_cache[model_name] = WhisperModel(
                model_name,
                device=DEFAULT_DEVICE,
                compute_type=DEFAULT_COMPUTE_TYPE,
            )
        return model_cache[model_name]


def log_event(kind: str, message: str):
    if VERBOSE:
        print(f"[LinguaStream Backend] {kind}: {message}", flush=True)
