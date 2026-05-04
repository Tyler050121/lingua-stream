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
  ttsVolcengineVoiceType: "",
  ttsGoogleApiKey: "",
  ttsGoogleVoiceName: "",
  ttsVolume: 1,
  ttsVoiceURI: "",
  translatorType: "publicGoogle",
  apiEndpoint: "",
  apiKey: "",
  deepSeekApiKey: "",
  deepSeekModel: "deepseek-chat",
  settingsVersion: 16
};

const MIN_PANEL_HEIGHT = 78;
const PANEL_HEIGHT_BUFFER = 2;
const DEFAULT_ASR_PANEL_PROVIDER = "custom";
const PANEL_HEIGHT_SOURCE = "recognition";

const fields = {
  popup: document.querySelector(".popup"),
  panelStage: document.querySelector(".panel-stage"),
  tabs: Array.from(document.querySelectorAll("[data-tab]")),
  tabPanels: Array.from(document.querySelectorAll("[data-tab-panel]")),
  targetLanguage: document.querySelector("#targetLanguage"),
  asrProvider: document.querySelector("#asrProvider"),
  asrEndpointField: document.querySelector("#asrEndpointField"),
  asrCustomBaseUrlField: document.querySelector("#asrCustomBaseUrlField"),
  asrCustomApiKeyField: document.querySelector("#asrCustomApiKeyField"),
  asrVolcengineModeField: document.querySelector("#asrVolcengineModeField"),
  asrVolcengineAppIdField: document.querySelector("#asrVolcengineAppIdField"),
  asrVolcengineAccessTokenField: document.querySelector("#asrVolcengineAccessTokenField"),
  asrBaseUrlRequired: document.querySelector("#asrBaseUrlRequired"),
  asrModelField: document.querySelector("#asrModelField"),
  apiEndpointField: document.querySelector("#apiEndpointField"),
  apiKeyField: document.querySelector("#apiKeyField"),
  deepSeekApiKeyField: document.querySelector("#deepSeekApiKeyField"),
  deepSeekModelField: document.querySelector("#deepSeekModelField"),
  ttsBaseUrlField: document.querySelector("#ttsBaseUrlField"),
  ttsApiKeyField: document.querySelector("#ttsApiKeyField"),
  ttsModelField: document.querySelector("#ttsModelField"),
  ttsVolcengineAppIdField: document.querySelector("#ttsVolcengineAppIdField"),
  ttsVolcengineAccessTokenField: document.querySelector("#ttsVolcengineAccessTokenField"),
  ttsVolcengineClusterField: document.querySelector("#ttsVolcengineClusterField"),
  ttsVolcengineVoiceTypeField: document.querySelector("#ttsVolcengineVoiceTypeField"),
  ttsGoogleApiKeyField: document.querySelector("#ttsGoogleApiKeyField"),
  ttsGoogleVoiceNameField: document.querySelector("#ttsGoogleVoiceNameField"),
  ttsVoiceField: document.querySelector("#ttsVoiceField"),
  duckVolumeLevel: document.querySelector("#duckVolumeLevel"),
  duckVolumeValue: document.querySelector("#duckVolumeValue"),
  ttsProvider: document.querySelector("#ttsProvider"),
  ttsBaseUrl: document.querySelector("#ttsBaseUrl"),
  ttsApiKey: document.querySelector("#ttsApiKey"),
  ttsModel: document.querySelector("#ttsModel"),
  ttsVolcengineAppId: document.querySelector("#ttsVolcengineAppId"),
  ttsVolcengineAccessToken: document.querySelector("#ttsVolcengineAccessToken"),
  ttsVolcengineCluster: document.querySelector("#ttsVolcengineCluster"),
  ttsVolcengineVoiceType: document.querySelector("#ttsVolcengineVoiceType"),
  ttsGoogleApiKey: document.querySelector("#ttsGoogleApiKey"),
  ttsGoogleVoiceName: document.querySelector("#ttsGoogleVoiceName"),
  ttsVolume: document.querySelector("#ttsVolume"),
  ttsVolumeValue: document.querySelector("#ttsVolumeValue"),
  ttsVoice: document.querySelector("#ttsVoice"),
  asrEndpoint: document.querySelector("#asrEndpoint"),
  asrCustomBaseUrl: document.querySelector("#asrCustomBaseUrl"),
  asrCustomApiKey: document.querySelector("#asrCustomApiKey"),
  asrVolcengineMode: document.querySelector("#asrVolcengineMode"),
  asrVolcengineAppId: document.querySelector("#asrVolcengineAppId"),
  asrVolcengineAccessToken: document.querySelector("#asrVolcengineAccessToken"),
  asrModel: document.querySelector("#asrModel"),
  translatorType: document.querySelector("#translatorType"),
  apiEndpoint: document.querySelector("#apiEndpoint"),
  apiKey: document.querySelector("#apiKey"),
  deepSeekApiKey: document.querySelector("#deepSeekApiKey"),
  deepSeekModel: document.querySelector("#deepSeekModel"),
  status: document.querySelector("#status")
};

