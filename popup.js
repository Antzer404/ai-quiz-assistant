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

let editingModelId = null;

const logContent = document.getElementById("logContent");
const clearLogBtn = document.getElementById("clearLog");

// State
let isRunning = false;
let hasScanned = false;
let prefs = null;

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
    chrome.tabs.sendMessage(tabs[0].id, { action: "getStatus" }, (response) => {
      if (chrome.runtime.lastError) return;

      if (response) {
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
    });
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
  await loadPrefs();
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

async function loadPrefs() {
  prefs = await window.QuizSettings.get();
  renderPrefs();
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
}

function collectPrefs() {
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
  };
}

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
      target: { tabId },
      files: ["content.css"],
    });

    // 按顺序注入 JS 模块
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "modules/settings.js",
        "modules/navigation.js",
        "modules/site-matcher.js",
        "modules/template-manager.js",
        "modules/scanner-enhanced.js",
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

  chrome.tabs.sendMessage(
    tab.id,
    { action: "scan", config, settings: runSettings },
    (response) => {
    scanBtn.disabled = false;

    if (chrome.runtime.lastError) {
      addLog("error", "连接失败，请刷新页面后重试");
      updateStatus("error", "连接失败");
      return;
    }

      if (response && response.success) {
        questionCount.textContent = response.count;
        hasScanned = true;
        startBtn.disabled = false;
        addLog("success", `扫描完成: ${response.count} 题`);
        updateStatus("ready", "扫描完成");
      } else {
        addLog("warning", (response && response.message) || "未发现题目");
        updateStatus("ready", "未发现题目");
      }
    }
  );
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

    setRunningState(true);
    addLog("info", "🚀 开始自动答题");
    chrome.tabs.sendMessage(
      tab.id,
      {
        action: "start",
        config,
        settings: runSettings,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          setRunningState(false);
          addLog("error", "连接中断，请刷新页面后重试");
          return;
        }
        if (response && response.success === false) {
          setRunningState(false);
          addLog("error", response.error || "启动失败");
        }
      }
    );
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
