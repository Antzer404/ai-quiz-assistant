// 修改自 rehuan/AI-ANSWER-ASSISTANT（GPL-3.0），修改日期：2026-10-26
// Background Service Worker (v2)
// - 只负责网络请求与会话状态，不包含任何内置模型或统计上报
// - 所有请求都带超时、重试和可诊断的错误信息

const SESSION_KEY = "runSessions";
const DEFAULT_TIMEOUT_MS = 60000;
const ANALYZE_TIMEOUT_MS = 120000;
const SESSION_FALLBACK_MS = 30 * 60 * 1000;

const sessionArea = chrome.storage.session || chrome.storage.local;

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const sessions = await readSessions();
    if (sessions[tabId]) {
      delete sessions[tabId];
      await writeSessions(sessions);
    }
  } catch (_) {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        success: false,
        error: error && error.message ? error.message : String(error),
      });
    });
  return true;
});

async function handleMessage(request, sender) {
  switch (request.action) {
    case "callAI":
      return {
        success: true,
        data: await callAI(request.config, request.prompt, "answer", request.options),
      };

    case "analyzeHTML":
      return {
        success: true,
        data: await callAI(request.config, request.prompt, "analyze", request.options),
      };

    case "testConnection":
      return await testConnection(request.config);

    case "sessionStart":
      return await startSession(request, sender);

    case "sessionGet":
      return await getSession(getTabId(request, sender));

    case "sessionUpdate":
      return await updateSession(getTabId(request, sender), request.patch || {});

    case "sessionStop":
      return await stopSession(getTabId(request, sender));

    case "sessionClear":
      return await clearSession(getTabId(request, sender));

    default:
      return { success: false, error: `未知操作: ${request.action}` };
  }
}

function getTabId(request, sender) {
  if (sender && sender.tab && sender.tab.id != null) return sender.tab.id;
  if (request && request.tabId != null) return request.tabId;
  return null;
}

// ---------------------------------------------------------------------------
// AI 请求
// ---------------------------------------------------------------------------

async function callAI(config, prompt, mode = "answer", options = {}) {
  const { baseUrl, apiKey, model } = config || {};
  if (!baseUrl || !apiKey || !model) {
    throw new Error("模型配置不完整，请填写 Base URL、API Key 和模型 ID");
  }

  const url = buildChatCompletionsUrl(baseUrl);
  const timeoutMs = clamp(
    options.timeoutMs ||
      (mode === "analyze" ? ANALYZE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
    5000,
    180000
  );
  const retries = clamp(
    options.retries == null ? 1 : options.retries,
    0,
    3
  );

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt(mode) },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    stream: false,
  };
  if (options.maxTokens) {
    body.max_tokens = clamp(options.maxTokens, 1, 4096);
  }

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const apiMessage = extractApiMessage(errorText);
        const status = response.status;

        console.error("[AI答题助手] API 请求失败:", {
          status,
          statusText: response.statusText,
          url,
          response: errorText.slice(0, 1000),
        });

        const suffix = apiMessage ? `：${apiMessage}` : "";
        let message;
        if (status === 401) message = "API Key 无效或已过期（401）";
        else if (status === 403) message = `API 访问被拒绝（403）${suffix}`;
        else if (status === 404)
          message = `API 地址不存在（404），请检查 Base URL 是否正确${suffix}`;
        else if (status === 429)
          message = `API 请求过于频繁（429）${suffix}`;
        else if (status >= 500)
          message = `API 服务暂时不可用（${status}）${suffix}`;
        else message = `API 请求失败（${status}）${suffix}`;

        const retryable =
          status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
        if (retryable && attempt < retries) {
          lastError = new Error(message);
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(message);
      }

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        throw new Error(
          `API 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`
        );
      }

      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null;

      if (typeof content !== "string" || !content.trim()) {
        throw new Error(
          `API 返回格式错误：缺少 choices[0].message.content（${JSON.stringify(
            data
          ).slice(0, 200)}）`
        );
      }

      return content;
    } catch (error) {
      clearTimeout(timer);

      if (error && error.name === "AbortError") {
        lastError = new Error(
          `API 请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络、代理或服务可用性`
        );
      } else if (error instanceof TypeError) {
        lastError = new Error(networkErrorMessage(error, url));
      } else {
        lastError = error;
      }

      if (attempt < retries && isRetryableError(error)) {
        await sleep(backoffMs(attempt));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error("API 请求失败");
}

function systemPrompt(mode) {
  if (mode === "analyze") {
    return `你是一个专业的网页结构分析助手。你需要分析HTML页面结构，识别其中的题目结构（单选题、多选题、填空题）。

【重要】这一步只需要识别题目结构，不需要给出答案！

分析要点：
1. 识别所有题目，提取完整的题干文本
2. 识别每道题的选项或输入框
3. 为每个可交互元素（选项、输入框）生成精确的CSS选择器
4. 不要分析答案，答案会在后续步骤单独获取

只返回JSON格式，不要有其他内容。确保JSON格式正确。`;
  }

  return `你是一个专业的答题助手。用户会给你题目，你需要分析题目并给出正确答案。

请严格按照以下JSON格式返回答案：
{
  "type": "single|multiple|fill",
  "answer": "答案内容",
  "explanation": "简短解释"
}

对于不同题型的答案格式：
- 单选题(single): answer为选项字母，如 "A" 或 "B"
- 多选题(multiple): answer为选项字母数组，如 ["A", "B", "C"]
- 填空题(fill): answer为填空内容，如果有多个空，用数组表示 ["答案1", "答案2"]

注意：
1. 只返回JSON，不要有其他内容
2. 确保JSON格式正确
3. 答案要准确`;
}

function buildChatCompletionsUrl(baseUrl) {
  let raw = String(baseUrl || "").trim();
  if (!raw) throw new Error("Base URL 不能为空");
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(
      `Base URL 必须以 http:// 或 https:// 开头（当前：${raw.slice(0, 80)}）`
    );
  }

  raw = raw.replace(/\/+$/, "");
  if (raw.includes("?")) {
    throw new Error("Base URL 不能包含查询参数（?），请只填写到 /v1 这一级");
  }
  if (raw.endsWith("/chat/completions")) return raw;
  return `${raw}/chat/completions`;
}

