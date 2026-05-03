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

const OPENAI_ASR_BASE_URL = "https://api.openai.com/v1";
const MIN_PANEL_HEIGHT = 78;
const PANEL_HEIGHT_SOURCE = "recognition";

const fields = {
  popup: document.querySelector(".popup"),
  panelStage: document.querySelector(".panel-stage"),
  tabs: Array.from(document.querySelectorAll("[data-tab]")),
  tabPanels: Array.from(document.querySelectorAll("[data-tab-panel]")),
  targetLanguage: document.querySelector("#targetLanguage"),
  asrProvider: document.querySelector("#asrProvider"),
  asrEndpointField: document.querySelector("#asrEndpointField"),
  asrApiKeyField: document.querySelector("#asrApiKeyField"),
  asrBaseUrlRequired: document.querySelector("#asrBaseUrlRequired"),
  asrApiKeyRequired: document.querySelector("#asrApiKeyRequired"),
  asrModelField: document.querySelector("#asrModelField"),
  apiEndpointField: document.querySelector("#apiEndpointField"),
  apiKeyField: document.querySelector("#apiKeyField"),
  ttsBaseUrlField: document.querySelector("#ttsBaseUrlField"),
  ttsApiKeyField: document.querySelector("#ttsApiKeyField"),
  ttsModelField: document.querySelector("#ttsModelField"),
  ttsVoiceField: document.querySelector("#ttsVoiceField"),
  duckVolumeLevel: document.querySelector("#duckVolumeLevel"),
  duckVolumeValue: document.querySelector("#duckVolumeValue"),
  ttsProvider: document.querySelector("#ttsProvider"),
  ttsBaseUrl: document.querySelector("#ttsBaseUrl"),
  ttsApiKey: document.querySelector("#ttsApiKey"),
  ttsModel: document.querySelector("#ttsModel"),
  ttsVolume: document.querySelector("#ttsVolume"),
  ttsVolumeValue: document.querySelector("#ttsVolumeValue"),
  ttsVoice: document.querySelector("#ttsVoice"),
  asrEndpoint: document.querySelector("#asrEndpoint"),
  asrApiKey: document.querySelector("#asrApiKey"),
  asrModel: document.querySelector("#asrModel"),
  translatorType: document.querySelector("#translatorType"),
  apiEndpoint: document.querySelector("#apiEndpoint"),
  apiKey: document.querySelector("#apiKey"),
  status: document.querySelector("#status")
};

let saveTimer = null;
const customSelects = new Map();
let openSelect = null;
let lastCustomAsrEndpoint = DEFAULT_SETTINGS.asrEndpoint;

init();

