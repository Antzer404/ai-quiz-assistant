// 修改自 rehuan/AI-ANSWER-ASSISTANT（GPL-3.0），修改日期：2026-10-26
// DOM Elements
const statusBadge = document.getElementById("statusBadge");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const questionCount = document.getElementById("questionCount");
const answeredCount = document.getElementById("answeredCount");

const scanBtn = document.getElementById("scanBtn");
const startBtn = document.getElementById("startBtn");
const startBtnText = document.getElementById("startBtnText");

// Settings Modal Elements
const settingsModal = document.getElementById("settingsModal");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const closeSettingsBackdrop = document.getElementById("closeSettingsBackdrop");
const modelList = document.getElementById("modelList");
const addModelBtn = document.getElementById("addModelBtn");

// Edit Model Modal Elements
const editModelModal = document.getElementById("editModelModal");
const closeEditBtn = document.getElementById("closeEditBtn");
const closeEditBackdrop = document.getElementById("closeEditBackdrop");
const editModalTitle = document.getElementById("editModalTitle");
const editNameInput = document.getElementById("editName");
const editBaseUrlInput = document.getElementById("editBaseUrl");
const editApiKeyInput = document.getElementById("editApiKey");
const editModelInput = document.getElementById("editModel");
const editStatus = document.getElementById("editStatus");
const saveModelBtn = document.getElementById("saveModelBtn");
const testModelBtn = document.getElementById("testModelBtn");
const toggleEditApiKeyBtn = document.getElementById("toggleEditApiKey");

// 答题设置
const prefsModal = document.getElementById("prefsModal");
const openPrefsBtn = document.getElementById("openPrefsBtn");
const closePrefsBtn = document.getElementById("closePrefsBtn");
const closePrefsBackdrop = document.getElementById("closePrefsBackdrop");
const savePrefsBtn = document.getElementById("savePrefsBtn");
const prefsStatus = document.getElementById("prefsStatus");

const prefAutoNext = document.getElementById("prefAutoNext");
const prefNextMode = document.getElementById("prefNextMode");
const prefQuestionDelay = document.getElementById("prefQuestionDelay");
const prefPageDelay = document.getElementById("prefPageDelay");
const prefMaxPages = document.getElementById("prefMaxPages");
const prefMaxRunMinutes = document.getElementById("prefMaxRunMinutes");
const prefRequireAllAnswered = document.getElementById("prefRequireAllAnswered");
const prefSkipOnError = document.getElementById("prefSkipOnError");
const prefMaxRetries = document.getElementById("prefMaxRetries");
const prefResumeWaitMs = document.getElementById("prefResumeWaitMs");
const prefNextSelector = document.getElementById("prefNextSelector");
const prefSubmitSelector = document.getElementById("prefSubmitSelector");
const prefNextText = document.getElementById("prefNextText");
const prefSubmitText = document.getElementById("prefSubmitText");
const prefWebSearch = document.getElementById("prefWebSearch");
const prefWebSearchProvider = document.getElementById("prefWebSearchProvider");
const prefReasoningEffort = document.getElementById("prefReasoningEffort");
const prefManualQuestionSelector = document.getElementById(
  "prefManualQuestionSelector"
);
const manualSelectorHost = document.getElementById("manualSelectorHost");
const manualSelectorStatus = document.getElementById("manualSelectorStatus");
const testManualSelectorBtn = document.getElementById("testManualSelectorBtn");
const clearCurrentSiteMemoryBtn = document.getElementById(
  "clearCurrentSiteMemoryBtn"
);
const siteMemoryInfo = document.getElementById("siteMemoryInfo");
const clearSiteMemoryBtn = document.getElementById("clearSiteMemoryBtn");

let editingModelId = null;

const logContent = document.getElementById("logContent");
const clearLogBtn = document.getElementById("clearLog");

// State
let isRunning = false;
let hasScanned = false;
let prefs = null;
let currentTabHost = "";

const STORAGE_KEYS = {
  models: "aiModels",
  activeModelId: "activeModelId",
};

// Initialize
document.addEventListener("DOMContentLoaded", async () => {
  await initModels();
  await loadPrefs();

  // Check active session
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    const manualSelector = getManualSelectorForUrl(tabs[0].url, prefs);
    const frameId = await pickQuestionFrame(tabs[0].id, manualSelector);
    const response = await sendToFrame(tabs[0].id, frameId, {
      action: "getStatus",
    });

    if (response && !response.error) {
      questionCount.textContent = response.questionCount || 0;
      answeredCount.textContent = response.answeredCount || 0;

      if (response.isRunning) {
        setRunningState(true);
        addLog("info", "检测到正在运行的任务");
      } else if (response.questionCount > 0) {
        hasScanned = true;
        startBtn.disabled = false;
        addLog("info", "检测到已扫描题目，可以开始");
      }
    }
  }
});

