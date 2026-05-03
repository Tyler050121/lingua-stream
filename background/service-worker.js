const DEFAULT_SETTINGS = {
  duckOriginalAudio: false,
  targetLanguage: "zh-CN",
  recognizerType: "custom",
  asrProvider: "custom",
  asrEndpoint: "http://127.0.0.1:8787",
  asrApiKey: "",
  asrModel: "",
  duckVolumeLevel: 0.25,
  ttsProvider: "browser",
  ttsBaseUrl: "",
  ttsApiKey: "",
  ttsModel: "",
  ttsVolume: 1,
  ttsVoiceURI: "",
  translatorType: "publicGoogle",
  apiEndpoint: "",
  apiKey: "",
  settingsVersion: 10
};

const SUPPORTED_TARGET_LANGUAGES = new Set(["zh-CN", "zh-TW", "ja-JP", "ko-KR", "en-US"]);

const preparePorts = new Map();
const prepareSessions = new Map();
const translationCache = new Map();
const TIMELINE_CACHE_PREFIX = "linguastream:timeline:";
const TRANSLATION_CACHE_PREFIX = "linguastream:translation:";

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
  if (!["custom", "openai"].includes(settings.asrProvider)) {
    settings.asrProvider = DEFAULT_SETTINGS.asrProvider;
  }
  if (!["browser", "custom"].includes(settings.ttsProvider)) {
    settings.ttsProvider = DEFAULT_SETTINGS.ttsProvider;
  }
  if (!settings.asrEndpoint) {
    settings.asrEndpoint = DEFAULT_SETTINGS.asrEndpoint;
  }
  delete settings.enabled;

  if (settings.settingsVersion !== DEFAULT_SETTINGS.settingsVersion) {
    settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
    await chrome.storage.local.set(settings);
    await chrome.storage.local.remove("enabled");
  }

  return settings;
}

function sanitizeSettings(settings) {
  const clean = {};
  if (SUPPORTED_TARGET_LANGUAGES.has(settings.targetLanguage)) {
    clean.targetLanguage = settings.targetLanguage;
  }
  clean.recognizerType = "custom";
  clean.asrProvider = settings.asrProvider === "openai" ? "openai" : "custom";
  if (typeof settings.duckOriginalAudio === "boolean") clean.duckOriginalAudio = settings.duckOriginalAudio;
  if (typeof settings.duckVolumeLevel === "number") {
    clean.duckVolumeLevel = Math.min(1, Math.max(0, settings.duckVolumeLevel));
  }
  if (typeof settings.ttsVolume === "number") {
    clean.ttsVolume = Math.min(1, Math.max(0, settings.ttsVolume));
  }
  clean.ttsProvider = settings.ttsProvider === "custom" ? "custom" : "browser";
  if (typeof settings.ttsBaseUrl === "string") clean.ttsBaseUrl = settings.ttsBaseUrl.trim();
  if (typeof settings.ttsApiKey === "string") clean.ttsApiKey = settings.ttsApiKey.trim();
  if (typeof settings.ttsModel === "string") clean.ttsModel = settings.ttsModel.trim();
  if (typeof settings.ttsVoiceURI === "string") clean.ttsVoiceURI = settings.ttsVoiceURI;
  if (typeof settings.asrEndpoint === "string") {
    clean.asrEndpoint = settings.asrEndpoint.trim() || DEFAULT_SETTINGS.asrEndpoint;
  }
  if (typeof settings.asrApiKey === "string") clean.asrApiKey = settings.asrApiKey.trim();
  if (typeof settings.asrModel === "string") clean.asrModel = settings.asrModel.trim();
  if (
    settings.translatorType === "publicGoogle" ||
    settings.translatorType === "api" ||
    settings.translatorType === "custom"
  ) {
    clean.translatorType = settings.translatorType === "custom" ? "api" : settings.translatorType;
  } else if (settings.translatorType === "mock") {
    clean.translatorType = "publicGoogle";
  }
  if (typeof settings.apiEndpoint === "string") clean.apiEndpoint = settings.apiEndpoint.trim();
  if (typeof settings.apiKey === "string") clean.apiKey = settings.apiKey.trim();
  return clean;
}