let saveTimer = null;
const customSelects = new Map();
let openSelect = null;

init();

async function init() {
  const settings = await loadSettings();
  render(settings);
  installCustomSelects();
  bindPasswordToggles();
  bindTabs();
  bindEvents();
  bindVoiceUpdates();
  setFixedPanelHeight();
}

async function loadSettings() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (response?.ok) return { ...DEFAULT_SETTINGS, ...response.settings };
  } catch (error) {
    setStatus(`读取设置失败：${error.message || error}`);
  }
  return { ...DEFAULT_SETTINGS };
}

function render(settings) {
  const duckLevel = normalizeDuckVolumeLevel(settings);
  const ttsVolume = normalizeUnitValue(settings.ttsVolume, 1);
  fields.targetLanguage.value = normalizeTargetLanguage(settings.targetLanguage);
  fields.asrProvider.value = normalizeAsrProvider(settings.asrProvider);
  fields.ttsProvider.value = normalizeTtsProvider(settings.ttsProvider);
  fields.ttsBaseUrl.value = settings.ttsBaseUrl || "";
  fields.ttsApiKey.value = settings.ttsApiKey || "";
  fields.ttsModel.value = settings.ttsModel || "";
  fields.ttsVolcengineAppId.value = settings.ttsVolcengineAppId || "";
  fields.ttsVolcengineAccessToken.value = settings.ttsVolcengineAccessToken || "";
  fields.ttsVolcengineCluster.value = normalizeVolcengineTtsCluster(settings.ttsVolcengineCluster);
  fields.ttsVolcengineVoiceType.value = settings.ttsVolcengineVoiceType || "";
  fields.ttsGoogleApiKey.value = settings.ttsGoogleApiKey || "";
  fields.ttsGoogleVoiceName.value = settings.ttsGoogleVoiceName || "";
  fields.ttsVolume.value = String(Math.round(ttsVolume * 100));
  fields.ttsVolume.style.setProperty("--value", `${Math.round(ttsVolume * 100)}%`);
  fields.ttsVolumeValue.value = `${Math.round(ttsVolume * 100)}%`;
  fields.ttsVolumeValue.textContent = `${Math.round(ttsVolume * 100)}%`;
  fields.duckVolumeLevel.value = String(Math.round(duckLevel * 100));
  fields.duckVolumeLevel.style.setProperty("--value", `${Math.round(duckLevel * 100)}%`);
  fields.duckVolumeValue.value = `${Math.round(duckLevel * 100)}%`;
  fields.duckVolumeValue.textContent = `${Math.round(duckLevel * 100)}%`;
  renderVoiceOptions(settings.ttsVoiceURI || "", fields.targetLanguage.value);
  fields.asrEndpoint.value = settings.asrEndpoint || "";
  fields.asrCustomBaseUrl.value = settings.asrCustomBaseUrl || settings.asrEndpoint || "";
  fields.asrCustomApiKey.value = settings.asrCustomApiKey || "";
  fields.asrVolcengineMode.value = normalizeVolcengineMode(settings.asrVolcengineMode);
  fields.asrVolcengineAppId.value = settings.asrVolcengineAppId || "";
  fields.asrVolcengineAccessToken.value = settings.asrVolcengineAccessToken || "";
  fields.asrModel.value = settings.asrModel || "";
  fields.translatorType.value = normalizeTranslatorType(settings.translatorType);
  fields.apiEndpoint.value = settings.apiEndpoint || "";
  fields.apiKey.value = settings.apiKey || "";
  fields.deepSeekApiKey.value = settings.deepSeekApiKey || "";
  fields.deepSeekModel.value = normalizeDeepSeekModel(settings.deepSeekModel);
  updateConditionalFields();
}