// --- Modal Logic ---
function openModal() {
  settingsModal.classList.add("open");
  renderModelList();
}

function closeModal() {
  settingsModal.classList.remove("open");
}

function openEditModal(modelId = null) {
  editingModelId = modelId;
  editModelModal.classList.add("open");

  if (modelId) {
    editModalTitle.textContent = "编辑模型";
    loadModelForEdit(modelId);
  } else {
    editModalTitle.textContent = "添加模型";
    editNameInput.value = "";
    editBaseUrlInput.value = "https://api.openai.com/v1";
    editApiKeyInput.value = "";
    editModelInput.value = "";
  }
}

function closeEditModal() {
  editModelModal.classList.remove("open");
  editingModelId = null;
}

openSettingsBtn.addEventListener("click", openModal);
closeSettingsBtn.addEventListener("click", closeModal);
closeSettingsBackdrop.addEventListener("click", closeModal);
addModelBtn.addEventListener("click", () => openEditModal());
closeEditBtn.addEventListener("click", closeEditModal);
closeEditBackdrop.addEventListener("click", closeEditModal);

// 答题设置
openPrefsBtn.addEventListener("click", async () => {
  await resolveCurrentTabHost();
  await loadPrefs();
  await renderSiteMemoryInfo();
  prefsModal.classList.add("open");
});
closePrefsBtn.addEventListener("click", () => {
  prefsModal.classList.remove("open");
});
closePrefsBackdrop.addEventListener("click", () => {
  prefsModal.classList.remove("open");
});
savePrefsBtn.addEventListener("click", savePrefs);

// --- Template Management ---
const openTemplatesBtn = document.getElementById("openTemplatesBtn");
openTemplatesBtn.addEventListener("click", () => {
  window.location.href = "template-manager.html";
});

// --- Model Management Logic ---
toggleEditApiKeyBtn.addEventListener("click", () => {
  const type = editApiKeyInput.type === "password" ? "text" : "password";
  editApiKeyInput.type = type;
  toggleEditApiKeyBtn.style.opacity = type === "text" ? "1" : "0.6";
});

async function initModels() {
  const local = await chrome.storage.local.get([
    STORAGE_KEYS.models,
    STORAGE_KEYS.activeModelId,
  ]);

  // 已经初始化过（包括空列表）就不再迁移，避免覆盖用户删除后的状态
  if (Array.isArray(local.aiModels)) return;

  // 从旧版的 chrome.storage.sync 迁移配置；内置中转模型不再保留
  let sync = {};
  try {
    sync = await chrome.storage.sync.get([
      "aiModels",
      "baseUrl",
      "apiKey",
      "model",
    ]);
  } catch (error) {
    console.warn("[popup] 读取旧版 sync 配置失败:", error);
  }

  let models = [];
  const legacyModels = Array.isArray(sync.aiModels) ? sync.aiModels : [];

  if (legacyModels.length) {
    models = legacyModels
      .filter((model) => model && model.baseUrl && model.apiKey && !model.builtin)
      .map((model) => ({
        id: model.id || "custom-" + Date.now(),
        name: model.name || "自定义模型",
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.model || "",
        builtin: false,
      }));
  } else if (sync.apiKey) {
    models = [
      {
        id: "custom-" + Date.now(),
        name: "自定义模型",
        baseUrl: sync.baseUrl || "https://api.openai.com/v1",
        apiKey: sync.apiKey,
        model: sync.model || "gpt-4o-mini",
        builtin: false,
      },
    ];
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.models]: models,
    [STORAGE_KEYS.activeModelId]:
      local.activeModelId || (models[0] ? models[0].id : null),
  });

  // 旧版本把 API Key 放在 sync（会同步到 Google 账号），迁移后清除
  try {
    await chrome.storage.sync.remove([
      "aiModels",
      "baseUrl",
      "apiKey",
      "model",
    ]);
  } catch (_) {
    /* ignore */
  }
}

async function getAllModels() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.models]);
  return Array.isArray(data.aiModels) ? data.aiModels.filter(Boolean) : [];
}

async function getActiveModel() {
  const [data, models] = await Promise.all([
    chrome.storage.local.get([STORAGE_KEYS.activeModelId]),
    getAllModels(),
  ]);

  if (!models.length) return null;

  const activeId = data[STORAGE_KEYS.activeModelId];
  return (
    models.find((model) => model.id === activeId) || models[0]
  );
}