function networkErrorMessage(error, url) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch (_) {
    /* ignore */
  }
  const cause = error && error.cause ? `；${error.cause}` : "";
  return `无法连接 API（${host}）：${error.message}${cause}。请检查 Base URL、网络/代理、证书和扩展站点权限`;
}

function extractApiMessage(text) {
  if (!text) return "";
  try {
    const json = JSON.parse(text);
    return (
      (json.error && (json.error.message || json.error)) ||
      json.message ||
      ""
    )
      .toString()
      .slice(0, 200);
  } catch (_) {
    return text
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
  }
}

function isRetryableError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  return error instanceof TypeError;
}

function backoffMs(attempt) {
  return Math.min(4000, 600 * Math.pow(2, attempt));
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testConnection(config) {
  const startedAt = Date.now();
  try {
    const content = await callAI(config, "请只回复 OK", "answer", {
      timeoutMs: 20000,
      retries: 0,
      maxTokens: 16,
    });
    return {
      success: true,
      latency: Date.now() - startedAt,
      sample: String(content).slice(0, 80),
    };
  } catch (error) {
    return {
      success: false,
      latency: Date.now() - startedAt,
      error: error.message,
    };
  }
}

// ---------------------------------------------------------------------------
// 运行会话（跨页面恢复）
// ---------------------------------------------------------------------------

async function readSessions() {
  const data = await sessionArea.get(SESSION_KEY);
  const sessions = data[SESSION_KEY] || {};
  const now = Date.now();
  let changed = false;

  Object.keys(sessions).forEach((tabId) => {
    const state = sessions[tabId];
    if (!state) {
      delete sessions[tabId];
      changed = true;
      return;
    }
    if (!state.running || state.stopRequested) {
      delete sessions[tabId];
      changed = true;
      return;
    }
    if (state.expiresAt && now > state.expiresAt) {
      delete sessions[tabId];
      changed = true;
    }
  });

  if (changed) await writeSessions(sessions);
  return sessions;
}

async function writeSessions(sessions) {
  await sessionArea.set({ [SESSION_KEY]: sessions });
}

async function startSession(request, sender) {
  const tabId = getTabId(request, sender);
  if (tabId == null) return { success: false, error: "无法获取标签页 ID" };

  if (!request.config || !request.config.baseUrl) {
    return { success: false, error: "模型配置不完整" };
  }

  const sessions = await readSessions();
  const now = Date.now();
  const settings = request.settings || {};
  const maxRunMinutes = Number(settings.maxRunMinutes) || 30;

  const state = {
    tabId,
    running: true,
    stopRequested: false,
    phase: "starting",
    page: 1,
    answeredTotal: Number(request.answeredTotal) || 0,
    questionsOnPage: 0,
    config: request.config,
    settings,
    startUrl: request.startUrl || (sender.tab && sender.tab.url) || "",
    origin: request.origin || "",
    startedAt: now,
    updatedAt: now,
    expiresAt: now + maxRunMinutes * 60 * 1000,
  };

  sessions[tabId] = state;
  await writeSessions(sessions);
  return { success: true, state };
}

async function getSession(tabId) {
  if (tabId == null) return { success: false, error: "无法获取标签页 ID" };
  const sessions = await readSessions();
  return { success: true, state: sessions[tabId] || null };
}

async function updateSession(tabId, patch) {
  if (tabId == null) return { success: false, error: "无法获取标签页 ID" };
  const sessions = await readSessions();
  const state = sessions[tabId];
  if (!state) return { success: true, state: null };

  const allowed = [
    "phase",
    "page",
    "answeredTotal",
    "questionsOnPage",
    "lastUrl",
  ];
  allowed.forEach((key) => {
    if (patch[key] !== undefined) state[key] = patch[key];
  });

  state.updatedAt = Date.now();
  const maxRunMinutes = Number(state.settings && state.settings.maxRunMinutes) || 30;
  state.expiresAt = Math.min(
    state.startedAt + maxRunMinutes * 60 * 1000,
    Date.now() + SESSION_FALLBACK_MS
  );

  sessions[tabId] = state;
  await writeSessions(sessions);
  return { success: true, state };
}

async function stopSession(tabId) {
  if (tabId == null) return { success: false, error: "无法获取标签页 ID" };
  const sessions = await readSessions();
  const state = sessions[tabId];
  if (state) {
    state.stopRequested = true;
    state.running = false;
    state.phase = "stopped";
    state.updatedAt = Date.now();
    sessions[tabId] = state;
    await writeSessions(sessions);
  }
  return { success: true };
}

async function clearSession(tabId) {
  if (tabId == null) return { success: false, error: "无法获取标签页 ID" };
  const sessions = await readSessions();
  if (sessions[tabId]) {
    delete sessions[tabId];
    await writeSessions(sessions);
  }
  return { success: true };
}