function bindEvents() {
  for (const element of [
    fields.duckVolumeLevel,
    fields.targetLanguage,
    fields.asrProvider,
    fields.ttsProvider,
    fields.ttsBaseUrl,
    fields.ttsApiKey,
    fields.ttsModel,
    fields.ttsVolcengineAppId,
    fields.ttsVolcengineAccessToken,
    fields.ttsVolcengineCluster,
    fields.ttsVolcengineVoiceType,
    fields.ttsGoogleApiKey,
    fields.ttsGoogleVoiceName,
    fields.ttsVolume,
    fields.ttsVoice,
    fields.asrEndpoint,
    fields.asrCustomBaseUrl,
    fields.asrCustomApiKey,
    fields.asrVolcengineMode,
    fields.asrVolcengineAppId,
    fields.asrVolcengineAccessToken,
    fields.asrModel,
    fields.translatorType,
    fields.apiEndpoint,
    fields.apiKey,
    fields.deepSeekApiKey,
    fields.deepSeekModel
  ]) {
    element.addEventListener("input", scheduleSave);
    element.addEventListener("change", scheduleSave);
  }
}

function bindPasswordToggles() {
  for (const button of document.querySelectorAll("[data-password-toggle]")) {
    const input = document.getElementById(button.dataset.passwordToggle);
    if (!input) continue;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (input.disabled) return;
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", String(visible));
      button.setAttribute("aria-label", visible ? "Hide API Key" : "Show API Key");
      input.focus({ preventScroll: true });
    });
  }
}

function bindTabs() {
  for (const tab of fields.tabs) {
    tab.addEventListener("click", () => {
      activateTab(tab.dataset.tab);
    });
  }
}

function activateTab(tabName) {
  closeCustomSelects();
  for (const tab of fields.tabs) {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const panel of fields.tabPanels) {
    const active = panel.dataset.tabPanel === tabName;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }
  setFixedPanelHeight();
}

function scheduleSave() {
  updateConditionalFields();
  updateDuckVolumeLabel();
  updateTtsVolumeLabel();
  renderVoiceOptions(fields.ttsVoice.value, fields.targetLanguage.value);
  syncCustomSelects();
  setFixedPanelHeight();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSettings, 150);
}

async function saveSettings() {
  const settings = readSettings();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      settings
    });
    if (!response?.ok) throw new Error(response?.error || "保存失败");
    setStatus("");
  } catch (error) {
    setStatus(`保存失败：${error.message || error}`);
  }
}