async function renderModelList() {
  const models = await getAllModels();
  const data = await chrome.storage.local.get([STORAGE_KEYS.activeModelId]);
  const activeId =
    data[STORAGE_KEYS.activeModelId] || (models[0] ? models[0].id : null);

  if (models.length === 0) {
    modelList.innerHTML = `
      <div class="empty-state">
        还没有配置模型。<br>
        点击下方“添加自定义模型”，填写 Base URL、API Key 和模型 ID。
      </div>
    `;
    return;
  }

  modelList.innerHTML = models
    .map(
      (model) => `
    <div class="model-item ${
      model.id === activeId ? "active" : ""
    }" data-model-id="${escapeHtml(model.id)}">
      <input type="radio" name="activeModel" class="model-radio" value="${escapeHtml(
        model.id
      )}" ${model.id === activeId ? "checked" : ""}>
      <div class="model-info">
        <div class="model-name">${escapeHtml(model.name || "未命名模型")}</div>
        <div class="model-meta">${escapeHtml(model.model || "")}</div>
      </div>
      <div class="model-actions">
        <button class="icon-btn edit-model-btn" data-model-id="${escapeHtml(
          model.id
        )}">
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
        </button>
        <button class="icon-btn delete-model-btn" data-model-id="${escapeHtml(
          model.id
        )}">
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
        </button>
      </div>
    </div>
  `
    )
    .join("");

  // Add click event to entire model card
  document.querySelectorAll(".model-item").forEach((item) => {
    item.addEventListener("click", async (e) => {
      // Don't trigger if clicking on action buttons
      if (
        e.target.closest(".edit-model-btn") ||
        e.target.closest(".delete-model-btn")
      ) {
        return;
      }

      const modelId = item.dataset.modelId;
      const model = models.find((m) => m.id === modelId);
      if (!model) return;

      await chrome.storage.local.set({
        [STORAGE_KEYS.activeModelId]: modelId,
      });
      addLog("success", `已使用模型：${model.name}`);
      closeModal();
    });
  });

  // Add event listeners for radio buttons
  document.querySelectorAll(".model-radio").forEach((radio) => {
    radio.addEventListener("change", async (e) => {
      e.stopPropagation();
      await chrome.storage.local.set({
        [STORAGE_KEYS.activeModelId]: e.target.value,
      });
      renderModelList();
    });
  });

  // Add event listeners for edit buttons
  document.querySelectorAll(".edit-model-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const modelId = e.currentTarget.dataset.modelId;
      openEditModal(modelId);
    });
  });

  // Add event listeners for delete buttons
  document.querySelectorAll(".delete-model-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const modelId = e.currentTarget.dataset.modelId;
      if (!confirm("确定要删除这个模型吗？")) return;

      const data = await chrome.storage.local.get([
        STORAGE_KEYS.models,
        STORAGE_KEYS.activeModelId,
      ]);
      const nextModels = (data.aiModels || []).filter(
        (m) => m.id !== modelId
      );

      const updates = { [STORAGE_KEYS.models]: nextModels };
      if (data[STORAGE_KEYS.activeModelId] === modelId) {
        updates[STORAGE_KEYS.activeModelId] = nextModels[0]
          ? nextModels[0].id
          : null;
      }

      await chrome.storage.local.set(updates);
      renderModelList();
    });
  });
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadModelForEdit(modelId) {
  const models = await getAllModels();
  const model = models.find((m) => m.id === modelId);
  if (model) {
    editNameInput.value = model.name;
    editBaseUrlInput.value = model.baseUrl;
    editApiKeyInput.value = model.apiKey;
    editModelInput.value = model.model;
  }
}

function readModelForm() {
  return {
    name: editNameInput.value.trim(),
    baseUrl: editBaseUrlInput.value.trim(),
    apiKey: editApiKeyInput.value.trim(),
    model: editModelInput.value.trim(),
  };
}

function validateModelForm(form) {
  if (!form.name || !form.baseUrl || !form.apiKey || !form.model) {
    return "请填写所有配置项";
  }
  if (!/^https?:\/\//i.test(form.baseUrl)) {
    return "Base URL 必须以 http:// 或 https:// 开头";
  }
  if (form.baseUrl.includes("?")) {
    return "Base URL 不要包含查询参数（?），只填写到 /v1 这一级";
  }
  return "";
}

saveModelBtn.addEventListener("click", async () => {
  const form = readModelForm();
  const validationError = validateModelForm(form);
  if (validationError) {
    showEditStatus("error", validationError);
    return;
  }

  saveModelBtn.disabled = true;
  saveModelBtn.textContent = "保存中...";

  const data = await chrome.storage.local.get([STORAGE_KEYS.models]);
  const models = Array.isArray(data.aiModels) ? data.aiModels : [];

  if (editingModelId) {
    const index = models.findIndex((m) => m.id === editingModelId);
    if (index !== -1) {
      models[index] = { ...models[index], ...form };
    }
  } else {
    models.push({
      id: "custom-" + Date.now(),
      ...form,
      builtin: false,
    });
  }

  const active = await chrome.storage.local.get([
    STORAGE_KEYS.activeModelId,
  ]);
  const updates = { [STORAGE_KEYS.models]: models };
  if (!active[STORAGE_KEYS.activeModelId] && models.length) {
    updates[STORAGE_KEYS.activeModelId] = models[0].id;
  }

  await chrome.storage.local.set(updates);

  setTimeout(() => {
    saveModelBtn.disabled = false;
    saveModelBtn.textContent = "保存";
    showEditStatus("success", "保存成功");
    setTimeout(() => {
      closeEditModal();
      renderModelList();
    }, 400);
  }, 200);
});

