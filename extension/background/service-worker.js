const DEFAULT_SETTINGS = {
  duckOriginalAudio: false,
  targetLanguage: "zh-CN",
  recognizerType: "custom",
  asrProvider: "custom",
  asrEndpoint: "http://127.0.0.1:8787",
  asrCustomBaseUrl: "",
  asrCustomApiKey: "",
  asrVolcengineMode: "turbo",
  asrVolcengineAppId: "",
  asrVolcengineAccessToken: "",
  asrModel: "",
  duckVolumeLevel: 0.25,
  ttsProvider: "browser",
  ttsBaseUrl: "",
  ttsApiKey: "",
  ttsModel: "",
  ttsVolcengineAppId: "",
  ttsVolcengineAccessToken: "",
  ttsVolcengineCluster: "volcano_tts",
  ttsVolcengineVoiceType: "BV700_V2_streaming",
  ttsVolume: 1,
  ttsVoiceURI: "",
  translatorType: "publicGoogle",
  apiEndpoint: "",
  apiKey: "",
  deepSeekApiKey: "",
  deepSeekModel: "deepseek-chat",
  settingsVersion: 18
};

const SUPPORTED_TARGET_LANGUAGES = new Set(["zh-CN", "zh-TW", "ja-JP", "ko-KR", "en-US"]);

const preparePorts = new Map();
const prepareSessions = new Map();
const translationCache = new Map();
const translationInFlight = new Map();
const speechCache = new Map();
const TIMELINE_CACHE_PREFIX = "linguastream:timeline:";
const TRANSLATION_CACHE_PREFIX = "linguastream:translation:";
const MAX_SPEECH_CACHE_ITEMS = 120;
const RUNTIME_CONFIG = globalThis.LinguaStreamRuntimeConfig || {};
const TRANSLATION_CONCURRENCY = {
  publicGoogle: 6,
  deepseek: 4,
  api: 4,
  ...(RUNTIME_CONFIG.translationConcurrency || {})
};
const PARTIAL_PLAYBACK_MIN_SEGMENTS = Math.max(
  1,
  Number(RUNTIME_CONFIG.partialPlaybackMinSegments) || 20
);

