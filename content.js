// 修改自 rehuan/AI-ANSWER-ASSISTANT（GPL-3.0），修改日期：2026-10-26
// Content Script - 题目识别和自动答题

(function () {
  "use strict";

  // 防止程序化注入时重复初始化（重复监听、重复自动恢复）
  if (window.__aiQuizAssistantLoaded) {
    console.log("[AI答题助手] 已加载，跳过重复初始化");
    return;
  }
  window.__aiQuizAssistantLoaded = true;

  // State
  let questions = [];
  let answeredCount = 0;
  let totalAnswered = 0;
  let isRunning = false;
  let runFinished = false;
  let config = null;
  let settings = window.QuizSettings
    ? window.QuizSettings.normalize()
    : {
        autoNext: true,
        nextMode: "auto",
        questionDelay: 800,
        pageDelay: 2000,
        maxPages: 50,
        maxRunMinutes: 30,
        requireAllAnswered: true,
        skipOnError: true,
        maxRetries: 1,
        nextText: ["下一题", "下一页", "继续", "下一步", "Next", "Continue"],
        submitText: ["提交", "交卷", "完成", "Submit"],
        nextSelector: "",
        submitSelector: "",
        resumeWaitMs: 2500,
        autoSubmit: false,
      };
  let sessionState = null;
  let lastPage = 1;

  // Question selectors for common exam platforms
  const QUESTION_SELECTORS = [
    // 通用选择器
    ".question",
    ".question-item",
    ".exam-question",
    ".test-question",
    ".quiz-question",
    '[class*="question"]',
    '[class*="Question"]',
    // 题目容器
    ".problem",
    ".problem-item",
    ".exercise",
    ".exercise-item",
    // 表单题目
    "form .item",
    "form .form-item",
    // 列表题目
    ".question-list > li",
    ".question-list > div",
    "ol.questions > li",
    "ul.questions > li",
  ];

  // Option selectors
  const OPTION_SELECTORS = [
    'input[type="radio"]',
    'input[type="checkbox"]',
    ".option",
    ".choice",
    ".answer-option",
    '[class*="option"]',
    '[class*="choice"]',
    "label",
  ];

  // Fill-in-the-blank selectors
  const FILL_SELECTORS = [
    'input[type="text"]',
    "input:not([type])",
    "textarea",
    ".blank",
    ".fill-blank",
    '[class*="blank"]',
    '[contenteditable="true"]',
  ];

  // AI分析得到的选择器缓存
  let aiDetectedSelectors = null;

  // Message listener
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case "scan":
        config = message.config || null;
        settings = normalizeSettings(message.settings);
        handleScan(sendResponse);
        return true; // 保持消息通道开放用于异步响应

      case "start":
        config = message.config || null;
        settings = normalizeSettings(message.settings);
        if (!config) {
          sendResponse({ success: false, error: "请先配置模型" });
          return true;
        }
        if (isRunning) {
          sendResponse({ success: true, alreadyRunning: true });
          return true;
        }
        startAnswering();
        sendResponse({ success: true });
        return true;

      case "stop":
        stopAnswering();
        sendResponse({ success: true });
        return true;

      case "getStatus":
        sendResponse({
          questionCount: questions.length,
          answeredCount: totalAnswered,
          pageAnsweredCount: answeredCount,
          isRunning,
          page: sessionState ? sessionState.page : lastPage,
        });
        break;
    }
    return true;
  });

  function normalizeSettings(raw) {
    return window.QuizSettings
      ? window.QuizSettings.normalize(raw)
      : raw || settings;
  }

  // 处理扫描请求（手动扫描）
  async function handleScan(sendResponse) {
    if (isRunning) {
      sendResponse({
        success: false,
        count: 0,
        message: "答题进行中，请先停止再重新扫描",
      });
      return;
    }

    totalAnswered = 0;
    sessionState = null;
    lastPage = 1;

    try {
      const count = await performScan();
      if (count > 0) {
        sendResponse({ success: true, count, message: "" });
      } else {
        sendResponse({ success: false, count: 0, message: "未发现题目" });
      }
    } catch (error) {
      sendLog("error", `扫描失败: ${error.message}`);
      sendResponse({ success: false, count: 0, message: error.message });
    }
  }

  // 扫描当前页面：模板优先，失败后回退到 AI
  async function performScan() {
    questions = [];
    answeredCount = 0;
    updateStats();

    sendLog("info", "正在匹配站点模板...");

    let template = null;
    try {
      template = window.siteMatcher
        ? window.siteMatcher.matchTemplate(window.location.href)
        : null;
    } catch (error) {
      console.warn("[AI答题助手] 模板匹配失败:", error);
    }

    if (template) {
      sendLog("info", `已匹配到站点模板: ${template.siteName}`);
      try {
        const scanner = new window.EnhancedScanner();
        const result = scanner.scanWithTemplate(template);

        if (result.success && result.count > 0) {
          questions = result.questions;
          updateStats();
          sendLog("success", `使用模板扫描成功，发现 ${result.count} 道题目`);
          return result.count;
        }
        sendLog("warning", "模板扫描失败，回退到AI分析...");
      } catch (error) {
        sendLog("error", `模板扫描出错: ${error.message}，回退到AI分析`);
      }
    } else {
      sendLog("info", "未找到匹配的站点模板，使用AI分析...");
    }

    if (!config || !config.baseUrl || !config.apiKey || !config.model) {
      sendLog("warning", "未配置 AI 模型，无法进行 AI 分析");
      updateStats();
      return 0;
    }

    sendLog("info", "正在使用AI分析页面结构，请耐心等待...");
    try {
      const aiResult = await analyzePageWithAI();
      if (aiResult && aiResult.success) {
        aiDetectedSelectors = aiResult.selectors;
        const count = scanWithAISelectors(aiResult);
        if (count > 0) {
          updateStats();
          sendLog("success", `AI分析成功，发现 ${count} 道题目`);
          return count;
        }
        sendLog("warning", "AI分析完成，但未能定位到题目元素");
      } else {
        sendLog("warning", "AI分析未发现题目");
      }
    } catch (error) {
      sendLog("error", `AI分析失败: ${error.message}`);
    }

    updateStats();
    return 0;
  }

  // Scan for questions on the page
  function scanQuestions() {
    questions = [];
    answeredCount = 0;

    // Try each selector
    for (const selector of QUESTION_SELECTORS) {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach((el, index) => {
            const question = parseQuestion(el, index);
            if (question) {
              questions.push(question);
            }
          });
          if (questions.length > 0) break;
        }
      } catch (e) {
        console.log("Selector error:", selector, e);
      }
    }

    // If no questions found with selectors, try heuristic detection
    if (questions.length === 0) {
      questions = detectQuestionsHeuristically();
    }

    // Remove duplicates
    questions = removeDuplicates(questions);

    sendLog("info", `扫描完成，发现 ${questions.length} 道题目`);
    updateStats();

    return questions.length;
  }

  // Parse a question element
  function parseQuestion(element, index) {
    const question = {
      index,
      element,
      type: null,
      text: "",
      options: [],
      inputs: [],
      answered: false,
    };

    // Get question text
    const textElements = element.querySelectorAll(
      "p, span, div, h1, h2, h3, h4, h5, h6"
    );
    let questionText = "";

    // Try to find the main question text
    const titleEl = element.querySelector(
      '.title, .question-title, .question-text, .stem, [class*="title"], [class*="stem"]'
    );
    if (titleEl) {
      questionText = titleEl.textContent.trim();
    } else {
      // Get first meaningful text
      for (const el of textElements) {
        const text = el.textContent.trim();
        if (text.length > 10 && !text.match(/^[A-D][\.\、\s]/)) {
          questionText = text;
          break;
        }
      }
    }

    if (!questionText) {
      questionText = element.textContent.trim().substring(0, 500);
    }

    question.text = cleanText(questionText);

    // Detect question type and get options/inputs
    const radios = element.querySelectorAll('input[type="radio"]');
    const checkboxes = element.querySelectorAll('input[type="checkbox"]');
    const textInputs = element.querySelectorAll(
      'input[type="text"], input:not([type]), textarea'
    );

    if (radios.length > 0) {
      question.type = "single";
      question.options = parseOptions(element, radios);
    } else if (checkboxes.length > 0) {
      question.type = "multiple";
      question.options = parseOptions(element, checkboxes);
    } else if (textInputs.length > 0) {
      question.type = "fill";
      question.inputs = Array.from(textInputs);
    } else {
      // Try to detect from text
      if (
        question.text.includes("多选") ||
        question.text.includes("多项选择")
      ) {
        question.type = "multiple";
      } else if (
        question.text.includes("单选") ||
        question.text.includes("单项选择")
      ) {
        question.type = "single";
      } else if (
        question.text.includes("填空") ||
        question.text.includes("____") ||
        question.text.includes("___")
      ) {
        question.type = "fill";
      }

      // Try to find clickable options
      const optionEls = element.querySelectorAll(
        '.option, .choice, [class*="option"], [class*="choice"], li'
      );
      if (optionEls.length >= 2 && optionEls.length <= 8) {
        question.type = question.type || "single";
        question.options = Array.from(optionEls).map((el, i) => ({
          element: el,
          label: String.fromCharCode(65 + i),
          text: el.textContent.trim(),
        }));
      }
    }

    // Skip if no valid type detected
    if (!question.type) {
      return null;
    }

    return question;
  }

  // Parse options from input elements
  function parseOptions(container, inputs) {
    const options = [];

    inputs.forEach((input, index) => {
      const label =
        input.closest("label") ||
        container.querySelector(`label[for="${input.id}"]`) ||
        input.parentElement;

      let optionText = "";
      let optionLabel = String.fromCharCode(65 + index);

      if (label) {
        optionText = label.textContent.trim();
        // Extract label letter if present
        const match = optionText.match(/^([A-Z])[\.\、\s]/);
        if (match) {
          optionLabel = match[1];
          optionText = optionText.substring(match[0].length).trim();
        }
      }

      options.push({
        element: input,
        label: optionLabel,
        text: optionText,
      });
    });

    return options;
  }

  // Heuristic question detection
  function detectQuestionsHeuristically() {
    const detected = [];
    const allElements = document.body.querySelectorAll("*");

    // Look for numbered items that might be questions
    const numberPattern = /^[\d一二三四五六七八九十]+[\.\、\s]/;

    allElements.forEach((el, index) => {
      const text = el.textContent.trim();
      if (text.length > 20 && text.length < 2000 && numberPattern.test(text)) {
        // Check if it has options or inputs
        const hasOptions =
          el.querySelectorAll('input[type="radio"], input[type="checkbox"]')
            .length > 0;
        const hasInputs =
          el.querySelectorAll('input[type="text"], textarea').length > 0;

        if (hasOptions || hasInputs) {
          const question = parseQuestion(el, detected.length);
          if (question) {
            detected.push(question);
          }
        }
      }
    });

    return detected;
  }

  // 统一的DOM精简逻辑，去掉无关属性
  function simplifyElementAttributes(el) {
    const keepAttrs = [
      "class",
      "id",
      "type",
      "name",
      "value",
      "placeholder",
      "for",
      "data-index",
      "data-id",
    ];
    const attrs = Array.from(el.attributes || []);
    attrs.forEach((attr) => {
      if (!keepAttrs.includes(attr.name) && !attr.name.startsWith("data-")) {
        el.removeAttribute(attr.name);
      }
    });
    Array.from(el.children).forEach((child) =>
      simplifyElementAttributes(child)
    );
  }

  // 获取简化的页面HTML用于AI分析（作为候选块不足时的兜底）
  function getSimplifiedHTML() {
    const clone = document.body.cloneNode(true);
    const removeSelectors = [
      "script",
      "style",
      "noscript",
      "iframe",
      "svg",
      "img",
      "video",
      "audio",
      "canvas",
    ];
    removeSelectors.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    simplifyElementAttributes(clone);

    let html = clone.innerHTML;
    html = html.replace(/\s+/g, " ").replace(/>\s+</g, "><");

    if (html.length > 30000) {
      const mainSelectors = [
        "main",
        "article",
        ".content",
        ".main",
        "#content",
        "#main",
        ".container",
        ".wrapper",
      ];
      for (const sel of mainSelectors) {
        const main = clone.querySelector(sel);
        if (main && main.innerHTML.length > 500) {
          html = main.innerHTML.replace(/\s+/g, " ").replace(/>\s+</g, "><");
          break;
        }
      }
    }

    if (html.length > 30000) {
      html = html.substring(0, 30000) + "... [内容已截断]";
    }

    return html;
  }

  // 构建单个题目块的精简HTML字符串
  function buildSimplifiedBlockHTML(element, maxLength = 1500) {
    const clone = element.cloneNode(true);
    simplifyElementAttributes(clone);
    let html = clone.outerHTML || "";
    html = html.replace(/\s+/g, " ").replace(/>\s+</g, "><");
    if (html.length > maxLength) {
      html = html.substring(0, maxLength) + "... [片段截断]";
    }
    return html;
  }

  // 根据页面内容尝试提取候选题目块，显著减少发送给AI的数据量
  function getCandidateQuestionBlocks(maxBlocks = 40) {
    const candidateSet = new Set();

    function addCandidate(el) {
      if (!el || candidateSet.has(el)) return;
      candidateSet.add(el);
    }

    const optionInputs = document.querySelectorAll(
      'input[type="radio"], input[type="checkbox"]'
    );
    optionInputs.forEach((input) => {
      const container = findQuestionContainer(input.closest("label") || input);
      if (container) addCandidate(container);
    });

    const fillInputs = document.querySelectorAll(
      'input[type="text"], input[type="number"], textarea'
    );
    fillInputs.forEach((input) => {
      const container = findQuestionContainer(input.closest("label") || input);
      if (container) addCandidate(container);
    });

    if (candidateSet.size < 5) {
      const extraSelectors = [
        ".question",
        ".exam-question",
        ".topic",
        ".subject",
        ".problem",
      ];
      extraSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => addCandidate(el));
      });
    }

    const candidates = Array.from(candidateSet).slice(0, maxBlocks);
    return candidates
      .map((el) => {
        const text = cleanText(el.textContent || "").substring(0, 400);
        return {
          text,
          html: buildSimplifiedBlockHTML(el),
        };
      })
      .filter((block) => block.text);
  }

  // 构建AI分析所需的内容，如果候选块为空则回退到整页HTML
  function buildAIAnalysisPayload() {
    const blocks = getCandidateQuestionBlocks();
    if (blocks.length > 0) {
      const formatted = blocks
        .map((block, index) => {
          return `【题目块${index + 1}】\n文本：${block.text}\nHTML：${
            block.html
          }`;
        })
        .join("\n\n");

      return {
        payload: `以下是筛选后的疑似题目区域（共${blocks.length}块）：\n${formatted}`,
        source: "candidateBlocks",
      };
    }

    return {
      payload: getSimplifiedHTML(),
      source: "fullHTML",
    };
  }

  // 使用AI分析页面结构（只识别题目，不返回答案）
  async function analyzePageWithAI() {
    const { payload, source } = buildAIAnalysisPayload();
    const contentIntro =
      source === "candidateBlocks"
        ? "本次提供的是经过前端筛选的疑似题目块，请基于这些块识别题目结构。"
        : "未找到足够的候选题目块，以下为整页精简HTML。";

    const prompt = `分析以下HTML页面，识别所有题目的结构。

【重要】只需要识别题目结构，不需要给出答案！

请返回JSON格式：
{
  "success": true,
  "questions": [
    {
      "index": 0,
      "type": "single",
      "text": "题目文本内容（完整的题干）",
      "options": [
        {
          "label": "A",
          "text": "选项内容",
          "selector": "精确的CSS选择器"
        }
      ]
    },
    {
      "index": 1,
      "type": "multiple",
      "text": "多选题文本",
      "options": [
        {
          "label": "A",
          "text": "选项内容",
          "selector": "CSS选择器"
        }
      ]
    },
    {
      "index": 2,
      "type": "fill",
      "text": "填空题文本",
      "inputs": [
        { "selector": "第1个输入框的CSS选择器" },
        { "selector": "第2个输入框的CSS选择器" }
      ]
    }
  ]
}

重要说明：
1. type: "single"单选题, "multiple"多选题, "fill"填空题
2. text: 必须包含完整的题干内容，后续需要用这个文本去获取答案
3. selector: 必须是可以直接用document.querySelector()定位到的精确CSS选择器
   - 优先使用id选择器: #elementId
   - 或使用class+nth-child: .option-item:nth-child(2)
   - 或使用属性选择器: input[value="B"], input[name="q1"][value="2"]
   - 对于radio/checkbox，选择器应指向input元素本身
   - 对于可点击的div/label，选择器应指向该可点击元素
4. 仔细分析HTML结构，确保选择器准确无误
5. 【不要返回答案】这一步只需要识别题目结构

${contentIntro}

HTML内容：
${payload}`;

    const response = await bgSend({ action: "analyzeHTML", config, prompt });
    if (!response.success) {
      throw new Error(response.error || "AI 分析请求失败");
    }

    try {
      return parseAIResponse(response.data);
    } catch (error) {
      throw new Error(`解析AI响应失败: ${error.message}`);
    }
  }

  // 使用AI分析结果创建题目列表（不含答案，答案在答题阶段逐题获取）
  function scanWithAISelectors(aiResult) {
    questions = [];
    answeredCount = 0;

    if (!aiResult.questions || aiResult.questions.length === 0) {
      return 0;
    }

    // 使用AI返回的题目结构数据（不含答案）
    aiResult.questions.forEach((q, index) => {
      const question = {
        index,
        type: q.type || "single",
        text: q.text || "",
        answer: null, // 答案在答题阶段获取
        explanation: null,
        options: [],
        inputs: [],
        answered: false,
      };

      // 处理选项（单选/多选题）
      if (q.options && q.options.length > 0) {
        question.options = q.options.map((opt) => ({
          label: opt.label,
          text: opt.text,
          selector: opt.selector,
          element: opt.selector ? safeQuerySelector(opt.selector) : null,
        }));
      }

      // 处理填空题输入框
      if (q.type === "fill" && q.inputs && q.inputs.length > 0) {
        question.inputs = q.inputs.map((inp) => ({
          selector: inp.selector,
          element: inp.selector ? safeQuerySelector(inp.selector) : null,
        }));
      }

      questions.push(question);
      console.log(
        `[AI答题助手] 题目${index + 1}:`,
        question.text.substring(0, 50)
      );
    });

    updateStats();
    return questions.length;
  }

  // 安全的querySelector，捕获无效选择器错误
  function safeQuerySelector(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (e) {
      console.warn("[AI答题助手] 无效的选择器:", selector, e);
      return null;
    }
  }

  // Remove duplicate questions
  function removeDuplicates(questions) {
    const seen = new Set();
    return questions.filter((q) => {
      const key = q.text.substring(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Clean text
  function cleanText(text) {
    return text
      .replace(/\s+/g, " ")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .substring(0, 1000);
  }

  // Start answering questions
  // -------------------------------------------------------------------------
  // 答题会话：当前页答题 -> 自动下一题 -> 重新扫描 -> 继续
  // -------------------------------------------------------------------------

  async function startAnswering() {
    if (isRunning) return;
    if (!config) {
      sendLog("error", "请先配置模型");
      return;
    }

    isRunning = true;
    runFinished = false;
    totalAnswered = 0;
    answeredCount = 0;
    sessionState = null;
    lastPage = 1;

    // 允许在同一页面重新开始：重置本页的已答标记
    questions.forEach((question) => {
      question.answered = false;
    });
    updateStats();

    sendLog("info", "🚀 开始自动答题");

    const res = await bgSend({
      action: "sessionStart",
      config,
      settings,
      startUrl: location.href,
      origin: location.origin,
      answeredTotal: 0,
    });

    if (res && res.success && res.state) {
      sessionState = res.state;
    } else {
      sendLog(
        "warning",
        `会话状态保存失败，本次仍可继续，但跨页恢复可能不可用${
          res && res.error ? `：${res.error}` : ""
        }`
      );
    }

    try {
      await runSession({ resumed: false });
    } catch (error) {
      sendLog("error", `运行出错: ${error.message}`);
      await finishRun({ stopped: true, reason: error.message });
    }
  }

  async function runSession({ resumed }) {
    const startedAt =
      (sessionState && sessionState.startedAt) || Date.now();
    const maxRunMs = Math.max(1, settings.maxRunMinutes) * 60 * 1000;
    let reason = "";
    let stopped = !isRunning;

    try {
      while (isRunning) {
        if (Date.now() - startedAt > maxRunMs) {
          reason = "已达到最大运行时间，自动停止";
          break;
        }

        if (
          window.QuizNavigation &&
          window.QuizNavigation.detectChallenge()
        ) {
          reason = "检测到验证码/人机验证，已停止";
          break;
        }

        if (questions.length === 0) {
          const count = await performScan();
          if (count === 0) {
            reason = "未发现题目，已停止";
            break;
          }
        }

        await answerCurrentPage();

        if (!isRunning) {
          reason = "已手动停止";
          break;
        }

        const unanswered = questions.filter((q) => !q.answered).length;
        if (settings.requireAllAnswered && unanswered > 0) {
          reason = `还有 ${unanswered} 题未完成，已停止自动翻页`;
          break;
        }

        if (!settings.autoNext) {
          reason = "自动下一题已关闭";
          break;
        }

        if (settings.nextMode === "scroll") {
          reason = "同页滚动模式已完成当前页";
          break;
        }

        const nextPage = (Number(sessionState && sessionState.page) || 1) + 1;
        const advanced = await tryAdvance(nextPage);
        if (!advanced) {
          reason = "没有可用的下一题/下一页，任务结束";
          break;
        }

        sendLog("info", `等待第 ${nextPage} 页加载...`);
        await sleep(withJitter(settings.pageDelay));

        if (!isRunning) {
          reason = "已手动停止";
          break;
        }

        questions = [];
        answeredCount = 0;
        updateStats();

        const count = await performScan();
        if (count === 0) {
          reason = "翻页后未发现题目，已停止";
          break;
        }
      }
    } catch (error) {
      reason = `运行出错: ${error.message}`;
      stopped = true;
      sendLog("error", reason);
    } finally {
      await finishRun({ stopped: stopped || !isRunning, reason });
    }
  }

  async function answerCurrentPage() {
    const pending = questions.filter((q) => !q.answered);
    if (pending.length === 0) return;

    sendLog(
      "info",
      `当前页共 ${questions.length} 题，待答 ${pending.length} 题`
    );

    for (const question of pending) {
      if (!isRunning) break;

      if (
        window.QuizNavigation &&
        window.QuizNavigation.detectChallenge()
      ) {
        sendLog("warning", "检测到验证码/人机验证，暂停答题");
        break;
      }

      const displayIndex = questions.indexOf(question) + 1;
      const firstElement = findFirstValidElement(question);

      if (firstElement) {
        scrollToElement(firstElement);
        await sleep(200);
        const container = findQuestionContainer(firstElement);
        if (container) highlightElement(container);
      }

      sendLog(
        "info",
        `正在获取第 ${displayIndex}/${questions.length} 题的答案...`
      );

      let answer = null;
      let lastError = null;

      for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
        if (!isRunning) break;
        try {
          const hint =
            attempt > 0
              ? "上一次返回的答案无法匹配题目选项。请只返回有效选项字母，并严格输出 JSON。"
              : "";
          const raw = await getAIAnswerForQuestion(question, hint);
          if (!isRunning) break;
          answer = normalizeAnswerForQuestion(question, raw);
          if (answer) break;
          lastError = new Error("AI 返回的答案格式无效");
        } catch (error) {
          lastError = error;
        }

        if (attempt < settings.maxRetries) {
          sendLog(
            "warning",
            `第 ${displayIndex} 题获取答案失败，重试 ${attempt + 1}/${
              settings.maxRetries
            }：${lastError ? lastError.message : "未知错误"}`
          );
          await sleep(800 * (attempt + 1));
        }
      }

      // 用户在 AI 请求期间点击了停止：不要继续应用答案
      if (!isRunning) break;

      if (answer) {
        question.answer = answer.answer;
        question.explanation = answer.explanation || "";
        try {
          await applyAnswerDirectly(question);
          question.answered = true;
          answeredCount += 1;
          totalAnswered += 1;
          updateStats();
          await updateSession({
            phase: "answering",
            answeredTotal: totalAnswered,
            lastUrl: location.href,
          });
          sendLog(
            "success",
            `第 ${displayIndex} 题已完成，答案: ${JSON.stringify(
              question.answer
            )}`
          );
        } catch (error) {
          lastError = error;
          sendLog(
            "error",
            `第 ${displayIndex} 题填写失败: ${error.message}`
          );
        }
      }

      if (!question.answered) {
        sendLog(
          "warning",
          `第 ${displayIndex} 题未能完成${
            lastError ? `：${lastError.message}` : ""
          }`
        );
        if (!settings.skipOnError) {
          sendLog("error", "按设置停止答题");
          isRunning = false;
        }
      }

      if (firstElement) {
        const container = findQuestionContainer(firstElement);
        if (container) {
          removeHighlight(container);
          markAsCompleted(container);
        }
      }

      if (!isRunning) break;
      await sleep(withJitter(settings.questionDelay));
    }
  }

  async function tryAdvance(nextPage) {
    if (!window.QuizNavigation) return false;

    const control = window.QuizNavigation.findNextControl(document, settings);
    if (!control || !control.element) {
      sendLog("info", "未找到“下一题/下一页”按钮");
      return false;
    }

    const text = control.text || "";
    const submitKeywords = settings.submitText || [];
    const looksLikeSubmit =
      control.type === "submit" ||
      submitKeywords.some((keyword) =>
        String(text).toLowerCase().includes(String(keyword).toLowerCase())
      );

    if (looksLikeSubmit) {
      sendLog(
        "info",
        `已到最后一页（检测到“${text || "提交"}”按钮），按设置不自动提交。请检查后手动提交。`
      );
      return false;
    }

    if (nextPage > Number(settings.maxPages)) {
      sendLog("info", `已达到最大页数（${settings.maxPages}），已停止`);
      return false;
    }

    // 在点击前保存页码：整页刷新的站点上，旧页面会在点击后立即销毁
    lastPage = nextPage;
    if (sessionState) sessionState.page = nextPage;

    const previousSignature = window.QuizNavigation.getPageSignature();
    await updateSession({
      phase: "navigating",
      page: nextPage,
      lastUrl: location.href,
    });
    sendLog("info", `点击“${text || "下一题"}”翻页...`);

    // 先使用原生 click，兼容大多数站点
    try {
      control.element.click();
    } catch (_) {
      await clickElement(control.element);
    }

    let changed = await window.QuizNavigation.waitForChange(
      previousSignature,
      Math.max(8000, settings.pageDelay + 5000),
      200
    );

    // 某些站点只监听 mousedown/mouseup
    if (!changed && isRunning) {
      await clickElement(control.element);
      changed = await window.QuizNavigation.waitForChange(
        previousSignature,
        Math.max(5000, settings.pageDelay + 3000),
        200
      );
    }

    if (!changed) {
      sendLog(
        "warning",
        "点击后页面没有变化。可能是按钮选择错误、页面被拦截，或需要手动处理。"
      );
    }

    return changed;
  }

  async function finishRun({ stopped, reason }) {
    if (runFinished) return;
    runFinished = true;

    isRunning = false;
    if (reason) sendLog(stopped ? "warning" : "info", reason);

    try {
      await bgSend({ action: "sessionClear" });
    } catch (_) {
      /* ignore */
    }

    sessionState = null;
    updateStats();
    sendComplete(Boolean(stopped));
  }

  // 页面加载后自动恢复未完成的会话（分页整页刷新时使用）
  async function resumeRunIfNeeded() {
    const res = await bgSend({ action: "sessionGet" });
    const state = res && res.state;

    if (!state || !state.running || state.stopRequested) return;
    if (state.expiresAt && Date.now() > state.expiresAt) {
      await bgSend({ action: "sessionClear" });
      return;
    }
    if (!state.config || !state.config.baseUrl) return;

    if (state.origin && state.origin !== location.origin) {
      sendLog("warning", "页面已跳转到其他站点，停止自动恢复");
      await bgSend({ action: "sessionClear" });
      return;
    }

    config = state.config;
    settings = normalizeSettings(state.settings);
    sessionState = state;
    totalAnswered = Number(state.answeredTotal) || 0;
    lastPage = Number(state.page) || 1;
    isRunning = true;
    runFinished = false;

    sendLog(
      "info",
      `检测到未完成的答题任务（第 ${state.page || 1} 页），等待页面加载后继续...`
    );

    await waitForQuestionDOM(Math.max(500, settings.resumeWaitMs));
    if (!isRunning) return;

    if (
      window.QuizNavigation &&
      window.QuizNavigation.detectChallenge()
    ) {
      sendLog("warning", "检测到验证码/人机验证，停止自动恢复");
      isRunning = false;
      await finishRun({ stopped: true, reason: "需要人工完成验证" });
      return;
    }

    await runSession({ resumed: true });
  }

  async function waitForQuestionDOM(timeoutMs) {
    const startedAt = Date.now();
    const selector =
      'input, textarea, select, [contenteditable="true"], [class*="question"], [class*="topic"]';
    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (document.querySelector(selector)) return true;
      } catch (_) {
        /* ignore */
      }
      await sleep(200);
    }
    return false;
  }

  function normalizeAnswerForQuestion(question, answer) {
    if (!answer || answer.answer === undefined || answer.answer === null) {
      return null;
    }

    if (question.type === "single") {
      const options = question.options || [];
      const raw = String(answer.answer).trim();
      const letterMatch = raw.match(/[A-Za-z]/);
      if (letterMatch) {
        const letter = letterMatch[0].toUpperCase();
        if (
          options.length === 0 ||
          options.some(
            (opt) => String(opt.label).toUpperCase() === letter
          )
        ) {
          return { ...answer, answer: letter };
        }
      }
      const matched = options.find(
        (opt) =>
          cleanText(opt.text || "").toLowerCase() === raw.toLowerCase()
      );
      if (matched) {
        return { ...answer, answer: String(matched.label).toUpperCase() };
      }
      return null;
    }

    if (question.type === "multiple") {
      const options = question.options || [];
      const raw = answer.answer;
      const items = Array.isArray(raw)
        ? raw.map((item) => String(item).trim()).filter(Boolean)
        : String(raw)
            .split(/[,，、;；\n]+/)
            .map((item) => item.trim())
            .filter(Boolean);

      let letters = [];

      for (const item of items) {
        // "B", "B. 选项内容", "B、选项内容"
        const prefixed = item.match(/^([A-Za-z])(?=[.、:：)\s]|$)/);
        if (prefixed) {
          letters.push(prefixed[1].toUpperCase());
          continue;
        }
        if (/^[A-Za-z]$/.test(item)) {
          letters.push(item.toUpperCase());
          continue;
        }
        // 模型直接返回选项文本
        const matched = options.find(
          (opt) =>
            cleanText(opt.text || "").toLowerCase() === item.toLowerCase()
        );
        if (matched) {
          letters.push(String(matched.label).toUpperCase());
        }
      }

      // 兜底："AC" 这种没有分隔符的字母串
      if (letters.length === 0 && typeof raw === "string") {
        letters = (raw.match(/[A-Za-z]/g) || []).map((item) =>
          item.toUpperCase()
        );
      }

      letters = Array.from(new Set(letters)).filter((letter) => {
        if (options.length === 0) return /^[A-Z]$/.test(letter);
        return options.some(
          (opt) => String(opt.label).toUpperCase() === letter
        );
      });

      if (letters.length === 0) return null;
      return { ...answer, answer: letters };
    }

    if (question.type === "fill") {
      let values = Array.isArray(answer.answer)
        ? answer.answer
        : [answer.answer];

      // 多个空但模型只返回了一个用分号分隔的字符串
      if (
        values.length === 1 &&
        question.inputs &&
        question.inputs.length > 1 &&
        typeof values[0] === "string"
      ) {
        const parts = values[0]
          .split(/[；;\n]+/)
          .map((value) => value.trim())
          .filter(Boolean);
        if (parts.length > 1) values = parts;
      }

      const cleaned = values
        .map((value) =>
          String(value === undefined || value === null ? "" : value).trim()
        )
        .filter(Boolean);
      if (cleaned.length === 0) return null;
      return { ...answer, answer: cleaned };
    }

    return answer;
  }

  function withJitter(ms) {
    const base = Math.max(0, Number(ms) || 0);
    return base + Math.floor(Math.random() * Math.min(300, base * 0.3 + 1));
  }

  function bgSend(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              success: false,
              error: chrome.runtime.lastError.message,
            });
          } else {
            resolve(response || { success: false, error: "无响应" });
          }
        });
      } catch (error) {
        resolve({ success: false, error: error.message });
      }
    });
  }

  async function updateSession(patch) {
    if (sessionState) {
      sessionState = { ...sessionState, ...patch };
    }
    await bgSend({ action: "sessionUpdate", patch });
  }

  // 找到题目中第一个有效的元素用于定位
  function findFirstValidElement(question) {
    if (question.options && question.options.length > 0) {
      for (const opt of question.options) {
        if (opt.element) return opt.element;
        // 尝试重新查询
        if (opt.selector) {
          const el = safeQuerySelector(opt.selector);
          if (el) return el;
        }
      }
    }
    if (question.inputs && question.inputs.length > 0) {
      for (const inp of question.inputs) {
        if (inp.element) return inp.element;
        if (inp.selector) {
          const el = safeQuerySelector(inp.selector);
          if (el) return el;
        }
      }
    }
    return null;
  }

  // 根据选项元素向上查找题目容器（精确定位到单道题）
  function findQuestionContainer(element) {
    if (!element) return null;

    // 优先使用腾讯问卷的精确容器选择器
    const tencentContainer = element.closest(
      "section.question[data-question-id]"
    );
    if (tencentContainer) {
      return tencentContainer;
    }

    // 先找到这个选项所属的所有同级选项（同一道题的选项）
    const elementInput =
      element.tagName === "INPUT" ? element : element.querySelector("input");
    const inputName = elementInput?.name;

    let current = element.parentElement;
    let bestContainer = null;
    let depth = 0;
    const maxDepth = 4; // 限制层数，只找最近的容器

    while (current && current !== document.body && depth < maxDepth) {
      // 检查当前容器内有多少组选项（通过不同的 name 判断）
      const allInputs = current.querySelectorAll(
        'input[type="radio"], input[type="checkbox"]'
      );
      const names = new Set();
      allInputs.forEach((inp) => {
        if (inp.name) names.add(inp.name);
      });

      // 如果这个容器只包含一道题的选项（1个name），就是我们要的
      if (names.size === 1 && allInputs.length >= 2) {
        bestContainer = current;
        // 继续向上找一层，看看父元素是否也只包含这一道题
        // 但不要找太多层
      } else if (names.size > 1) {
        // 包含多道题了，停止，使用上一个找到的容器
        break;
      }

      // 如果没有 input，检查是否有可点击的选项元素
      if (allInputs.length === 0) {
        const options = current.querySelectorAll(
          '.option, [class*="option"], [class*="choice"]'
        );
        if (options.length >= 2 && options.length <= 6) {
          bestContainer = current;
        }
      }

      current = current.parentElement;
      depth++;
    }

    // 如果没找到，返回选项的直接父元素的父元素
    return (
      bestContainer ||
      element.parentElement?.parentElement ||
      element.parentElement ||
      element
    );
  }

  // 标记题目为已完成
  function markAsCompleted(element) {
    if (!element) return;

    // 添加完成样式
    // 检查是否已有标记
    if (element.dataset.aiAnswerCompleted === "true") return;

    // 创建完成标记
    removeHighlight(element);
    element.dataset.aiAnswerCompleted = "true";
    element.style.outline = "2px solid #22c55e";
    element.style.outlineOffset = "2px";
  }

  // 直接应用答案（使用AI返回的选择器）
  async function applyAnswerDirectly(question) {
    switch (question.type) {
      case "single":
        await applySingleAnswerDirectly(question);
        break;
      case "multiple":
        await applyMultipleAnswerDirectly(question);
        break;
      case "fill":
        await applyFillAnswerDirectly(question);
        break;
    }
  }

  // 单选题 - 直接点击对应选项
  async function applySingleAnswerDirectly(question) {
    const answerLetter = String(question.answer).toUpperCase();
    const option = (question.options || []).find(
      (item) => String(item.label).toUpperCase() === answerLetter
    );

    if (!option) {
      throw new Error(`答案 ${answerLetter} 不在选项列表中`);
    }

    let element = option.element;
    if (!element && option.selector) {
      element = safeQuerySelector(option.selector);
    }
    if (!element) {
      throw new Error(`找不到选项 ${option.label} 的元素`);
    }

    const input =
      element.tagName === "INPUT"
        ? element
        : element.querySelector('input[type="radio"], input[type="checkbox"]');

    // 已经选中就不重复点击
    if (input && input.type === "radio" && input.checked) {
      return;
    }

    await clickElement(element);

    if (input && input.type === "radio" && !input.checked) {
      // 有些站点需要点击 label
      const label =
        input.closest("label") ||
        (input.id
          ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
          : null);
      if (label) {
        label.click();
        await sleep(100);
      }
    }

    if (input && input.type === "radio" && !input.checked) {
      throw new Error(`选项 ${option.label} 未能选中`);
    }

    console.log(`[AI答题助手] 单选已点击: ${option.label}`);
  }

  // 多选题 - 点击所有正确选项
  async function applyMultipleAnswerDirectly(question) {
    let answers = question.answer;

    // 确保answers是数组
    if (typeof answers === "string") {
      answers = answers
        .split(/[^A-Za-z]+/)
        .filter(Boolean)
        .map((c) => c.toUpperCase());
    } else if (Array.isArray(answers)) {
      answers = answers.map((a) => String(a).toUpperCase());
    } else {
      answers = [];
    }

    console.log(`[AI答题助手] 多选答案:`, answers);

    for (const option of question.options || []) {
      if (!answers.includes(String(option.label).toUpperCase())) continue;

      let element = option.element;
      if (!element && option.selector) {
        element = safeQuerySelector(option.selector);
      }
      if (!element) {
        throw new Error(`找不到选项 ${option.label} 的元素`);
      }

      const input =
        element.tagName === "INPUT"
          ? element
          : element.querySelector('input[type="checkbox"]');

      // 已经勾选就不重复点击（重复点击会取消勾选）
      if (input && input.type === "checkbox" && input.checked) continue;

      await clickElement(element);

      // label 兜底
      if (input && input.type === "checkbox" && !input.checked) {
        const label =
          input.closest("label") ||
          (input.id
            ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
            : null);
        if (label) {
          label.click();
          await sleep(100);
        }
      }

      if (input && input.type === "checkbox" && !input.checked) {
        throw new Error(`选项 ${option.label} 未能勾选`);
      }

      console.log(`[AI答题助手] 多选已点击: ${option.label}`);
      await sleep(200);
    }
  }

  // 填空题 - 填写答案
  async function applyFillAnswerDirectly(question) {
    const answers = (Array.isArray(question.answer)
      ? question.answer
      : [question.answer]
    ).map((value) => String(value === undefined || value === null ? "" : value));

    const inputs = (question.inputs || [])
      .map((inputInfo) => {
        let element = inputInfo.element;
        if ((!element || !element.isConnected) && inputInfo.selector) {
          element = safeQuerySelector(inputInfo.selector);
        }
        return element;
      })
      .filter(Boolean);

    if (inputs.length === 0) {
      throw new Error("找不到填空题输入框");
    }

    if (inputs.length === 1) {
      const combined =
        answers.length === 1 ? answers[0] : answers.join("；");
      await fillInput(inputs[0], combined);
      console.log(`[AI答题助手] 填空已填写: ${combined}`);
      return;
    }

    // 多个输入框：按顺序填入；答案不足时只填已有部分
    for (let index = 0; index < inputs.length; index += 1) {
      let value = answers[index];
      if (value === undefined) {
        if (index === inputs.length - 1 && answers.length > inputs.length) {
          value = answers.slice(index).join("；");
        } else {
          value = "";
        }
      }
      if (!value) continue;
      await fillInput(inputs[index], value);
      console.log(`[AI答题助手] 填空 ${index + 1} 已填写: ${value}`);
    }

    if (answers.length < inputs.length) {
      console.warn(
        `[AI答题助手] 答案数量(${answers.length})少于输入框数量(${inputs.length})`
      );
    }
  }

  // 填写输入框
  async function fillInput(element, value) {
    if (!element) throw new Error("输入框不存在");

    const text = String(value);
    element.focus();
    await sleep(50);

    // contenteditable 富文本输入框
    if (element.isContentEditable) {
      element.textContent = text;
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, composed: true })
      );
      element.dispatchEvent(
        new Event("change", { bubbles: true, composed: true })
      );
      element.blur();
      await sleep(50);
      return;
    }

    // React 等受控组件需要走原生 setter，直接赋值可能被覆盖
    try {
      const proto =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && descriptor.set) {
        descriptor.set.call(element, text);
      } else {
        element.value = text;
      }
    } catch (_) {
      element.value = text;
    }

    element.dispatchEvent(
      new Event("input", { bubbles: true, composed: true })
    );
    element.dispatchEvent(
      new Event("change", { bubbles: true, composed: true })
    );
    element.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, composed: true })
    );
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, composed: true })
    );

    element.blur();
    await sleep(50);

    if (
      text &&
      (element.tagName === "INPUT" || element.tagName === "TEXTAREA") &&
      !element.value
    ) {
      throw new Error("输入框写入失败（可能被页面脚本覆盖）");
    }
  }

  // Stop answering
  function stopAnswering() {
    if (!isRunning) return;

    isRunning = false;
    runFinished = true; // 防止 runSession 的 finally 重复上报
    sessionState = null;

    sendLog("warning", "已停止答题");
    bgSend({ action: "sessionStop" });
    bgSend({ action: "sessionClear" });
    updateStats();
    sendComplete(true);
  }

  // 逐题获取AI答案（只发送单道题目，不发送整页HTML）
  async function getAIAnswerForQuestion(question, hint = "") {
    let prompt = `请回答以下${getTypeLabel(question.type)}：\n\n`;
    prompt += `题目：${question.text}\n\n`;

    if (question.options && question.options.length > 0) {
      prompt += "选项：\n";
      question.options.forEach((opt) => {
        prompt += `${opt.label}. ${opt.text}\n`;
      });
      prompt += "\n";
    }

    if (
      question.type === "fill" &&
      question.inputs &&
      question.inputs.length > 1
    ) {
      prompt += `（共有 ${question.inputs.length} 个空需要填写）\n\n`;
    }

    prompt += `请严格按照JSON格式返回答案：
{
  "type": "${question.type}",
  "answer": ${
    question.type === "single"
      ? '"选项字母如B"'
      : question.type === "multiple"
      ? '["A", "C"]'
      : '["答案1", "答案2"]'
  },
  "explanation": "简短解释"
}

注意：
- 单选题answer为单个字母，如 "B"
- 多选题answer为字母数组，如 ["A", "C"]
- 填空题answer为答案数组，如 ["答案1"] 或 ["答案1", "答案2"]
- 只返回JSON，不要其他内容`;

    if (hint) {
      prompt += `\n\n${hint}`;
    }

    const response = await bgSend({ action: "callAI", config, prompt });
    if (!response.success) {
      throw new Error(response.error || "AI 请求失败");
    }

    try {
      return parseAIResponse(response.data);
    } catch (error) {
      throw new Error(`解析AI响应失败: ${error.message}`);
    }
  }

  // Get AI answer for a question (legacy, kept for compatibility)
  async function getAIAnswer(question) {
    return getAIAnswerForQuestion(question);
  }

  // Build prompt for AI
  function buildPrompt(question) {
    let prompt = `题目类型: ${getTypeLabel(question.type)}\n\n`;
    prompt += `题目: ${question.text}\n\n`;

    if (question.options.length > 0) {
      prompt += "选项:\n";
      question.options.forEach((opt) => {
        prompt += `${opt.label}. ${opt.text}\n`;
      });
    }

    if (question.type === "fill") {
      prompt += `\n这是一道填空题，请给出填空的答案。`;
      if (question.inputs.length > 1) {
        prompt += `共有 ${question.inputs.length} 个空需要填写。`;
      }
    }

    return prompt;
  }

  // Get type label
  function getTypeLabel(type) {
    const labels = {
      single: "单选题",
      multiple: "多选题",
      fill: "填空题",
    };
    return labels[type] || type;
  }

  // Parse AI response
  function parseAIResponse(responseText) {
    let text = String(responseText || "").trim();

    // Handle markdown code blocks
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();

    // Most models return exactly one JSON object
    try {
      return JSON.parse(text);
    } catch (_) {
      /* fall through to balanced-brace extraction */
    }

    // Find the first complete JSON object, ignoring braces inside strings
    const start = text.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
        } else if (char === '"') {
          inString = true;
        } else if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            return JSON.parse(text.slice(start, index + 1));
          }
        }
      }
    }

    throw new Error("未找到完整的 JSON 对象");
  }

  // Apply answer to question
  async function applyAnswer(question, answer) {
    switch (question.type) {
      case "single":
        await applySingleAnswer(question, answer);
        break;
      case "multiple":
        await applyMultipleAnswer(question, answer);
        break;
      case "fill":
        await applyFillAnswer(question, answer);
        break;
    }
  }

  // Apply single choice answer
  async function applySingleAnswer(question, answer) {
    const answerLetter = String(answer.answer).toUpperCase();

    for (const option of question.options) {
      if (option.label === answerLetter) {
        await clickElement(option.element);
        break;
      }
    }
  }

  // Apply multiple choice answer
  async function applyMultipleAnswer(question, answer) {
    let answers = answer.answer;
    if (typeof answers === "string") {
      answers = answers.split("").filter((c) => /[A-Z]/.test(c));
    }

    for (const option of question.options) {
      if (answers.includes(option.label)) {
        await clickElement(option.element);
        await sleep(200);
      }
    }
  }

  // Apply fill-in-the-blank answer
  async function applyFillAnswer(question, answer) {
    let answers = answer.answer;
    if (!Array.isArray(answers)) {
      answers = [answers];
    }

    for (let i = 0; i < Math.min(answers.length, question.inputs.length); i++) {
      const input = question.inputs[i];
      const value = String(answers[i]);

      // Focus and fill
      input.focus();
      await sleep(100);

      // Clear existing value
      input.value = "";

      // Set new value
      input.value = value;

      // Trigger events
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

      await sleep(100);
    }
  }

  // Click element - 增强版，支持多种点击方式
  async function clickElement(element) {
    if (!element) {
      console.warn("[AI答题助手] clickElement: element为空");
      return;
    }

    console.log("[AI答题助手] 点击元素:", element.tagName, element.className);

    // 1. 如果是input元素（radio/checkbox）
    if (element.tagName === "INPUT") {
      const inputType = element.type?.toLowerCase();
      if (inputType === "radio" || inputType === "checkbox") {
        // 优先尝试点击关联的label（腾讯问卷需要这样）
        if (element.id) {
          const label = document.querySelector(`label[for="${element.id}"]`);
          if (label) {
            console.log("[AI答题助手] 找到关联label，点击label");
            label.click();
            await sleep(50);
            // 验证是否成功
            if (element.checked) {
              console.log("[AI答题助手] 通过label点击成功");
              return;
            }
          }
        }

        // 如果没有label或label点击无效，直接设置checked
        element.checked = true;
      }
      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // 2. 查找内部的input元素
    const input = element.querySelector(
      'input[type="radio"], input[type="checkbox"]'
    );
    if (input) {
      input.checked = true;
      input.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 3. 点击元素本身
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );

    // 4. 尝试直接调用click方法
    if (typeof element.click === "function") {
      element.click();
    }

    // 5. 对于某些框架，可能需要触发mousedown/mouseup
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await sleep(50);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }

  // Scroll to element
  function scrollToElement(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // Highlight element - 高亮当前正在处理的题目（绿色流动光效）
  function highlightElement(element) {
    if (!element) return;

    // 保存原始样式
    element.dataset.originalOutline = element.style.outline || "";
    element.dataset.originalOutlineOffset = element.style.outlineOffset || "";
    element.dataset.originalBoxShadow = element.style.boxShadow || "";
    element.dataset.originalPosition = element.style.position || "";

    // 确保元素有定位以便添加伪元素
    if (getComputedStyle(element).position === "static") {
      element.style.position = "relative";
    }

    // 添加流动光效样式（如果还没添加）
    if (!document.getElementById("ai-answer-highlight-style")) {
      const style = document.createElement("style");
      style.id = "ai-answer-highlight-style";
      style.textContent = `
        @keyframes ai-border-flow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .ai-answer-processing {
          position: relative !important;
        }
        .ai-answer-processing::before {
          content: '';
          position: absolute;
          top: -3px;
          left: -3px;
          right: -3px;
          bottom: -3px;
          background: linear-gradient(90deg, #3b82f6, #6366f1, #8b5cf6, #6366f1, #3b82f6);
          background-size: 300% 100%;
          border-radius: 8px;
          z-index: -1;
          animation: ai-border-flow 2s ease infinite;
        }
        .ai-answer-processing::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: white;
          border-radius: 6px;
          z-index: -1;
        }
      `;
      document.head.appendChild(style);
    }

    // 应用高亮样式
    element.style.boxShadow = "0 0 20px rgba(59, 130, 246, 0.5)";
    element.style.transition = "all 0.3s ease";
    element.style.zIndex = "1";

    // 添加动画类
    element.classList.add("ai-answer-processing");
  }

  // Remove highlight - 移除高亮
  function removeHighlight(element) {
    if (!element) return;

    // 恢复原始样式
    element.style.outline = element.dataset.originalOutline || "";
    element.style.outlineOffset = element.dataset.originalOutlineOffset || "";
    element.style.boxShadow = element.dataset.originalBoxShadow || "";
    element.style.position = element.dataset.originalPosition || "";
    element.style.zIndex = "";

    // 移除动画类
    element.classList.remove("ai-answer-processing");
  }

  // 发送消息时读取 lastError，避免 popup 未打开时的控制台警告
  function safeSendMessage(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
      /* ignore */
    }
  }

  // Send log to popup
  function sendLog(level, text) {
    console.log(`[AI答题助手][${level}] ${text}`);
    safeSendMessage({ type: "log", level, text });
  }

  // Update stats in popup
  function updateStats() {
    safeSendMessage({
      type: "updateStats",
      questionCount: questions.length,
      answeredCount: totalAnswered,
      pageAnsweredCount: answeredCount,
      page: sessionState ? sessionState.page : lastPage,
      isRunning,
    });
  }

  // Send complete message
  function sendComplete(stopped = false) {
    safeSendMessage({
      type: "complete",
      answeredCount: totalAnswered,
      stopped,
    });
  }

  // Sleep utility
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Initialize
  console.log("[AI答题助手] v2 已加载");

  (async () => {
    // 初始化模板系统
    if (window.templateManager) {
      try {
        await window.templateManager.init();
        console.log("模板系统初始化完成");
      } catch (error) {
        console.error("模板系统初始化失败:", error);
      }
    }

    // 整页刷新后尝试恢复未完成的答题会话
    try {
      await resumeRunIfNeeded();
    } catch (error) {
      console.warn("[AI答题助手] 自动恢复失败:", error);
    }
  })();
})();