testModelBtn.addEventListener("click", async () => {
  const form = readModelForm();
  const validationError = validateModelForm(form);
  if (validationError) {
    showEditStatus("error", validationError);
    return;
  }

  testModelBtn.disabled = true;
  testModelBtn.textContent = "测试中...";
  showEditStatus("info", "正在连接 API...");

  chrome.runtime.sendMessage(
    {
      action: "testConnection",
      config: {
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        model: form.model,
      },
    },
    (response) => {
      testModelBtn.disabled = false;
      testModelBtn.textContent = "测试连接";

      if (chrome.runtime.lastError) {
        showEditStatus("error", chrome.runtime.lastError.message);
        return;
      }
      if (response && response.success) {
        showEditStatus(
          "success",
          `连接成功（${response.latency}ms）：${response.sample || "OK"}`
        );
      } else {
        showEditStatus(
          "error",
          (response && response.error) || "连接失败"
        );
      }
    }
  );
});

function showEditStatus(type, message) {
  editStatus.textContent = message;
  editStatus.className = `config-status ${type}`;
  clearTimeout(showEditStatus._timer);
  showEditStatus._timer = setTimeout(() => {
    editStatus.textContent = "";
    editStatus.className = "config-status";
  }, 6000);
}

// --- 答题设置 ---

async function resolveCurrentTabHost() {
  currentTabHost = "";
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs[0] && tabs[0].url;
    if (url) currentTabHost = new URL(url).hostname.toLowerCase();
  } catch (error) {
    console.warn("[popup] 读取当前站点失败:", error);
  }

  if (!manualSelectorHost) return;
  manualSelectorHost.textContent = currentTabHost
    ? `当前站点：${currentTabHost}`
    : "当前站点：无法读取（请切换到普通网页后重试）";
}

async function loadPrefs() {
  prefs = await window.QuizSettings.get();
  renderPrefs();
}

function renderManualSelector() {
  const selectors =
    (prefs && prefs.manualQuestionSelectors) || {};
  const selector = currentTabHost ? selectors[currentTabHost] || "" : "";

  if (prefManualQuestionSelector) {
    prefManualQuestionSelector.value = selector;
    prefManualQuestionSelector.disabled = !currentTabHost;
  }
  if (testManualSelectorBtn) testManualSelectorBtn.disabled = !currentTabHost;
  if (clearCurrentSiteMemoryBtn) {
    clearCurrentSiteMemoryBtn.disabled = !currentTabHost;
  }
}

function showManualSelectorStatus(type, message) {
  if (!manualSelectorStatus) return;
  manualSelectorStatus.textContent = message;
  manualSelectorStatus.className = `field-hint manual-selector-status ${type}`;
  clearTimeout(showManualSelectorStatus._timer);
  showManualSelectorStatus._timer = setTimeout(() => {
    manualSelectorStatus.textContent = "";
    manualSelectorStatus.className = "field-hint";
  }, 8000);
}

function renderPrefs() {
  if (!prefs) prefs = window.QuizSettings.normalize();
  prefAutoNext.checked = Boolean(prefs.autoNext);
  prefNextMode.value = prefs.nextMode;
  prefQuestionDelay.value = prefs.questionDelay;
  prefPageDelay.value = prefs.pageDelay;
  prefMaxPages.value = prefs.maxPages;
  prefMaxRunMinutes.value = prefs.maxRunMinutes;
  prefRequireAllAnswered.checked = Boolean(prefs.requireAllAnswered);
  prefSkipOnError.checked = Boolean(prefs.skipOnError);
  prefMaxRetries.value = prefs.maxRetries;
  prefResumeWaitMs.value = prefs.resumeWaitMs;
  prefNextSelector.value = prefs.nextSelector || "";
  prefSubmitSelector.value = prefs.submitSelector || "";
  prefNextText.value = (prefs.nextText || []).join(",");
  prefSubmitText.value = (prefs.submitText || []).join(",");
  prefWebSearch.checked = Boolean(prefs.webSearch);
  prefWebSearchProvider.value = prefs.webSearchProvider || "auto";
  prefReasoningEffort.value = prefs.reasoningEffort || "";
  updateWebSearchControls();
  renderManualSelector();
}