async function init() {
  const settings = await loadSettings();
  render(settings);
  installCustomSelects();
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
  lastCustomAsrEndpoint = normalizeHelperEndpoint(settings.asrEndpoint || DEFAULT_SETTINGS.asrEndpoint);
  fields.asrApiKey.value = settings.asrApiKey || "";
  fields.asrModel.value = settings.asrModel || "";
  fields.translatorType.value =
    settings.translatorType === "api" ? "api" : "publicGoogle";
  fields.apiEndpoint.value = settings.apiEndpoint || "";
  fields.apiKey.value = settings.apiKey || "";
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
    fields.ttsVolume,
    fields.ttsVoice,
    fields.asrEndpoint,
    fields.asrApiKey,
    fields.asrModel,
    fields.translatorType,
    fields.apiEndpoint,
    fields.apiKey
  ]) {
    element.addEventListener("input", scheduleSave);
    element.addEventListener("change", scheduleSave);
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
    ttsVolume: Number(fields.ttsVolume.value) / 100,
    ttsVoiceURI: fields.ttsVoice.value,
    asrEndpoint: normalizeAsrProvider(fields.asrProvider.value) === "custom"
      ? normalizeHelperEndpoint(fields.asrEndpoint.value)
      : normalizeHelperEndpoint(lastCustomAsrEndpoint),
    asrApiKey: fields.asrApiKey.value.trim(),
    asrModel: fields.asrModel.value.trim(),
    translatorType: fields.translatorType.value,
    apiEndpoint: fields.apiEndpoint.value.trim(),
    apiKey: fields.apiKey.value.trim()
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
  const isCustomAsr = asrProvider === "custom";
  const isOpenAiAsr = asrProvider === "openai";
  const isCustomTts = ttsProvider === "custom";

  if (isOpenAiAsr) {
    if (fields.asrEndpoint.value && fields.asrEndpoint.value !== OPENAI_ASR_BASE_URL) {
      lastCustomAsrEndpoint = normalizeHelperEndpoint(fields.asrEndpoint.value);
    }
    fields.asrEndpoint.value = OPENAI_ASR_BASE_URL;
  } else if (!fields.asrEndpoint.value || fields.asrEndpoint.value === OPENAI_ASR_BASE_URL) {
    fields.asrEndpoint.value = lastCustomAsrEndpoint;
  }

  fields.ttsBaseUrlField.hidden = !isCustomTts;
  fields.ttsApiKeyField.hidden = !isCustomTts;
  fields.ttsModelField.hidden = !isCustomTts;
  fields.ttsVoiceField.hidden = isCustomTts;
  fields.ttsBaseUrl.disabled = !isCustomTts;
  fields.ttsApiKey.disabled = !isCustomTts;
  fields.ttsModel.disabled = !isCustomTts;
  fields.ttsVoice.disabled = isCustomTts;

  fields.asrEndpointField.hidden = false;
  fields.asrEndpoint.disabled = !isCustomAsr;
  fields.asrApiKeyField.hidden = false;
  fields.asrApiKey.disabled = false;
  fields.asrBaseUrlRequired.hidden = !isCustomAsr;
  fields.asrApiKeyRequired.hidden = !isOpenAiAsr;
  fields.asrModel.placeholder = isOpenAiAsr ? "Default whisper-1" : "Default tiny.en";
  fields.apiEndpointField.hidden = !isApi;
  fields.apiKeyField.hidden = !isApi;
  fields.apiEndpoint.disabled = !isApi;
  fields.apiKey.disabled = !isApi;
}

function normalizeAsrProvider(provider) {
  return provider === "openai" ? "openai" : "custom";
}

function normalizeTtsProvider(provider) {
  return provider === "custom" ? "custom" : "browser";
}

function setFixedPanelHeight() {
  const sourcePanel = fields.tabPanels.find((panel) => panel.dataset.tabPanel === PANEL_HEIGHT_SOURCE);
  if (!sourcePanel) return;
  const restore = {
    hidden: sourcePanel.hidden,
    position: sourcePanel.style.position,
    visibility: sourcePanel.style.visibility,
    pointerEvents: sourcePanel.style.pointerEvents,
    left: sourcePanel.style.left,
    right: sourcePanel.style.right,
    top: sourcePanel.style.top
  };
  if (sourcePanel.hidden) {
    sourcePanel.hidden = false;
    sourcePanel.style.position = "absolute";
    sourcePanel.style.visibility = "hidden";
    sourcePanel.style.pointerEvents = "none";
    sourcePanel.style.left = "0";
    sourcePanel.style.right = "0";
    sourcePanel.style.top = "0";
  }
  const nextHeight = Math.max(MIN_PANEL_HEIGHT, Math.ceil(sourcePanel.scrollHeight));
  fields.popup.style.setProperty("--panel-height", `${nextHeight}px`);
  if (restore.hidden) {
    sourcePanel.hidden = restore.hidden;
    sourcePanel.style.position = restore.position;
    sourcePanel.style.visibility = restore.visibility;
    sourcePanel.style.pointerEvents = restore.pointerEvents;
    sourcePanel.style.left = restore.left;
    sourcePanel.style.right = restore.right;
    sourcePanel.style.top = restore.top;
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