chrome.runtime.onInstalled.addListener(async () => {
  await getSettings();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "prepare-progress") return;
  port.onMessage.addListener((message) => {
    if (message?.type === "REGISTER_PREPARE_PROGRESS" && message.tabId) {
      preparePorts.set(message.tabId, port);
    }
  });
  port.onDisconnect.addListener(() => {
    for (const [tabId, candidate] of preparePorts.entries()) {
      if (candidate === port) preparePorts.delete(tabId);
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error("[LinguaStream] background error", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function handleMessage(message, sender = {}) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Invalid message" };
  }

  if (message.type === "GET_SETTINGS") {
    const settings = await getSettings();
    return { ok: true, settings };
  }

  if (message.type === "SAVE_SETTINGS") {
    const nextSettings = sanitizeSettings(message.settings || {});
    await chrome.storage.local.set({ ...nextSettings, settingsVersion: DEFAULT_SETTINGS.settingsVersion });
    return { ok: true, settings: await getSettings() };
  }

  if (message.type === "TRANSLATE_TEXTS") {
    const texts = Array.isArray(message.texts) ? message.texts : [];
    const settings = await getSettings();
    const translations = await translateTexts(texts, settings);
    return { ok: true, translations };
  }

  if (message.type === "SYNTHESIZE_SPEECH") {
    const settings = await getSettings();
    return synthesizeSpeech(message.text || "", settings, {
      rate: Number(message.rate) || 1,
      targetLanguage: message.targetLanguage
    });
  }

  if (message.type === "PREPARE_VIDEO") {
    return prepareVideo(
      resolveTabId(sender, message),
      message.url,
      Boolean(message.force),
      Number(message.requestId) || 0
    );
  }

  if (message.type === "CANCEL_PREPARE") {
    return cancelPrepare(
      resolveTabId(sender, message),
      message.url,
      Number(message.requestId) || 0
    );
  }

  return { ok: false, error: `Unknown message type: ${message.type}` };
}

function resolveTabId(sender, message) {
  return sender?.tab?.id || message?.tabId || null;
}

async function getSettings() {
  const current = await chrome.storage.local.get(null);
  const settings = { ...DEFAULT_SETTINGS, ...current };
  if (typeof current.duckVolumeLevel !== "number") {
    settings.duckVolumeLevel = current.duckOriginalAudio === false ? 1 : DEFAULT_SETTINGS.duckVolumeLevel;
  }

  if (settings.translatorType === "mock") {
    settings.translatorType = "publicGoogle";
  }
  if (settings.translatorType === "custom") {
    settings.translatorType = "api";
  }
  if (!SUPPORTED_TARGET_LANGUAGES.has(settings.targetLanguage)) {
    settings.targetLanguage = DEFAULT_SETTINGS.targetLanguage;
  }
  settings.recognizerType = "custom";
  if (!["custom", "volcengine"].includes(settings.asrProvider)) {
    settings.asrProvider = DEFAULT_SETTINGS.asrProvider;
  }
  if (!["browser", "custom", "volcengine"].includes(settings.ttsProvider)) {
    settings.ttsProvider = DEFAULT_SETTINGS.ttsProvider;
  }
  if (!settings.ttsVolcengineCluster) {
    settings.ttsVolcengineCluster = DEFAULT_SETTINGS.ttsVolcengineCluster;
  }
  if (!settings.ttsVolcengineVoiceType) {
    settings.ttsVolcengineVoiceType = DEFAULT_SETTINGS.ttsVolcengineVoiceType;
  }
  if (!settings.asrEndpoint) {
    settings.asrEndpoint = DEFAULT_SETTINGS.asrEndpoint;
  }
  if (!settings.asrVolcengineMode) {
    settings.asrVolcengineMode = DEFAULT_SETTINGS.asrVolcengineMode;
  }
  if (!settings.asrCustomBaseUrl) {
    settings.asrCustomBaseUrl = settings.asrEndpoint || DEFAULT_SETTINGS.asrEndpoint;
  }
  if (!["deepseek-chat", "deepseek-reasoner"].includes(settings.deepSeekModel)) {
    settings.deepSeekModel = DEFAULT_SETTINGS.deepSeekModel;
  }
  delete settings.enabled;
  delete settings.ttsGoogleApiKey;
  delete settings.ttsGoogleVoiceName;

  if (settings.settingsVersion !== DEFAULT_SETTINGS.settingsVersion) {
    settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
    await chrome.storage.local.set(settings);
    await chrome.storage.local.remove(["enabled", "ttsGoogleApiKey", "ttsGoogleVoiceName"]);
  }

  return settings;
}

function sanitizeSettings(settings) {
  const clean = {};
  if (SUPPORTED_TARGET_LANGUAGES.has(settings.targetLanguage)) {
    clean.targetLanguage = settings.targetLanguage;
  }
  clean.recognizerType = "custom";
  clean.asrProvider = settings.asrProvider === "volcengine" ? "volcengine" : "custom";
  if (typeof settings.duckOriginalAudio === "boolean") clean.duckOriginalAudio = settings.duckOriginalAudio;
  if (typeof settings.duckVolumeLevel === "number") {
    clean.duckVolumeLevel = Math.min(1, Math.max(0, settings.duckVolumeLevel));
  }
  if (typeof settings.ttsVolume === "number") {
    clean.ttsVolume = Math.min(1, Math.max(0, settings.ttsVolume));
  }
  clean.ttsProvider = normalizeTtsProvider(settings.ttsProvider);
  if (typeof settings.ttsBaseUrl === "string") clean.ttsBaseUrl = settings.ttsBaseUrl.trim();
  if (typeof settings.ttsApiKey === "string") clean.ttsApiKey = settings.ttsApiKey.trim();
  if (typeof settings.ttsModel === "string") clean.ttsModel = settings.ttsModel.trim();
  if (typeof settings.ttsVolcengineAppId === "string") {
    clean.ttsVolcengineAppId = settings.ttsVolcengineAppId.trim();
  }
  if (typeof settings.ttsVolcengineAccessToken === "string") {
    clean.ttsVolcengineAccessToken = settings.ttsVolcengineAccessToken.trim();
  }
  if (typeof settings.ttsVolcengineCluster === "string") {
    clean.ttsVolcengineCluster = settings.ttsVolcengineCluster.trim() || DEFAULT_SETTINGS.ttsVolcengineCluster;
  }
  if (typeof settings.ttsVolcengineVoiceType === "string") {
    clean.ttsVolcengineVoiceType = settings.ttsVolcengineVoiceType.trim() || DEFAULT_SETTINGS.ttsVolcengineVoiceType;
  }
  if (typeof settings.ttsVoiceURI === "string") clean.ttsVoiceURI = settings.ttsVoiceURI;
  if (typeof settings.asrEndpoint === "string") {
    clean.asrEndpoint = settings.asrEndpoint.trim() || DEFAULT_SETTINGS.asrEndpoint;
  }
  if (typeof settings.asrCustomBaseUrl === "string") {
    clean.asrCustomBaseUrl = settings.asrCustomBaseUrl.trim() || clean.asrEndpoint || DEFAULT_SETTINGS.asrEndpoint;
  }
  if (typeof settings.asrCustomApiKey === "string") {
    clean.asrCustomApiKey = settings.asrCustomApiKey.trim();
  }
  clean.asrVolcengineMode = settings.asrVolcengineMode === "turbo" ? "turbo" : "turbo";
  if (typeof settings.asrVolcengineAppId === "string") {
    clean.asrVolcengineAppId = settings.asrVolcengineAppId.trim();
  }
  if (typeof settings.asrVolcengineAccessToken === "string") {
    clean.asrVolcengineAccessToken = settings.asrVolcengineAccessToken.trim();
  }
  if (typeof settings.asrModel === "string") clean.asrModel = settings.asrModel.trim();
  if (
    settings.translatorType === "publicGoogle" ||
    settings.translatorType === "deepseek" ||
    settings.translatorType === "api" ||
    settings.translatorType === "custom"
  ) {
    clean.translatorType = settings.translatorType === "custom" ? "api" : settings.translatorType;
  } else if (settings.translatorType === "mock") {
    clean.translatorType = "publicGoogle";
  }
  if (typeof settings.apiEndpoint === "string") clean.apiEndpoint = settings.apiEndpoint.trim();
  if (typeof settings.apiKey === "string") clean.apiKey = settings.apiKey.trim();
  if (typeof settings.deepSeekApiKey === "string") {
    clean.deepSeekApiKey = settings.deepSeekApiKey.trim();
  }
  clean.deepSeekModel = settings.deepSeekModel === "deepseek-reasoner"
    ? "deepseek-reasoner"
    : "deepseek-chat";
  return clean;
}

async function prepareVideo(tabId, explicitUrl, force = false, requestId = 0) {
  const settings = await getSettings();
  const backendUrl = getPrepareBackendUrl(settings);
  if (!backendUrl) {
    return {
      ok: false,
      error: "请先配置 Backend URL，例如 http://127.0.0.1:8787"
    };
  }

  const url = explicitUrl || await getTabUrl(tabId);
  if (!url) return { ok: false, error: "找不到当前视频 URL" };

  const prepareKey = `${tabId || "no-tab"}:${normalizePrepareUrl(url)}`;
  const existingJob = prepareSessions.get(prepareKey);
  if (existingJob && !existingJob.canceled) {
    notifyPrepareProgress(tabId, "生成中", {
      requestId,
      statusKind: "busy"
    });
    return {
      ok: false,
      inProgress: true,
      error: "当前视频已经在生成中，请稍等..."
    };
  }

  const job = {
    key: prepareKey,
    requestId,
    progressJobId: createProgressJobId(requestId),
    recognizer: getRecognizerStatus(settings),
    canceled: false,
    controller: new AbortController()
  };
  job.progressPoll = pollHelperProgress(
    tabId,
    buildProgressEndpoint(buildPrepareEndpoint(backendUrl), job.progressJobId),
    requestId,
    job
  );
  const prepareTask = runPrepareVideo(tabId, url, settings, force, requestId, job);
  job.promise = prepareTask;
  prepareSessions.set(prepareKey, job);
  try {
    return await prepareTask;
  } finally {
    job.done = true;
    await job.progressPoll?.catch(() => {});
    if (prepareSessions.get(prepareKey) === job) {
      prepareSessions.delete(prepareKey);
    }
  }
}

async function cancelPrepare(tabId, explicitUrl, requestId = 0) {
  const url = explicitUrl || await getTabUrl(tabId);
  const normalizedUrl = url ? normalizePrepareUrl(url) : "";
  let canceled = false;
  for (const [prepareKey, job] of prepareSessions.entries()) {
    const sameTab = prepareKey.startsWith(`${tabId || "no-tab"}:`);
    const sameUrl = normalizedUrl && prepareKey.endsWith(normalizedUrl);
    const sameRequest = requestId && job.requestId === requestId;
    if (!sameRequest && !(sameTab && sameUrl)) continue;
    job.canceled = true;
    try {
      job.controller?.abort();
    } catch {}
    prepareSessions.delete(prepareKey);
    canceled = true;
  }
  if (canceled) {
    notifyPrepareProgress(tabId, "已取消", {
      phase: "idle",
      progress: 0,
      requestId
    });
  }
  return { ok: true, canceled };
}

async function runPrepareVideo(tabId, url, settings, force = false, requestId = 0, job = null) {
  const prepareEndpoint = buildPrepareEndpoint(getPrepareBackendUrl(settings));
  notifyPrepareProgress(tabId, "生成中", {
    phase: "preparing",
    progress: 3,
    requestId,
    statusKind: "prepare",
    recognizer: getRecognizerStatus(settings)
  });
  throwIfCanceled(job);

  const response = await fetch(prepareEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: job?.controller?.signal,
    body: JSON.stringify({
      url,
      model: settings.asrModel || "",
      language: "en",
      job_id: job?.progressJobId || "",
      recognizer_provider: settings.asrProvider || "custom",
      recognizer_api_key: buildRecognizerCredential(settings)
    })
  });
  throwIfCanceled(job);

  if (!response.ok) {
    throw new Error(await formatPrepareError(response));
  }

  const prepared = await response.json();
  if (job) job.helperDone = true;
  throwIfCanceled(job);
  const segments = Array.isArray(prepared.segments) ? prepared.segments : [];
  if (!segments.length) {
    return { ok: false, error: "后端没有识别到可用语音段落" };
  }

  const translatorLabel = getTranslatorLabel(settings);
  notifyPrepareProgress(tabId, "查缓存", {
    phase: "preparing",
    progress: 35,
    requestId,
    statusKind: "cache-check",
    translator: getTranslatorStatus(settings),
    total: segments.length
  });
  throwIfCanceled(job);

  const timelineCacheKey = await buildTimelineCacheKey(url, prepared, segments, settings);
  const cachedTimeline = force ? null : await loadCachedTimeline(timelineCacheKey);
  throwIfCanceled(job);
  if (cachedTimeline) {
    notifyTab(tabId, {
      type: "PREPARED_TIMELINE",
      timeline: cachedTimeline,
      requestId
    });
    notifyPrepareProgress(tabId, "声译就绪", {
      phase: "ready",
      progress: 100,
      requestId,
      statusKind: "cache-hit",
      translator: getTranslatorStatus(settings),
      cache: cachedTimeline.segments.length,
      total: cachedTimeline.segments.length
    });
    return {
      ok: true,
      cached: true,
      title: cachedTimeline.title,
      segmentCount: cachedTimeline.segments.length,
      cacheDir: cachedTimeline.cacheDir,
      mediaPath: ""
    };
  }

  notifyPrepareProgress(tabId, force ? "重译" : "翻译", {
    phase: "preparing",
    progress: 38,
    requestId,
    statusKind: force ? "translate-force" : "translate",
    translator: getTranslatorStatus(settings),
    current: 0,
    total: segments.length,
    cache: 0,
    fresh: 0
  });

  const translated = await translatePreparedSegments(tabId, segments, settings, force, requestId, job);
  throwIfCanceled(job);

  const timeline = {
    title: prepared.title || "",
    duration: prepared.duration || 0,
    cacheDir: prepared.cache_dir || "",
    mediaPath: "",
    segments: translated.filter((segment) => segment.text)
  };

  await saveCachedTimeline(timelineCacheKey, timeline);

  notifyTab(tabId, {
    type: "PREPARED_TIMELINE",
    timeline,
    requestId
  });
  notifyPrepareProgress(tabId, "就绪", {
    phase: "ready",
    progress: 100,
    requestId,
    statusKind: "ready",
    translator: getTranslatorStatus(settings),
    total: timeline.segments.length
  });

  return {
    ok: true,
    title: timeline.title,
    segmentCount: timeline.segments.length,
    cacheDir: timeline.cacheDir,
    mediaPath: ""
  };
}

function getPrepareBackendUrl(settings) {
  if (settings.asrProvider === "custom") {
    return settings.asrCustomBaseUrl || settings.asrEndpoint || DEFAULT_SETTINGS.asrEndpoint;
  }
  return settings.asrEndpoint || DEFAULT_SETTINGS.asrEndpoint;
}

function buildRecognizerCredential(settings) {
  if (settings.asrProvider === "custom") {
    return settings.asrCustomApiKey || "";
  }
  const appId = String(settings.asrVolcengineAppId || "").trim();
  const accessToken = String(settings.asrVolcengineAccessToken || "").trim();
  if (appId && accessToken) return `${appId}:${accessToken}`;
  return "";
}

async function formatPrepareError(response) {
  const rawText = await response.text().catch(() => "");
  let detail = rawText.trim();
  try {
    const payload = JSON.parse(rawText);
    detail = typeof payload.detail === "string"
      ? payload.detail
      : JSON.stringify(payload.detail || payload);
  } catch {}
  if (response.status === 422 && /usable speech segments|没有识别|未识别/.test(detail)) {
    return "未识别到语音段落";
  }
  return detail
    ? `Backend prepare failed with HTTP ${response.status}: ${detail}`
    : `Backend prepare failed with HTTP ${response.status}`;
}

async function translatePreparedSegments(tabId, segments, settings, force = false, requestId = 0, job = null) {
  const result = new Array(segments.length);
  const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);
  const translatorLabel = getTranslatorLabel(settings);
  const cacheScope = getTranslatorCacheScope(settings, targetLanguage);
  const concurrency = getTranslationConcurrency(settings);
  const cacheStats = {
    memoryHits: 0,
    persistentHits: 0,
    newTranslations: 0
  };
  console.info("[LinguaStream] prepare translation", {
    provider: translatorLabel,
    cacheScope,
    force,
    segmentCount: segments.length,
    concurrency
  });
  let nextIndex = 0;
  let completed = 0;
  let lastPartialCount = 0;

  async function translateNextSegment() {
    while (nextIndex < segments.length) {
      const index = nextIndex;
      nextIndex += 1;
      await translateSegmentAt(index);
    }
  }

  async function translateSegmentAt(index) {
    throwIfCanceled(job);
    const segment = segments[index];
    const translations = await translateTexts([segment.text], settings, { force, cacheStats });
    throwIfCanceled(job);
    result[index] = {
      id: `prepared-${index}`,
      start: Number(segment.start) || 0,
      end: Number(segment.end) || Number(segment.start) + 3,
      sourceText: segment.text,
      text: normalizeText(translations[0] || "")
    };
    completed += 1;
    const readySegments = getContiguousReadySegments(result);
    if (
      readySegments.length >= PARTIAL_PLAYBACK_MIN_SEGMENTS &&
      (lastPartialCount === 0 || readySegments.length - lastPartialCount >= 5)
    ) {
      notifyPartialTimeline(tabId, readySegments, requestId, settings, readySegments.length);
      lastPartialCount = readySegments.length;
    }
    notifyPrepareProgress(tabId, "翻译", {
      phase: "preparing",
      progress: 38 + Math.round((completed / segments.length) * 60),
      requestId,
      statusKind: "translate",
      translator: getTranslatorStatus(settings),
      current: completed,
      total: segments.length,
      cache: getCacheHitCount(cacheStats),
      fresh: Number(cacheStats.newTranslations) || 0
    });
  }

  const workerCount = Math.max(1, Math.min(concurrency, segments.length));
  await Promise.all(Array.from({ length: workerCount }, () => translateNextSegment()));
  return result;
}

function getContiguousReadySegments(segments) {
  const ready = [];
  for (const segment of segments) {
    if (!segment?.text) break;
    ready.push(segment);
  }
  return ready;
}

function notifyPartialTimeline(tabId, segments, requestId, settings, translatedCount) {
  notifyTab(tabId, {
    type: "PARTIAL_TIMELINE",
    timeline: {
      segments,
      partial: true
    },
    requestId,
    translatedCount,
    minPlayableSegments: PARTIAL_PLAYBACK_MIN_SEGMENTS,
    translator: getTranslatorStatus(settings)
  });
}

function throwIfCanceled(job) {
  if (job?.canceled || job?.controller?.signal?.aborted) {
    throw new Error("已取消");
  }
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizePrepareUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.includes("youtube.com")) {
      const videoId = url.searchParams.get("v");
      if (videoId) return `youtube:${videoId}`;
    }
    if (url.hostname.includes("youtu.be")) {
      const videoId = url.pathname.split("/").filter(Boolean)[0];
      if (videoId) return `youtube:${videoId}`;
    }
    const bilibiliId = getBilibiliVideoId(url);
    if (bilibiliId) {
      const part = url.searchParams.get("p") || "";
      return `bilibili:${bilibiliId}${part ? `:${part}` : ""}`;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(rawUrl || "");
  }
}