function updateWebSearchControls() {
  prefWebSearchProvider.disabled = !prefWebSearch.checked;
}

prefWebSearch.addEventListener("change", updateWebSearchControls);

function collectPrefs() {
  const manualQuestionSelectors = {
    ...((prefs && prefs.manualQuestionSelectors) || {}),
  };
  if (currentTabHost) {
    const selector = prefManualQuestionSelector.value.trim();
    if (selector) {
      manualQuestionSelectors[currentTabHost] = selector;
    } else {
      delete manualQuestionSelectors[currentTabHost];
    }
  }

  return {
    autoNext: prefAutoNext.checked,
    nextMode: prefNextMode.value,
    questionDelay: prefQuestionDelay.value,
    pageDelay: prefPageDelay.value,
    maxPages: prefMaxPages.value,
    maxRunMinutes: prefMaxRunMinutes.value,
    requireAllAnswered: prefRequireAllAnswered.checked,
    skipOnError: prefSkipOnError.checked,
    maxRetries: prefMaxRetries.value,
    resumeWaitMs: prefResumeWaitMs.value,
    nextSelector: prefNextSelector.value,
    submitSelector: prefSubmitSelector.value,
    nextText: prefNextText.value,
    submitText: prefSubmitText.value,
    webSearch: prefWebSearch.checked,
    webSearchProvider: prefWebSearchProvider.value,
    reasoningEffort: prefReasoningEffort.value,
    manualQuestionSelectors,
  };
}

testManualSelectorBtn.addEventListener("click", async () => {
  if (!currentTabHost) {
    showManualSelectorStatus("error", "请先切换到有题目的网页");
    return;
  }
  const selector = prefManualQuestionSelector.value.trim();
  if (!selector) {
    showManualSelectorStatus("error", "请先填写题目区域选择器");
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) {
    showManualSelectorStatus("error", "无法获取当前标签页");
    return;
  }

  testManualSelectorBtn.disabled = true;
  testManualSelectorBtn.textContent = "测试中...";

  try {
    const frames = await probeFrames(tab.id, selector);
    const invalid = frames.some((frame) => frame.manualError);
    const matches = frames.filter((frame) => frame.manual > 0);

    if (invalid) {
      showManualSelectorStatus("error", "选择器语法无效，请重新复制");
    } else if (matches.length) {
      const detail = matches
        .map(
          (frame) =>
            `frame ${frame.frameId}${
              frame.isTop ? "（顶层）" : "（iframe）"
            }：${frame.manual} 个`
        )
        .join("；");
      showManualSelectorStatus("success", `选择器有效，${detail}`);
    } else {
      const iframeCount = frames.filter((frame) => !frame.isTop).length;
      showManualSelectorStatus(
        "warning",
        iframeCount
          ? `未匹配到元素；已检查 ${iframeCount} 个 iframe，请确认复制的选择器属于哪个 frame`
          : "未匹配到元素，请检查选择器是否正确"
      );
    }
  } catch (error) {
    showManualSelectorStatus("error", `测试失败：${error.message}`);
  } finally {
    testManualSelectorBtn.disabled = false;
    testManualSelectorBtn.textContent = "测试选择器";
  }
});

clearCurrentSiteMemoryBtn.addEventListener("click", async () => {
  if (!currentTabHost) {
    showManualSelectorStatus("error", "请先切换到有题目的网页");
    return;
  }

  const confirmed = confirm(
    `确定要清除 ${currentTabHost} 的本地结构记忆吗？下次会重新用 AI 分析页面结构。`
  );
  if (!confirmed) return;

  try {
    const data = await chrome.storage.local.get("siteStructureMemory");
    const store = data.siteStructureMemory;
    if (!store || !store.sites || !store.sites[currentTabHost]) {
      showManualSelectorStatus("warning", "当前站点没有本地结构记忆");
      return;
    }
    delete store.sites[currentTabHost];
    await chrome.storage.local.set({ siteStructureMemory: store });
    await renderSiteMemoryInfo();
    showManualSelectorStatus("success", "已清除当前站点的本地结构记忆");
  } catch (error) {
    showManualSelectorStatus("error", `清除失败：${error.message}`);
  }
});

async function renderSiteMemoryInfo() {
  if (!siteMemoryInfo) return;
  try {
    const data = await chrome.storage.local.get("siteStructureMemory");
    const store = data.siteStructureMemory;
    const sites =
      store && store.sites && typeof store.sites === "object"
        ? Object.values(store.sites)
        : [];
    const templateCount = sites.reduce(
      (sum, site) =>
        sum + (Array.isArray(site.templates) ? site.templates.length : 0),
      0
    );

    if (!sites.length) {
      siteMemoryInfo.textContent =
        "还没有本地结构记忆。首次遇到新站点时会自动学习。";
      return;
    }

    const hosts = sites
      .map((site) => site.host)
      .filter(Boolean)
      .slice(0, 6)
      .join("、");
    siteMemoryInfo.textContent = `已记住 ${sites.length} 个站点、${templateCount} 个页面结构${
      hosts ? `：${hosts}${sites.length > 6 ? " 等" : ""}` : ""
    }`;
  } catch (error) {
    siteMemoryInfo.textContent = "读取本地结构记忆失败";
  }
}