function readSettings() {
  const duckVolumeLevel = Number(fields.duckVolumeLevel.value) / 100;
  return {
    duckOriginalAudio: duckVolumeLevel < 1,
    targetLanguage: normalizeTargetLanguage(fields.targetLanguage.value),
    recognizerType: "custom",
    asrProvider: normalizeAsrProvider(fields.asrProvider.value),
    duckVolumeLevel,
    ttsProvider: normalizeTtsProvider(fields.ttsProvider.value),
    ttsBaseUrl: fields.ttsBaseUrl.value.trim(),
    ttsApiKey: fields.ttsApiKey.value.trim(),
    ttsModel: fields.ttsModel.value.trim(),
    ttsVolcengineAppId: fields.ttsVolcengineAppId.value.trim(),
    ttsVolcengineAccessToken: fields.ttsVolcengineAccessToken.value.trim(),
    ttsVolcengineCluster: normalizeVolcengineTtsCluster(fields.ttsVolcengineCluster.value),
    ttsVolcengineVoiceType: fields.ttsVolcengineVoiceType.value.trim(),
    ttsGoogleApiKey: fields.ttsGoogleApiKey.value.trim(),
    ttsGoogleVoiceName: fields.ttsGoogleVoiceName.value.trim(),
    ttsVolume: Number(fields.ttsVolume.value) / 100,
    ttsVoiceURI: fields.ttsVoice.value,
    asrEndpoint: normalizeHelperEndpoint(fields.asrEndpoint.value),
    asrCustomBaseUrl: normalizeHelperEndpoint(fields.asrCustomBaseUrl.value || fields.asrEndpoint.value),
    asrCustomApiKey: fields.asrCustomApiKey.value.trim(),
    asrVolcengineMode: normalizeVolcengineMode(fields.asrVolcengineMode.value),
    asrVolcengineAppId: fields.asrVolcengineAppId.value.trim(),
    asrVolcengineAccessToken: fields.asrVolcengineAccessToken.value.trim(),
    asrModel: fields.asrModel.value.trim(),
    translatorType: normalizeTranslatorType(fields.translatorType.value),
    apiEndpoint: fields.apiEndpoint.value.trim(),
    apiKey: fields.apiKey.value.trim(),
    deepSeekApiKey: fields.deepSeekApiKey.value.trim(),
    deepSeekModel: normalizeDeepSeekModel(fields.deepSeekModel.value)
  };
}

function normalizeDuckVolumeLevel(settings) {
  if (typeof settings.duckVolumeLevel === "number") {
    return normalizeUnitValue(settings.duckVolumeLevel, 0.25);
  }
  return settings.duckOriginalAudio ? 0.25 : 1;
}