function getBilibiliVideoId(url) {
  if (url.hostname.includes("b23.tv")) {
    return url.pathname.split("/").filter(Boolean)[0] || "";
  }
  if (!url.hostname.includes("bilibili.com")) return "";
  const match = url.pathname.match(/\/(?:video|bangumi\/play)\/([^/?#]+)/);
  return match?.[1] || "";
}

function notifyTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

function notifyPrepareProgress(tabId, text, meta = {}) {
  notifyTab(tabId, { type: "PREPARE_STATUS", text, ...meta });
  const port = preparePorts.get(tabId);
  if (port) {
    try {
      port.postMessage({ type: "PREPARE_PROGRESS", text, ...meta });
    } catch {
      preparePorts.delete(tabId);
    }
  }
}

async function getTabUrl(tabId) {
  if (!tabId) return "";
  const tab = await chrome.tabs.get(tabId);
  return tab?.url || "";
}

function buildPrepareEndpoint(asrEndpoint) {
  const url = new URL(asrEndpoint);
  const isLocalHelper =
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    url.port === "8787";
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  if (
    isLocalHelper ||
    normalizedPath === "" ||
    normalizedPath === "/transcribe" ||
    normalizedPath === "/transform" ||
    normalizedPath === "/translate" ||
    normalizedPath === "/prepare-youtube" ||
    normalizedPath === "/prepare-video"
  ) {
    url.pathname = "/prepare-video";
  } else {
    url.pathname = `${normalizedPath}/prepare-video`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildProgressEndpoint(prepareEndpoint, jobId) {
  const url = new URL(prepareEndpoint);
  url.pathname = "/prepare-progress/" + encodeURIComponent(jobId);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function createProgressJobId(requestId) {
  return [
    "ls",
    Date.now().toString(36),
    String(requestId || 0),
    Math.random().toString(36).slice(2, 8)
  ].join("-");
}

async function pollHelperProgress(tabId, progressEndpoint, requestId, job) {
  while (!job?.done && !job?.helperDone && !job?.canceled) {
    try {
      const response = await fetch(progressEndpoint, {
        cache: "no-store",
        signal: job?.controller?.signal
      });
      if (response.ok) {
        const data = await response.json();
        if (data?.ok && typeof data.progress === "number") {
          notifyPrepareProgress(tabId, compactHelperStatus(data), {
            phase: data.phase || "preparing",
            progress: data.progress,
            requestId,
            statusKind: "recognize",
            recognizer: job?.recognizer || null
          });
        }
      }
    } catch {
      if (job?.done || job?.canceled || job?.controller?.signal?.aborted) return;
    }
  await delay(500);
  }
}

function compactHelperStatus(data) {
  const phase = String(data?.phase || "");
  const text = String(data?.text || "");
  if (phase === "transcribing") return "正在识别";
  if (phase === "converting") return "抽取音频";
  if (phase === "downloaded") return "处理音频";
  if (phase === "downloading") {
    const percent = text.match(/(\d+)\s*%/)?.[1];
    return percent ? `下载 ${percent}%` : "下载中";
  }
  if (phase === "metadata") return "读取格式";
  if (phase === "loading_model") return "加载模型";
  if (phase === "starting") return "读取信息";
  if (phase === "ready") return "识别完成";
  return text.replace(/^下载完成，?/, "").replace(/^正在/, "").replace(/\.{3}$/, "").slice(0, 8) || "生成中";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildTimelineCacheKey(url, prepared, segments, settings) {
  const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);
  const translatorScope = getTranslatorCacheScope(settings, targetLanguage);
  const signature = JSON.stringify({
    version: 1,
    video: normalizePrepareUrl(url),
    recognizer: prepared.provider || settings.asrProvider || "custom",
    model: prepared.model || settings.asrModel || "",
    language: prepared.language || "en",
    targetLanguage,
    translator: translatorScope,
    segments: segments.map((segment) => [
      Number(segment.start) || 0,
      Number(segment.end) || 0,
      normalizeText(segment.text)
    ])
  });
  return `${TIMELINE_CACHE_PREFIX}${await sha256(signature)}`;
}

async function loadCachedTimeline(cacheKey) {
  const stored = await chrome.storage.local.get(cacheKey);
  const entry = stored?.[cacheKey];
  if (!entry || !Array.isArray(entry.timeline?.segments)) return null;
  return entry.timeline;
}

async function saveCachedTimeline(cacheKey, timeline) {
  try {
    await chrome.storage.local.set({
      [cacheKey]: {
        createdAt: Date.now(),
        timeline
      }
    });
  } catch (error) {
    console.warn("[LinguaStream] unable to persist translated timeline cache", error);
  }
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function translateTexts(texts, settings, options = {}) {
  if (!texts.length) return [];
  const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);
  if (settings.translatorType === "deepseek") {
    if (!settings.deepSeekApiKey) {
      throw new Error("DeepSeek translator is selected, but no API key is configured.");
    }
    return translateManyWithCache(
      texts,
      getTranslatorCacheScope(settings, targetLanguage),
      (text) => translateOneWithDeepSeek(text, settings, targetLanguage),
      options
    );
  }

  if (settings.translatorType !== "api") {
    return translateManyWithCache(
      texts,
      getTranslatorCacheScope(settings, targetLanguage),
      (text) => translateOneWithPublicGoogle(text, targetLanguage),
      options
    );
  }

  if (!settings.apiEndpoint) {
    throw new Error("API translator is selected, but no endpoint is configured.");
  }

  return translateManyWithCache(
    texts,
    `api:${settings.apiEndpoint}:en:${targetLanguage}`,
    (text) => translateOneWithApi(text, settings, targetLanguage),
    options
  );
}

function getTranslatorCacheScope(settings, targetLanguage) {
  if (settings.translatorType === "api") {
    return `api:${settings.apiEndpoint || ""}:en:${targetLanguage}`;
  }
  if (settings.translatorType === "deepseek") {
    return `deepseek:${settings.deepSeekModel || "deepseek-chat"}:en:${targetLanguage}`;
  }
  return `publicGoogle:en:${targetLanguage}`;
}

function getTranslatorLabel(settings) {
  if (settings.translatorType === "api") return "Custom";
  if (settings.translatorType === "deepseek") {
    return `DeepSeek ${settings.deepSeekModel || "deepseek-chat"}`;
  }
  return "Google";
}

function getTranslatorStatus(settings) {
  if (settings.translatorType === "deepseek") {
    return {
      type: "deepseek",
      label: "",
      model: settings.deepSeekModel || "deepseek-chat"
    };
  }
  if (settings.translatorType === "api") {
    return {
      type: "custom",
      label: "API",
      model: ""
    };
  }
  return {
    type: "google",
    label: "",
    model: ""
  };
}

function getRecognizerStatus(settings) {
  if (settings.asrProvider === "volcengine") {
    return {
      type: "volcengine",
      label: "",
      model: settings.asrModel || ""
    };
  }
  return {
    type: "custom",
    label: "",
    model: settings.asrModel || ""
  };
}

function normalizeTtsProvider(provider) {
  if (provider === "custom" || provider === "volcengine") {
    return provider;
  }
  return "browser";
}

async function synthesizeSpeech(text, settings, options = {}) {
  const normalizedText = normalizeText(text);
  const provider = normalizeTtsProvider(settings.ttsProvider);
  if (!normalizedText) return { ok: false, error: "No speech text." };
  if (provider === "browser" || provider === "custom") {
    return { ok: false, error: "Selected TTS provider does not use extension-side synthesis." };
  }

  const targetLanguage = normalizeTargetLanguage(options.targetLanguage || settings.targetLanguage);
  const rate = clampNumber(options.rate, 0.25, 3, 1);
  const cacheKey = [
    provider,
    targetLanguage,
    rate.toFixed(2),
    settings.ttsVolcengineCluster || "",
    settings.ttsVolcengineVoiceType || "",
    normalizedText
  ].join("\n");
  if (speechCache.has(cacheKey)) {
    return { ok: true, cached: true, ...speechCache.get(cacheKey) };
  }

  const result = await synthesizeWithVolcengine(normalizedText, settings, targetLanguage, rate);
  if (result.ok) {
    rememberSpeech(cacheKey, {
      audioContent: result.audioContent,
      mimeType: result.mimeType
    });
  }
  return result;
}

async function synthesizeWithVolcengine(text, settings, targetLanguage, rate) {
  const appId = String(settings.ttsVolcengineAppId || "").trim();
  const accessToken = String(settings.ttsVolcengineAccessToken || "").trim();
  const cluster = String(settings.ttsVolcengineCluster || DEFAULT_SETTINGS.ttsVolcengineCluster).trim();
  const voiceType = String(settings.ttsVolcengineVoiceType || "").trim();
  if (!appId || !accessToken || !cluster || !voiceType) {
    throw new Error("Volcengine TTS requires APP ID, Access Token, Cluster, and Voice Type.");
  }

  const response = await fetch("https://openspeech.bytedance.com/api/v1/tts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer;${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      app: {
        appid: appId,
        token: accessToken,
        cluster
      },
      user: {
        uid: "linguastream-extension"
      },
      audio: {
        voice_type: voiceType,
        encoding: "mp3",
        speed_ratio: clampNumber(rate, 0.2, 3, 1),
        volume_ratio: 1,
        pitch_ratio: 1
      },
      request: {
        reqid: crypto.randomUUID(),
        text,
        text_type: "plain",
        operation: "query"
      }
    })
  });

  const payload = await readJsonResponse(response, "Volcengine TTS");
  if (payload?.code && payload.code !== 3000) {
    throw new Error(`Volcengine TTS failed with code ${payload.code}: ${payload.message || payload.msg || ""}`);
  }
  const audioContent = payload?.data || payload?.audio || payload?.audioContent || "";
  if (!audioContent) {
    throw new Error(`Volcengine TTS returned no audio: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return { ok: true, provider: "volcengine", audioContent, mimeType: "audio/mpeg" };
}

async function readJsonResponse(response, label) {
  const rawText = await response.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = { raw: rawText };
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || payload?.raw || JSON.stringify(payload);
    throw new Error(`${label} failed with HTTP ${response.status}: ${detail}`);
  }
  return payload;
}

function rememberSpeech(key, value) {
  speechCache.set(key, value);
  while (speechCache.size > MAX_SPEECH_CACHE_ITEMS) {
    const oldestKey = speechCache.keys().next().value;
    speechCache.delete(oldestKey);
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, number))
    : fallback;
}

function getCacheHitCount(stats) {
  return (Number(stats.memoryHits) || 0) + (Number(stats.persistentHits) || 0);
}

function getTranslationConcurrency(settings) {
  const type = settings.translatorType === "deepseek"
    ? "deepseek"
    : settings.translatorType === "api"
      ? "api"
      : "publicGoogle";
  return TRANSLATION_CONCURRENCY[type] || 4;
}

async function translateManyWithCache(texts, cacheScope, translateOne, options = {}) {
  const results = [];
  for (const text of texts) {
    const normalized = normalizeText(text);
    if (!normalized) {
      results.push("");
      continue;
    }

    const cacheKey = `${cacheScope}:${normalized}`;
    if (!options.force && translationCache.has(cacheKey)) {
      incrementCacheStat(options.cacheStats, "memoryHits");
    }
    if (options.force || !translationCache.has(cacheKey)) {
      const persistentKey = `${TRANSLATION_CACHE_PREFIX}${await sha256(cacheKey)}`;
      const cached = options.force ? "" : await loadCachedTranslation(persistentKey);
      if (cached) {
        translationCache.set(cacheKey, cached);
        incrementCacheStat(options.cacheStats, "persistentHits");
      } else {
        const translated = await translateOneWithInFlight(cacheKey, normalized, translateOne);
        translationCache.set(cacheKey, translated);
        await saveCachedTranslation(persistentKey, translated);
        incrementCacheStat(options.cacheStats, "newTranslations");
      }
    }
    results.push(translationCache.get(cacheKey) || "");
  }
  return results;
}

async function translateOneWithInFlight(cacheKey, normalized, translateOne) {
  if (!translationInFlight.has(cacheKey)) {
    const task = Promise.resolve()
      .then(() => translateOne(normalized))
      .then((text) => normalizeText(text))
      .finally(() => translationInFlight.delete(cacheKey));
    translationInFlight.set(cacheKey, task);
  }
  return translationInFlight.get(cacheKey);
}

function incrementCacheStat(stats, key) {
  if (!stats) return;
  stats[key] = (Number(stats[key]) || 0) + 1;
}

async function loadCachedTranslation(cacheKey) {
  try {
    const stored = await chrome.storage.local.get(cacheKey);
    const entry = stored?.[cacheKey];
    return typeof entry?.text === "string" ? entry.text : "";
  } catch {
    return "";
  }
}

async function saveCachedTranslation(cacheKey, text) {
  if (!text) return;
  try {
    await chrome.storage.local.set({
      [cacheKey]: {
        createdAt: Date.now(),
        text
      }
    });
  } catch (error) {
    console.warn("[LinguaStream] unable to persist sentence translation cache", error);
  }
}

function normalizeTargetLanguage(language) {
  return SUPPORTED_TARGET_LANGUAGES.has(language)
    ? language
    : DEFAULT_SETTINGS.targetLanguage;
}

async function translateOneWithPublicGoogle(text, targetLanguage) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "en");
  url.searchParams.set("tl", toPublicGoogleLanguage(targetLanguage));
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Public translator failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data?.[0]) ? flattenPublicGoogleParts(data[0]) : "";
}

function toPublicGoogleLanguage(language) {
  return {
    "zh-CN": "zh-CN",
    "zh-TW": "zh-TW",
    "ja-JP": "ja",
    "ko-KR": "ko",
    "en-US": "en"
  }[normalizeTargetLanguage(language)] || "zh-CN";
}

async function translateOneWithApi(text, settings, targetLanguage) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
    headers["x-api-key"] = settings.apiKey;
  }

  const response = await fetch(settings.apiEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text,
      source: "en",
      target: targetLanguage,
      sourceLang: "en",
      targetLang: targetLanguage
    })
  });

  if (!response.ok) {
    throw new Error(`Translation API failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const rawText = await response.text();
    return rawText.trim();
  }

  const data = await response.json();
  return pickTranslation(data);
}

async function translateOneWithDeepSeek(text, settings, targetLanguage) {
  const model = settings.deepSeekModel === "deepseek-reasoner"
    ? "deepseek-reasoner"
    : "deepseek-chat";
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.deepSeekApiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "You are a translation engine.",
            "Translate English video transcript text into the target language.",
            "Return only the translation, with no explanation, quotes, labels, or markdown."
          ].join(" ")
        },
        {
          role: "user",
          content: `Target language: ${toLanguageLabel(targetLanguage)}\nText: ${text}`
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`DeepSeek translation failed with HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  return pickTranslation(data);
}

function toLanguageLabel(language) {
  return {
    "zh-CN": "Simplified Chinese",
    "zh-TW": "Traditional Chinese",
    "ja-JP": "Japanese",
    "ko-KR": "Korean",
    "en-US": "English"
  }[normalizeTargetLanguage(language)] || "Simplified Chinese";
}

function flattenPublicGoogleParts(parts) {
  return parts
    .map((part) => Array.isArray(part) ? part[0] : "")
    .join("")
    .trim();
}

function pickTranslation(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data.translation === "string") return data.translation;
  if (typeof data.translatedText === "string") return data.translatedText;
  if (typeof data.text === "string") return data.text;
  if (typeof data.result === "string") return data.result;
  if (data.data) return pickTranslation(data.data);
  if (Array.isArray(data.translations) && data.translations[0]) {
    return pickTranslation(data.translations[0]);
  }
  if (Array.isArray(data.choices) && data.choices[0]?.message?.content) {
    return data.choices[0].message.content;
  }
  return "";
}