clearSiteMemoryBtn.addEventListener("click", async () => {
  const confirmed = confirm(
    "确定要清除所有本地结构记忆吗？下次遇到这些站点会重新用 AI 分析页面结构。"
  );
  if (!confirmed) return;

  await chrome.storage.local.remove("siteStructureMemory");
  await renderSiteMemoryInfo();
  addLog("info", "已清除本地结构记忆");
});

async function savePrefs() {
  savePrefsBtn.disabled = true;
  savePrefsBtn.textContent = "保存中...";
  try {
    prefs = await window.QuizSettings.save(collectPrefs());
    renderPrefs();
    showPrefsStatus("success", "设置已保存");
    addLog("success", "答题设置已保存");
  } catch (error) {
    showPrefsStatus("error", `保存失败：${error.message}`);
  } finally {
    savePrefsBtn.disabled = false;
    savePrefsBtn.textContent = "保存设置";
  }
}

function showPrefsStatus(type, message) {
  prefsStatus.textContent = message;
  prefsStatus.className = `config-status ${type}`;
  clearTimeout(showPrefsStatus._timer);
  showPrefsStatus._timer = setTimeout(() => {
    prefsStatus.textContent = "";
    prefsStatus.className = "config-status";
  }, 3000);
}

async function getRunSettings() {
  prefs = await window.QuizSettings.get();
  return prefs;
}

// --- Frame 路由 ---
// 题目可能位于 iframe 中：先探测每个 frame，再把扫描/开始/状态请求
// 精确发送到真正包含题目的 frame。

const activeFrameIds = new Map();

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function getManualSelectorForUrl(url, settingsLike) {
  const host = hostFromUrl(url);
  const map = (settingsLike && settingsLike.manualQuestionSelectors) || {};
  return host ? map[host] || "" : "";
}

async function probeFrames(tabId, manualSelector = "") {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (selector) => {
        let manualError = false;
        const count = (value) => {
          try {
            return document.querySelectorAll(value).length;
          } catch (_) {
            return 0;
          }
        };
        const countManual = (value) => {
          try {
            return document.querySelectorAll(value).length;
          } catch (_) {
            manualError = true;
            return 0;
          }
        };
        const manual = selector ? countManual(selector) : 0;
        return {
          isTop: window === window.top,
          href: location.href,
          manualError,
          manual,
          radio: count('input[type="radio"], input[type="checkbox"]'),
          fill: count(
            'input[type="text"], input[type="number"], textarea, [contenteditable="true"]'
          ),
          questionBlocks: count(
            '.question, .exam-question, .topic, .subject, .problem, [class*="question" i]'
          ),
        };
      },
      args: [manualSelector],
    });

    return (results || [])
      .filter((item) => item && item.result)
      .map((item) => ({ frameId: item.frameId, ...item.result }));
  } catch (error) {
    console.warn("[popup] 探测 frame 失败:", error);
    return [];
  }
}

function scoreFrame(frame) {
  if (!frame) return 0;
  let score = 0;
  if (frame.manual > 0) score += 10000 + Math.min(frame.manual, 50) * 10;
  score += Math.min(frame.radio || 0, 50) * 8;
  score += Math.min(frame.fill || 0, 20) * 4;
  score += Math.min(frame.questionBlocks || 0, 20) * 2;
  return score;
}

async function pickQuestionFrame(tabId, manualSelector = "") {
  const cached = activeFrameIds.get(tabId);
  const frames = await probeFrames(tabId, manualSelector);
  if (!frames.length) {
    const frameId = typeof cached === "number" ? cached : 0;
    activeFrameIds.set(tabId, frameId);
    return frameId;
  }

  frames.sort(
    (a, b) =>
      scoreFrame(b) - scoreFrame(a) ||
      (b.isTop ? 1 : 0) - (a.isTop ? 1 : 0)
  );

  const best = frames[0];
  // 探测不到明显题目特征时，沿用上次扫描成功的 frame（纯 div 点击题可能没有特征）
  const frameId =
    best && scoreFrame(best) > 0
      ? best.frameId
      : typeof cached === "number"
      ? cached
      : 0;
  activeFrameIds.set(tabId, frameId);
  console.log(
    "[popup] frame 探测:",
    frames.map((frame) => ({
      frameId: frame.frameId,
      top: frame.isTop,
      manual: frame.manual,
      radio: frame.radio,
      fill: frame.fill,
      blocks: frame.questionBlocks,
    })),
    "->",
    frameId
  );
  return frameId;
}