function normalizeUnitValue(value, fallback) {
  return typeof value === "number"
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function updateDuckVolumeLabel() {
  fields.duckVolumeValue.value = `${fields.duckVolumeLevel.value}%`;
  fields.duckVolumeValue.textContent = `${fields.duckVolumeLevel.value}%`;
  fields.duckVolumeLevel.style.setProperty("--value", `${fields.duckVolumeLevel.value}%`);
}

function updateTtsVolumeLabel() {
  fields.ttsVolumeValue.value = `${fields.ttsVolume.value}%`;
  fields.ttsVolumeValue.textContent = `${fields.ttsVolume.value}%`;
  fields.ttsVolume.style.setProperty("--value", `${fields.ttsVolume.value}%`);
}

function bindVoiceUpdates() {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.onvoiceschanged = () => {
    renderVoiceOptions(fields.ttsVoice.value, fields.targetLanguage.value);
  };
  window.setTimeout(() => {
    renderVoiceOptions(fields.ttsVoice.value, fields.targetLanguage.value);
  }, 150);
  window.setTimeout(() => {
    renderVoiceOptions(fields.ttsVoice.value, fields.targetLanguage.value);
  }, 600);
}

function renderVoiceOptions(selectedVoiceURI, targetLanguage = fields.targetLanguage.value) {
  const language = normalizeTargetLanguage(targetLanguage);
  const voices = getVoicesForLanguage(language);
  fields.ttsVoice.textContent = "";

  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto";
  fields.ttsVoice.append(auto);

  for (const voice of voices) {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} (${voice.lang})`;
    fields.ttsVoice.append(option);
  }

  fields.ttsVoice.value = voices.some((voice) => voice.voiceURI === selectedVoiceURI)
    ? selectedVoiceURI
    : "";
  syncCustomSelect(fields.ttsVoice);
}

function getVoicesForLanguage(targetLanguage) {
  if (!("speechSynthesis" in window)) return [];
  const prefix = normalizeTargetLanguage(targetLanguage).split("-")[0].toLowerCase();
  return window.speechSynthesis
    .getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith(prefix))
    .sort((a, b) => `${a.lang} ${a.name}`.localeCompare(`${b.lang} ${b.name}`));
}

function normalizeHelperEndpoint(value) {
  const endpoint = String(value || "").trim();
  return endpoint || "http://127.0.0.1:8787";
}

function updateConditionalFields() {
  const asrProvider = normalizeAsrProvider(fields.asrProvider.value);
  const ttsProvider = normalizeTtsProvider(fields.ttsProvider.value);
  const isApi = fields.translatorType.value === "api";
  const isDeepSeek = fields.translatorType.value === "deepseek";
  const isCustomAsr = asrProvider === "custom";
  const isVolcengineAsr = asrProvider === "volcengine";
  const isCustomTts = ttsProvider === "custom";
  const isVolcengineTts = ttsProvider === "volcengine";
  const isGoogleTts = ttsProvider === "googleCloud";
  const isBrowserTts = ttsProvider === "browser";

  fields.ttsBaseUrlField.hidden = !isCustomTts;
  fields.ttsApiKeyField.hidden = !isCustomTts;
  fields.ttsModelField.hidden = !isCustomTts;
  fields.ttsVolcengineAppIdField.hidden = !isVolcengineTts;
  fields.ttsVolcengineAccessTokenField.hidden = !isVolcengineTts;
  fields.ttsVolcengineClusterField.hidden = !isVolcengineTts;
  fields.ttsVolcengineVoiceTypeField.hidden = !isVolcengineTts;
  fields.ttsGoogleApiKeyField.hidden = !isGoogleTts;
  fields.ttsGoogleVoiceNameField.hidden = !isGoogleTts;
  fields.ttsVoiceField.hidden = !isBrowserTts;
  fields.ttsBaseUrl.disabled = !isCustomTts;
  fields.ttsApiKey.disabled = !isCustomTts;
  fields.ttsModel.disabled = !isCustomTts;
  fields.ttsVolcengineAppId.disabled = !isVolcengineTts;
  fields.ttsVolcengineAccessToken.disabled = !isVolcengineTts;
  fields.ttsVolcengineCluster.disabled = !isVolcengineTts;
  fields.ttsVolcengineVoiceType.disabled = !isVolcengineTts;
  fields.ttsGoogleApiKey.disabled = !isGoogleTts;
  fields.ttsGoogleVoiceName.disabled = !isGoogleTts;
  fields.ttsVoice.disabled = !isBrowserTts;

  fields.asrEndpointField.hidden = false;
  fields.asrEndpoint.disabled = false;
  fields.asrBaseUrlRequired.hidden = false;
  if (!fields.asrCustomBaseUrl.value) {
    fields.asrCustomBaseUrl.value = fields.asrEndpoint.value || DEFAULT_SETTINGS.asrEndpoint;
  }
  fields.asrCustomBaseUrlField.hidden = !isCustomAsr;
  fields.asrCustomApiKeyField.hidden = !isCustomAsr;
  fields.asrVolcengineModeField.hidden = !isVolcengineAsr;
  fields.asrCustomBaseUrl.disabled = !isCustomAsr;
  fields.asrCustomApiKey.disabled = !isCustomAsr;
  fields.asrVolcengineMode.disabled = !isVolcengineAsr;
  fields.asrVolcengineAppIdField.hidden = !isVolcengineAsr;
  fields.asrVolcengineAccessTokenField.hidden = !isVolcengineAsr;
  fields.asrVolcengineAppId.disabled = !isVolcengineAsr;
  fields.asrVolcengineAccessToken.disabled = !isVolcengineAsr;
  fields.asrModel.placeholder = isVolcengineAsr
      ? "Default bigmodel"
      : "Default tiny.en";
  fields.apiEndpointField.hidden = !isApi;
  fields.apiKeyField.hidden = !isApi;
  fields.deepSeekApiKeyField.hidden = !isDeepSeek;
  fields.deepSeekModelField.hidden = !isDeepSeek;
  fields.apiEndpoint.disabled = !isApi;
  fields.apiKey.disabled = !isApi;
  fields.deepSeekApiKey.disabled = !isDeepSeek;
  fields.deepSeekModel.disabled = !isDeepSeek;
}

function normalizeAsrProvider(provider) {
  return provider === "volcengine" ? "volcengine" : "custom";
}

function normalizeVolcengineMode(mode) {
  return mode === "turbo" ? "turbo" : "turbo";
}

function normalizeTtsProvider(provider) {
  if (provider === "custom" || provider === "volcengine" || provider === "googleCloud") {
    return provider;
  }
  return "browser";
}

function normalizeVolcengineTtsCluster(cluster) {
  return String(cluster || "").trim() || DEFAULT_SETTINGS.ttsVolcengineCluster;
}

function normalizeTranslatorType(provider) {
  if (provider === "api" || provider === "deepseek") return provider;
  return "publicGoogle";
}

function normalizeDeepSeekModel(model) {
  return model === "deepseek-reasoner" ? "deepseek-reasoner" : "deepseek-chat";
}

function setFixedPanelHeight() {
  updateConditionalFields();
  const activePanel = fields.tabPanels.find((panel) => panel.classList.contains("is-active"));
  const sourcePanel = fields.tabPanels.find((panel) => panel.dataset.tabPanel === PANEL_HEIGHT_SOURCE);
  if (!sourcePanel) return;
  const sourceRestore = capturePanelState(sourcePanel);
  const activeRestore = activePanel ? capturePanelState(activePanel) : null;
  const conditionalFields = {
    customBaseUrl: fields.asrCustomBaseUrlField,
    customApiKey: fields.asrCustomApiKeyField,
    volcengineMode: fields.asrVolcengineModeField,
    volcengineAppId: fields.asrVolcengineAppIdField,
    volcengineAccessToken: fields.asrVolcengineAccessTokenField
  };
  const originalHidden = new Map(
    Object.values(conditionalFields)
      .filter(Boolean)
      .map((field) => [field, field.hidden])
  );
  exposePanelForMeasurement(sourcePanel);
  const defaultHeight = Math.max(
    MIN_PANEL_HEIGHT,
    measureAsrPanelHeight(sourcePanel, conditionalFields, DEFAULT_ASR_PANEL_PROVIDER)
  );
  restoreConditionalFields(originalHidden);
  restorePanelState(sourcePanel, sourceRestore);

  const activeHeight = activePanel
    ? Math.max(MIN_PANEL_HEIGHT, measurePanelHeight(activePanel))
    : defaultHeight;
  if (activePanel && activeRestore) restorePanelState(activePanel, activeRestore);
  const nextHeight = Math.max(defaultHeight, activeHeight) + PANEL_HEIGHT_BUFFER;
  fields.popup.style.setProperty("--panel-height", `${nextHeight}px`);
  restoreConditionalFields(originalHidden);
}

function measureAsrPanelHeight(sourcePanel, conditionalFields, provider) {
  const isVolcengine = provider === "volcengine";
  conditionalFields.customBaseUrl.hidden = isVolcengine;
  conditionalFields.customApiKey.hidden = isVolcengine;
  conditionalFields.volcengineMode.hidden = !isVolcengine;
  conditionalFields.volcengineAppId.hidden = !isVolcengine;
  conditionalFields.volcengineAccessToken.hidden = !isVolcengine;
  return Math.ceil(sourcePanel.scrollHeight);
}

function measurePanelHeight(panel) {
  exposePanelForMeasurement(panel);
  return Math.ceil(panel.scrollHeight);
}

function capturePanelState(panel) {
  return {
    hidden: panel.hidden,
    position: panel.style.position,
    visibility: panel.style.visibility,
    pointerEvents: panel.style.pointerEvents,
    left: panel.style.left,
    right: panel.style.right,
    top: panel.style.top
  };
}

function exposePanelForMeasurement(panel) {
  if (!panel.hidden) return;
  panel.hidden = false;
  panel.style.position = "absolute";
  panel.style.visibility = "hidden";
  panel.style.pointerEvents = "none";
  panel.style.left = "0";
  panel.style.right = "0";
  panel.style.top = "0";
}

function restorePanelState(panel, state) {
  panel.hidden = state.hidden;
  panel.style.position = state.position;
  panel.style.visibility = state.visibility;
  panel.style.pointerEvents = state.pointerEvents;
  panel.style.left = state.left;
  panel.style.right = state.right;
  panel.style.top = state.top;
}

function restoreConditionalFields(originalHidden) {
  for (const [field, hidden] of originalHidden.entries()) {
    field.hidden = hidden;
  }
}

function installCustomSelects() {
  for (const select of document.querySelectorAll("select")) {
    if (customSelects.has(select)) continue;
    const shell = document.createElement("div");
    shell.className = "select-shell";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "select-button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");

    const menu = document.createElement("div");
    menu.className = "select-menu";
    menu.setAttribute("role", "listbox");

    select.classList.add("native-select");
    select.insertAdjacentElement("afterend", shell);
    shell.append(button, select);
    document.body.append(menu);

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeCustomSelects(select);
      const open = shell.dataset.open !== "true";
      openSelect = open ? select : null;
      if (open) placeCustomSelect({ shell, button, menu });
      shell.dataset.open = String(open);
      menu.dataset.open = String(open);
      button.setAttribute("aria-expanded", String(open));
    });

    customSelects.set(select, { shell, button, menu });
    syncCustomSelect(select);
  }

  document.addEventListener("click", () => closeCustomSelects());
  window.addEventListener("resize", repositionOpenCustomSelect);
  window.addEventListener("scroll", repositionOpenCustomSelect, true);
  fields.popup.addEventListener("scroll", repositionOpenCustomSelect);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeCustomSelects();
  });
}

function placeCustomSelect(control) {
  const rect = control.button.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const horizontalMargin = 8;
  const menuWidth = Math.min(rect.width, viewportWidth - horizontalMargin * 2);
  const left = Math.min(
    Math.max(horizontalMargin, rect.left),
    Math.max(horizontalMargin, viewportWidth - menuWidth - horizontalMargin)
  );
  control.menu.style.width = `${menuWidth}px`;
  control.menu.style.left = `${left}px`;
  control.menu.style.top = "0px";
  control.menu.dataset.open = "true";
  const menuHeight = Math.min(control.menu.scrollHeight || 0, viewportHeight - 16, 220);
  const spaceBelow = viewportHeight - rect.bottom;
  const top = spaceBelow >= menuHeight + 8
    ? rect.bottom + 4
    : Math.max(8, rect.top - menuHeight - 4);
  control.menu.style.top = `${top}px`;
  control.menu.style.maxHeight = `${Math.max(80, Math.min(220, viewportHeight - top - 8))}px`;
}

function repositionOpenCustomSelect() {
  if (!openSelect) return;
  const control = customSelects.get(openSelect);
  if (!control || control.shell.dataset.open !== "true") return;
  placeCustomSelect(control);
}

function syncCustomSelects() {
  for (const select of customSelects.keys()) {
    syncCustomSelect(select);
  }
}

function syncCustomSelect(select) {
  const control = customSelects.get(select);
  if (!control) return;
  const selected = select.selectedOptions[0];
  control.button.textContent = selected?.textContent || "";
  control.button.disabled = select.disabled;
  control.menu.textContent = "";

  for (const option of select.options) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "select-option";
    item.textContent = option.textContent;
    item.dataset.selected = String(option.value === select.value);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(option.value === select.value));
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      closeCustomSelects();
    });
    control.menu.append(item);
  }
}

function closeCustomSelects(exceptSelect = null) {
  for (const [select, control] of customSelects.entries()) {
    if (select === exceptSelect) continue;
    control.shell.dataset.open = "false";
    control.menu.dataset.open = "false";
    control.button.setAttribute("aria-expanded", "false");
  }
  openSelect = exceptSelect;
}

function normalizeTargetLanguage(language) {
  return ["zh-CN", "zh-TW", "ja-JP", "ko-KR", "en-US"].includes(language)
    ? language
    : "zh-CN";
}

function setStatus(text) {
  fields.status.textContent = text;
}