async function prepareVideo(tabId, explicitUrl, force = false, requestId = 0) {
  const settings = await getSettings();
  if (!settings.asrEndpoint) {
    return {
      ok: false,
      error: "请先配置本地 helper endpoint，例如 http://127.0.0.1:8787"
    };
  }

  const url = explicitUrl || await getTabUrl(tabId);
  if (!url) return { ok: false, error: "找不到当前视频 URL" };

  const prepareKey = `${tabId || "no-tab"}:${normalizePrepareUrl(url)}`;
  const existingJob = prepareSessions.get(prepareKey);
  if (existingJob && !existingJob.canceled) {
    notifyPrepareProgress(tabId, "当前视频已经在生成中，请稍等...", { requestId });
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
    canceled: false,
    controller: new AbortController()
  };
  job.progressPoll = pollHelperProgress(
    tabId,
    buildProgressEndpoint(buildPrepareEndpoint(settings.asrEndpoint), job.progressJobId),
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
  const prepareEndpoint = buildPrepareEndpoint(settings.asrEndpoint);
  notifyPrepareProgress(tabId, "正在生成声译时间线...", {
    phase: "preparing",
    progress: 3,
    requestId
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
      recognizer_api_key: settings.asrApiKey || ""
    })
  });
  throwIfCanceled(job);

  if (!response.ok) {
    throw new Error(`Prepare helper failed with HTTP ${response.status}`);
  }

  const prepared = await response.json();
  if (job) job.helperDone = true;
  throwIfCanceled(job);
  const segments = Array.isArray(prepared.segments) ? prepared.segments : [];
  if (!segments.length) {
    return { ok: false, error: "本地 helper 没有识别到可用语音段落" };
  }

  notifyPrepareProgress(tabId, `已识别 ${segments.length} 段，正在检查缓存...`, {
    phase: "preparing",
    progress: 35,
    requestId
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
    notifyPrepareProgress(tabId, `已复用中文缓存：${cachedTimeline.segments.length} 段`, {
      phase: "ready",
      progress: 100,
      requestId
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

  notifyPrepareProgress(tabId, `${force ? "正在重新翻译" : "未命中中文缓存，正在翻译"} 0/${segments.length}...`, {
    phase: "preparing",
    progress: 38,
    requestId
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
  notifyPrepareProgress(tabId, `声译就绪：${timeline.segments.length} 段`, {
    phase: "ready",
    progress: 100,
    requestId
  });

  return {
    ok: true,
    title: timeline.title,
    segmentCount: timeline.segments.length,
    cacheDir: timeline.cacheDir,
    mediaPath: ""
  };
}

async function translatePreparedSegments(tabId, segments, settings, force = false, requestId = 0, job = null) {
  const result = [];
  for (let index = 0; index < segments.length; index += 1) {
    throwIfCanceled(job);
    const segment = segments[index];
    const translations = await translateTexts([segment.text], settings, { force });
    throwIfCanceled(job);
    result.push({
      id: `prepared-${index}`,
      start: Number(segment.start) || 0,
      end: Number(segment.end) || Number(segment.start) + 3,
      sourceText: segment.text,
      text: normalizeText(translations[0] || "")
    });
    notifyPrepareProgress(tabId, `翻译中 ${index + 1}/${segments.length}`, {
      phase: "preparing",
      progress: 38 + Math.round(((index + 1) / segments.length) * 60),
      requestId
    });
  }
  return result;
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
    const videoId = url.searchParams.get("v");
    if (videoId) return `youtube:${videoId}`;
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(rawUrl || "");
  }
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
    normalizedPath === "/prepare-youtube"
  ) {
    url.pathname = "/prepare-youtube";
  } else {
    url.pathname = `${normalizedPath}/prepare-youtube`;
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
          notifyPrepareProgress(tabId, data.text || "生成中", {
            phase: data.phase || "preparing",
            progress: data.progress,
            requestId
          });
        }
      }
    } catch {
      if (job?.done || job?.canceled || job?.controller?.signal?.aborted) return;
    }
    await delay(500);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildTimelineCacheKey(url, prepared, segments, settings) {
  const targetLanguage = normalizeTargetLanguage(settings.targetLanguage);
  const translatorScope = settings.translatorType === "api"
    ? `api:${settings.apiEndpoint || ""}:${targetLanguage}`
    : `publicGoogle:${targetLanguage}`;
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
  if (settings.translatorType !== "api") {
    return translateManyWithCache(
      texts,
      `publicGoogle:en:${targetLanguage}`,
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

async function translateManyWithCache(texts, cacheScope, translateOne, options = {}) {
  const results = [];
  for (const text of texts) {
    const normalized = normalizeText(text);
    if (!normalized) {
      results.push("");
      continue;
    }

    const cacheKey = `${cacheScope}:${normalized}`;
    if (options.force || !translationCache.has(cacheKey)) {
      const persistentKey = `${TRANSLATION_CACHE_PREFIX}${await sha256(cacheKey)}`;
      const cached = options.force ? "" : await loadCachedTranslation(persistentKey);
      if (cached) {
        translationCache.set(cacheKey, cached);
      } else {
        const translated = normalizeText(await translateOne(normalized));
        translationCache.set(cacheKey, translated);
        await saveCachedTranslation(persistentKey, translated);
      }
    }
    results.push(translationCache.get(cacheKey) || "");
  }
  return results;
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
