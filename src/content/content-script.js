(function bootLinguaStream() {
  const {
    log,
    warn,
    PageControlButton
  } = window.LinguaStream;

  let settings = null;
  let controlButton = null;
  let preparedPlayer = null;
  let activeVideoKey = "";
  let prepareRequestId = 0;
  let activePrepareRequestId = 0;
  const canceledPrepareRequests = new Set();

  init();

  async function init() {
    settings = await loadSettings();
    bindStorageUpdates();
    bindYouTubeNavigation();
    preparedPlayer = new PreparedTimelinePlayer();
    controlButton = new PageControlButton({
      onPrepare: prepareCurrentVideo,
      onToggle: togglePreparedPlayback,
      onCancel: cancelCurrentPrepare
    });
    await ensureSchedulerForPage();
    bindRuntimeMessages();
    log("Content script initialized.");
  }

  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
      if (response?.ok) return response.settings;
    } catch (error) {
      warn("Unable to load settings", error);
    }

    return {
      duckOriginalAudio: false,
      targetLanguage: "zh-CN",
      recognizerType: "local",
      duckVolumeLevel: 0.25,
      ttsProvider: "browser",
      ttsBaseUrl: "",
      ttsApiKey: "",
      ttsModel: "",
      ttsVolume: 1,
      ttsVoiceURI: "",
      translatorType: "publicGoogle",
      apiEndpoint: "",
      apiKey: ""
    };
  }

  function bindStorageUpdates() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const nextSettings = { ...settings };
      for (const [key, change] of Object.entries(changes)) {
        nextSettings[key] = change.newValue;
      }
      settings = nextSettings;
    });
  }

  async function togglePreparedPlayback(active) {
    if (!preparedPlayer?.hasTimeline()) {
      return { ok: false, error: "请先启用声译" };
    }
    preparedPlayer.setEnabled(active);
    return { ok: true };
  }

  async function prepareCurrentVideo(options = {}) {
    const requestId = Number(options.requestId) || prepareRequestId + 1;
    prepareRequestId = Math.max(prepareRequestId, requestId);
    activePrepareRequestId = requestId;
    canceledPrepareRequests.delete(requestId);
    const response = await chrome.runtime.sendMessage({
      type: "PREPARE_VIDEO",
      url: location.href,
      force: Boolean(options.force),
      requestId
    });
    if (
      canceledPrepareRequests.has(requestId) ||
      (activePrepareRequestId && activePrepareRequestId !== requestId)
    ) {
      return { ok: false, canceled: true, error: "已取消" };
    }
    return response || { ok: false, error: "No response from background worker." };
  }

  function cancelCurrentPrepare() {
    if (!activePrepareRequestId) return;
    const requestId = activePrepareRequestId;
    canceledPrepareRequests.add(activePrepareRequestId);
    activePrepareRequestId = 0;
    chrome.runtime.sendMessage({
      type: "CANCEL_PREPARE",
      url: location.href,
      requestId
    }).catch(() => {});
  }

  function bindRuntimeMessages() {
    chrome.runtime.onMessage.addListener((message) => {
      if (
        typeof message?.requestId === "number" &&
        (canceledPrepareRequests.has(message.requestId) || (
          activePrepareRequestId &&
          message.requestId !== activePrepareRequestId
        ))
      ) {
        return;
      }

      if (message?.type === "PREPARE_STATUS" && controlButton) {
        controlButton.setStatus(message.text || "");
        if (typeof message.progress === "number") {
          controlButton.setProgress(message.progress, message.phase || "preparing");
        }
      }

      if (message?.type === "PREPARED_TIMELINE") {
        if (
          typeof message.requestId === "number" &&
          (
            canceledPrepareRequests.has(message.requestId) ||
            (activePrepareRequestId && activePrepareRequestId !== message.requestId)
          )
        ) {
          return;
        }
        activePrepareRequestId = 0;
        preparedPlayer.load(message.timeline);
        if (controlButton) {
          controlButton.show();
          controlButton.setActive(false);
          controlButton.setPrepared(true, message.timeline?.segments?.length || 0);
          controlButton.setProgress(100, "ready");
          controlButton.setStatus(`声译就绪 ${message.timeline?.segments?.length || 0} 段`);
        }
      }
    });
  }

  function bindYouTubeNavigation() {
    document.addEventListener("yt-navigate-finish", () => {
      window.setTimeout(() => ensureSchedulerForPage(), 300);
    });
  }

  async function ensureSchedulerForPage() {
    if (!isWatchPage()) {
      if (preparedPlayer) preparedPlayer.clear();
      if (controlButton) controlButton.hide();
      activeVideoKey = "";
      return;
    }

    const videoKey = getVideoKey();
    if (videoKey && videoKey !== activeVideoKey) {
      activeVideoKey = videoKey;
      if (preparedPlayer) preparedPlayer.clear();
      if (controlButton) {
        controlButton.setPrepared(false);
        controlButton.setProgress(0, "idle");
        controlButton.setActive(false);
      }
    }

    if (controlButton) controlButton.show();
    if (controlButton && !preparedPlayer?.hasTimeline()) {
      controlButton.setActive(false);
      controlButton.setPrepared(false);
      controlButton.setProgress(0, "idle");
      controlButton.setStatus("启用声译");
    }
  }

  function isWatchPage() {
    return location.hostname.includes("youtube.com") && location.pathname === "/watch";
  }

  function getVideoKey() {
    return new URLSearchParams(location.search).get("v") || location.href;
  }

  class PreparedTimelinePlayer {
    constructor() {
      this.timeline = null;
      this.segments = [];
      this.video = null;
      this.timer = window.setInterval(() => this.tick(), 250);
      this.lastTime = 0;
      this.currentUtterance = null;
      this.enabled = false;
      this.duckedVideo = null;
      this.originalVolume = null;
      this.utteranceTimer = null;
    }

    load(timeline) {
      this.stopSpeech();
      this.enabled = false;
      this.timeline = timeline || null;
      this.segments = (timeline?.segments || [])
        .map((segment, index) => ({
          ...segment,
          index,
          spoken: false
        }))
        .sort((a, b) => a.start - b.start);
      this.segments.forEach((segment, index) => {
        segment.nextStart = this.segments[index + 1]?.start ?? null;
      });
      this.lastTime = 0;
      this.attachVideo();
    }

    clear() {
      this.stopSpeech();
      this.enabled = false;
      this.restoreVolume();
      this.timeline = null;
      this.segments = [];
    }

    hasTimeline() {
      return this.segments.length > 0;
    }

    setEnabled(enabled) {
      this.enabled = Boolean(enabled);
      if (this.enabled) {
        this.attachVideo();
        this.resetAroundCurrentTime();
        this.duckVolume();
      } else {
        this.stopSpeech();
        this.restoreVolume();
      }
    }

    attachVideo() {
      const video = document.querySelector("video");
      if (!video || video === this.video) return;
      if (this.video) {
        this.video.removeEventListener("pause", this.boundPause);
        this.video.removeEventListener("seeked", this.boundSeek);
      }
      this.video = video;
      this.boundPause = () => this.stopSpeech();
      this.boundSeek = () => this.resetAroundCurrentTime();
      video.addEventListener("pause", this.boundPause);
      video.addEventListener("seeked", this.boundSeek);
      if (this.enabled) this.duckVolume();
    }

    tick() {
      if (!this.enabled || !this.segments.length) return;
      this.attachVideo();
      if (!this.video || this.video.paused || this.video.ended) return;
      this.duckVolume();

      const now = this.video.currentTime || 0;
      if (Math.abs(now - this.lastTime) > 2) {
        this.resetAroundCurrentTime();
      }
      this.lastTime = now;

      if (this.currentUtterance && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
        this.currentUtterance = null;
      }
      if (window.speechSynthesis.speaking || this.currentUtterance) return;

      for (const item of this.segments) {
        if (!item.spoken && item.end < now - 0.75) item.spoken = true;
      }
      const segment = this.segments.find((item) =>
        !item.spoken &&
        item.text &&
        item.start <= now + 0.75 &&
        item.end >= now - 0.75
      );

      if (!segment) return;
      segment.spoken = true;
      this.speak(segment, now);
    }

    speak(segment, currentTime) {
      if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
      const text = segment.text;
      const timing = calculateSpeechTiming(segment, currentTime);
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = normalizeTargetLanguage(settings?.targetLanguage);
      utterance.rate = timing.rate;
      utterance.volume = typeof settings?.ttsVolume === "number"
        ? clamp(settings.ttsVolume, 0, 1)
        : 1;
      const voice = pickVoiceForLanguage(settings?.ttsVoiceURI, settings?.targetLanguage);
      if (voice) utterance.voice = voice;
      utterance.onend = () => {
        this.clearUtteranceTimer();
        this.currentUtterance = null;
      };
      utterance.onerror = () => {
        this.clearUtteranceTimer();
        this.currentUtterance = null;
      };
      this.currentUtterance = utterance;
      window.speechSynthesis.cancel();
      this.duckVolume();
      window.speechSynthesis.speak(utterance);
      this.utteranceTimer = window.setTimeout(() => {
        if (this.currentUtterance !== utterance) return;
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
          window.speechSynthesis.cancel();
        }
        this.utteranceTimer = null;
        this.currentUtterance = null;
      }, estimateSpeechTimeout(text, timing));
    }

    clearUtteranceTimer() {
      if (this.utteranceTimer) {
        window.clearTimeout(this.utteranceTimer);
        this.utteranceTimer = null;
      }
    }

    duckVolume() {
      if (!settings?.duckOriginalAudio || !this.video || this.video.muted) return;
      const targetVolume = typeof settings.duckVolumeLevel === "number"
        ? clamp(settings.duckVolumeLevel, 0, 1)
        : 0.25;
      if (this.duckedVideo !== this.video) {
        this.restoreVolume();
        this.duckedVideo = this.video;
        this.originalVolume = this.video.volume;
      }
      if (this.video.volume !== targetVolume) {
        this.video.volume = targetVolume;
      }
    }

    restoreVolume() {
      if (!this.duckedVideo || this.originalVolume === null) return;
      this.duckedVideo.volume = this.originalVolume;
      this.duckedVideo = null;
      this.originalVolume = null;
    }

    resetAroundCurrentTime() {
      this.stopSpeech();
      if (this.enabled) this.duckVolume();
      const now = this.video?.currentTime || 0;
      for (const segment of this.segments) {
        segment.spoken = segment.end < now - 1;
      }
    }

    stopSpeech() {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      this.clearUtteranceTimer();
      this.currentUtterance = null;
    }
  }

  function estimateSpeechTimeout(text, timing) {
    const textBasedMs = (String(text || "").length * 210) / Math.max(0.75, timing.rate);
    const windowBasedMs = timing.availableSeconds * 1300 + 700;
    return Math.min(15000, Math.max(1800, Math.min(textBasedMs + 1000, windowBasedMs)));
  }

  function calculateSpeechTiming(segment, currentTime) {
    const text = String(segment.text || "");
    const hardEnd = Number.isFinite(segment.nextStart)
      ? Math.min(segment.end, segment.nextStart - 0.12)
      : segment.end;
    const availableSeconds = clamp((hardEnd || segment.end || currentTime + 2) - currentTime, 0.75, 8);
    const estimatedSecondsAtRateOne = estimateSpeechSeconds(text);
    const rate = clamp(estimatedSecondsAtRateOne / availableSeconds, 0.75, 1.85);
    return { availableSeconds, rate };
  }

  function estimateSpeechSeconds(text) {
    const normalized = String(text || "").trim();
    if (!normalized) return 1;

    const cjkChars = (normalized.match(/[\u3400-\u9fff]/g) || []).length;
    const latinWords = (normalized.match(/[A-Za-z0-9]+/g) || []).length;
    const punctuation = (normalized.match(/[，。！？；：,.!?;:]/g) || []).length;
    const otherChars = Math.max(0, normalized.replace(/\s+/g, "").length - cjkChars);
    const speechUnits = cjkChars + latinWords * 1.6 + otherChars * 0.55;

    return Math.max(0.9, speechUnits / 4.6 + punctuation * 0.12);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeTargetLanguage(language) {
    return ["zh-CN", "zh-TW", "ja-JP", "ko-KR", "en-US"].includes(language)
      ? language
      : "zh-CN";
  }

  function pickVoiceForLanguage(voiceURI = "", targetLanguage = "zh-CN") {
    const voices = window.speechSynthesis?.getVoices?.() || [];
    const language = normalizeTargetLanguage(targetLanguage).toLowerCase();
    const languagePrefix = language.split("-")[0];
    return (
      voices.find((voice) => voiceURI && voice.voiceURI === voiceURI) ||
      voices.find((voice) => voice.lang.toLowerCase() === language) ||
      voices.find((voice) => voice.lang.toLowerCase().startsWith(languagePrefix)) ||
      null
    );
  }
})();