function sendToFrame(tabId, frameId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response || {});
      }
    });
  });
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Action Logic ---

// 确保 content script 已注入到目标页面
async function ensureContentScriptInjected(tabId) {
  try {
    // 先尝试发送一个测试消息
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: "getStatus" }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script 未加载，尝试注入
          console.log("[popup] Content script 未加载，尝试注入...");
          injectContentScript(tabId)
            .then(resolve)
            .catch(() => resolve(false));
        } else {
          // 已加载
          resolve(true);
        }
      });
    });
  } catch (e) {
    console.error("[popup] 检查 content script 失败:", e);
    return false;
  }
}

// 程序化注入 content script
async function injectContentScript(tabId) {
  try {
    // 检查是否是可以注入的页面
    const tab = await chrome.tabs.get(tabId);
    if (
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("edge://") ||
      tab.url.startsWith("about:")
    ) {
      console.log("[popup] 无法在系统页面注入脚本");
      return false;
    }

    // 注入 CSS
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ["content.css"],
    });

    // 按顺序注入 JS 模块
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [
        "modules/settings.js",
        "modules/navigation.js",
        "modules/site-matcher.js",
        "modules/template-manager.js",
        "modules/scanner-enhanced.js",
        "modules/site-memory.js",
        "content.js",
      ],
    });

    console.log("[popup] Content script 注入成功");
    // 等待脚本初始化
    await new Promise((resolve) => setTimeout(resolve, 200));
    return true;
  } catch (e) {
    console.error("[popup] 注入 content script 失败:", e);
    return false;
  }
}

// 1. Scan
scanBtn.addEventListener("click", async () => {
  const activeModel = await getActiveModel();
  const config = activeModel
    ? {
        baseUrl: activeModel.baseUrl,
        apiKey: activeModel.apiKey,
        model: activeModel.model,
      }
    : null;
  const runSettings = await getRunSettings();

  if (!activeModel) {
    addLog("warning", "尚未配置模型，将只尝试站点模板扫描");
  }

  addLog("info", "正在扫描题目...");
  updateStatus("running", "扫描中...");
  scanBtn.disabled = true;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) {
    addLog("error", "无法获取当前标签页");
    updateStatus("error", "连接失败");
    scanBtn.disabled = false;
    return;
  }

  const tab = tabs[0];

  // 检查是否是系统页面
  if (
    !tab.url ||
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("chrome-extension://") ||
    tab.url.startsWith("edge://") ||
    tab.url.startsWith("about:")
  ) {
    addLog("error", "请切换到有题目的网页再扫描");
    updateStatus("error", "系统页面");
    scanBtn.disabled = false;
    return;
  }

  // 确保 content script 已注入
  const injected = await ensureContentScriptInjected(tab.id);
  if (!injected) {
    addLog("error", "无法连接到页面，请刷新页面后重试");
    updateStatus("error", "连接失败");
    scanBtn.disabled = false;
    return;
  }

  // 题目可能在 iframe 中：探测并只向包含题目的 frame 发送扫描请求
  const manualSelector = getManualSelectorForUrl(tab.url, runSettings);
  let frameId = await pickQuestionFrame(tab.id, manualSelector);
  if (frameId !== 0) {
    addLog("info", `题目可能位于 iframe（frameId: ${frameId}），正在该 frame 中扫描`);
  }

  let response = await sendToFrame(tab.id, frameId, {
    action: "scan",
    config,
    settings: runSettings,
  });

  if (response && response.error) {
    addLog("warning", "目标 frame 尚未就绪，尝试重新注入后重试...");
    await injectContentScript(tab.id);
    await wait(300);
    frameId = await pickQuestionFrame(tab.id, manualSelector);
    response = await sendToFrame(tab.id, frameId, {
      action: "scan",
      config,
      settings: runSettings,
    });
  }

  scanBtn.disabled = false;

  if (!response || response.error) {
    addLog("error", "连接失败，请刷新页面后重试");
    updateStatus("error", "连接失败");
    return;
  }

  if (response.success) {
    activeFrameIds.set(tab.id, frameId);
    questionCount.textContent = response.count;
    hasScanned = true;
    startBtn.disabled = false;
    addLog("success", `扫描完成: ${response.count} 题`);
    updateStatus("ready", "扫描完成");
  } else {
    addLog("warning", response.message || "未发现题目");
    updateStatus("ready", "未发现题目");
  }
});

