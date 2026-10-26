// 本文件属于基于 rehuan/AI-ANSWER-ASSISTANT（GPL-3.0）的修改版，新增日期：2026-10-26
// Settings Module - 统一的答题设置
// 由 popup / content script 共用。设置保存在 chrome.storage.local。

(function () {
  "use strict";

  const STORAGE_KEY = "answerSettings";

  const DEFAULTS = {
    // 自动下一题
    autoNext: true,
    nextMode: "auto", // auto | paginate | scroll

    // 节奏控制
    questionDelay: 800,
    pageDelay: 2000,

    // 安全边界
    maxPages: 50,
    maxRunMinutes: 30,
    requireAllAnswered: true,
    skipOnError: true,
    maxRetries: 1,

    // 通用按钮识别（逗号分隔）
    nextText: "下一题,下一页,继续,下一步,Next,Continue",
    submitText: "提交,交卷,完成,Submit",

    // 站点覆盖（可选）
    nextSelector: "",
    submitSelector: "",

    // 页面加载等待
    resumeWaitMs: 2500,

    // AI 回答质量
    webSearch: false, // 是否允许联网搜索
    webSearchProvider: "auto", // auto | openai | openrouter
    reasoningEffort: "", // ""(默认) | minimal | low | medium | high
  };

  function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function splitList(value, fallback) {
    if (Array.isArray(value)) {
      const list = value.map((v) => String(v).trim()).filter(Boolean);
      return list.length ? list : fallback.slice();
    }
    if (typeof value === "string") {
      const list = value
        .split(/[,，\n]/)
        .map((v) => v.trim())
        .filter(Boolean);
      return list.length ? list : fallback.slice();
    }
    return fallback.slice();
  }

  function normalize(raw) {
    const input = raw && typeof raw === "object" ? raw : {};
    const merged = { ...DEFAULTS, ...input };

    const nextMode = ["auto", "paginate", "scroll"].includes(merged.nextMode)
      ? merged.nextMode
      : DEFAULTS.nextMode;

    const webSearchProvider = ["auto", "openai", "openrouter"].includes(
      merged.webSearchProvider
    )
      ? merged.webSearchProvider
      : DEFAULTS.webSearchProvider;

    const reasoningEffort = ["minimal", "low", "medium", "high"].includes(
      merged.reasoningEffort
    )
      ? merged.reasoningEffort
      : "";

    return {
      autoNext: Boolean(merged.autoNext),
      nextMode,
      questionDelay: clampInt(
        merged.questionDelay,
        0,
        10000,
        DEFAULTS.questionDelay
      ),
      pageDelay: clampInt(merged.pageDelay, 0, 60000, DEFAULTS.pageDelay),
      maxPages: clampInt(merged.maxPages, 1, 200, DEFAULTS.maxPages),
      maxRunMinutes: clampInt(
        merged.maxRunMinutes,
        1,
        180,
        DEFAULTS.maxRunMinutes
      ),
      requireAllAnswered: Boolean(merged.requireAllAnswered),
      skipOnError: Boolean(merged.skipOnError),
      maxRetries: clampInt(merged.maxRetries, 0, 5, DEFAULTS.maxRetries),
      nextText: splitList(merged.nextText, DEFAULTS.nextText.split(",")),
      submitText: splitList(merged.submitText, DEFAULTS.submitText.split(",")),
      nextSelector: String(merged.nextSelector || "").trim(),
      submitSelector: String(merged.submitSelector || "").trim(),
      resumeWaitMs: clampInt(
        merged.resumeWaitMs,
        0,
        15000,
        DEFAULTS.resumeWaitMs
      ),
      webSearch: Boolean(merged.webSearch),
      webSearchProvider,
      reasoningEffort,
      // 安全默认：永远不自动提交。保留字段是为了未来显式开启时也便于审计。
      autoSubmit: false,
    };
  }

  async function get() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      return normalize(data[STORAGE_KEY]);
    } catch (error) {
      console.warn("[QuizSettings] 读取设置失败，使用默认值:", error);
      return normalize(null);
    }
  }

  async function save(raw) {
    const settings = normalize(raw);
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    return settings;
  }

  window.QuizSettings = {
    STORAGE_KEY,
    DEFAULTS,
    normalize,
    get,
    save,
  };
})();