// 2. Start/Pause Toggle
startBtn.addEventListener("click", async () => {
  if (!hasScanned && !isRunning) return;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) {
    addLog("error", "无法获取当前标签页");
    return;
  }

  const tab = tabs[0];

  if (isRunning) {
    // Pause/Stop
    setRunningState(false);
    addLog("warning", "已停止答题");
    // 即使 content script 正在页面跳转，也由后台清掉会话，防止新页面自动恢复
    chrome.runtime.sendMessage({ action: "sessionStop", tabId: tab.id });
    chrome.runtime.sendMessage({ action: "sessionClear", tabId: tab.id });
    activeFrameIds.delete(tab.id);
    chrome.tabs.sendMessage(tab.id, { action: "stop" });
  } else {
    // 检查是否是系统页面
    if (
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("edge://") ||
      tab.url.startsWith("about:")
    ) {
      addLog("error", "请切换到有题目的网页");
      return;
    }

    // 确保 content script 已注入
    const injected = await ensureContentScriptInjected(tab.id);
    if (!injected) {
      addLog("error", "无法连接到页面，请刷新页面后重试");
      return;
    }

    // Start
    const activeModel = await getActiveModel();
    if (!activeModel) {
      addLog("error", "请先在设置中添加并选择一个模型");
      openEditModal();
      return;
    }

    const config = {
      baseUrl: activeModel.baseUrl,
      apiKey: activeModel.apiKey,
      model: activeModel.model,
    };
    const runSettings = await getRunSettings();
    const manualSelector = getManualSelectorForUrl(tab.url, runSettings);
    let frameId = await pickQuestionFrame(tab.id, manualSelector);

    setRunningState(true);
    addLog("info", "🚀 开始自动答题");
    let response = await sendToFrame(tab.id, frameId, {
      action: "start",
      config,
      settings: runSettings,
    });

    if (response && response.error) {
      addLog("warning", "目标 frame 尚未就绪，尝试重新注入后重试...");
      await injectContentScript(tab.id);
      await wait(300);
      frameId = await pickQuestionFrame(tab.id, manualSelector);
      response = await sendToFrame(tab.id, frameId, {
        action: "start",
        config,
        settings: runSettings,
      });
    }

    if (!response || response.error) {
      setRunningState(false);
      addLog("error", "连接中断，请刷新页面后重试");
      return;
    }
    if (response.success === false) {
      setRunningState(false);
      addLog("error", response.error || "启动失败");
    }
  }
});

function setRunningState(active) {
  isRunning = active;
  if (active) {
    startBtn.disabled = false;
    startBtnText.textContent = "停止答题";
    startBtn.classList.remove("btn-dark");
    startBtn.classList.add("btn-warning");
    scanBtn.disabled = true;
    updateStatus("running", "答题中...");
  } else {
    startBtn.disabled = !hasScanned; // Keep enabled if we have scanned
    startBtnText.textContent = "开始自动答题";
    startBtn.classList.remove("btn-warning");
    startBtn.classList.add("btn-dark");
    scanBtn.disabled = false;
    updateStatus("ready", "就绪");
  }
}

// --- Helpers ---

function updateStatus(type, text) {
  statusDot.className = `status-dot ${type}`;
  statusText.textContent = text;
}

function addLog(type, message) {
  const time = new Date().toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const logItem = document.createElement("div");
  logItem.className = `log-item log-${type}`;

  // 用 textContent 而不是 innerHTML：模型/API 返回的错误文本不可信
  const timeEl = document.createElement("span");
  timeEl.className = "log-time";
  timeEl.textContent = time;

  const messageEl = document.createElement("span");
  messageEl.className = "log-msg";
  messageEl.textContent = String(message === undefined ? "" : message);

  logItem.append(timeEl, messageEl);
  logContent.appendChild(logItem);
  logContent.scrollTop = logContent.scrollHeight;
}

clearLogBtn.addEventListener("click", () => {
  logContent.innerHTML = "";
  addLog("info", "日志已清空");
});

// Message Listener
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "log":
      addLog(message.level, message.text);
      break;
    case "updateStats":
      if (message.questionCount !== undefined) {
        questionCount.textContent = message.questionCount;
      }
      if (message.answeredCount !== undefined) {
        answeredCount.textContent = message.answeredCount;
      }
      // 跨页面自动恢复时，让侧边栏与页面状态保持同步
      if (message.isRunning === true && !isRunning) {
        setRunningState(true);
      } else if (message.isRunning === false && isRunning) {
        setRunningState(false);
      }
      break;
    case "complete":
      setRunningState(false);
      if (message.stopped) {
        updateStatus("ready", "已停止");
        addLog(
          "warning",
          `已停止（本次完成 ${message.answeredCount || 0} 题）`
        );
      } else {
        updateStatus("ready", "完成");
        addLog(
          "success",
          `🎉 本次任务完成（共 ${message.answeredCount || 0} 题）`
        );
      }
      break;
    case "error":
      setRunningState(false);
      updateStatus("error", "错误");
      addLog("error", message.text);
      break;
  }
});
