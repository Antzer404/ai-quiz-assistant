// 本文件属于基于 rehuan/AI-ANSWER-ASSISTANT（GPL-3.0）的修改版，新增日期：2026-10-26
// Navigation Module - 通用“下一题/下一页/提交”识别与页面变化等待
// 不依赖具体站点；站点差异优先通过 settings.nextSelector / submitSelector 覆盖。

(function () {
  "use strict";

  const CANDIDATE_SELECTOR = [
    "button",
    "a",
    '[role="button"]',
    'input[type="button"]',
    'input[type="submit"]',
    'input[type="image"]',
    ".btn",
    ".button",
    '[class*="next"]',
    '[id*="next"]',
    '[class*="submit"]',
    '[id*="submit"]',
    "[onclick]",
  ].join(", ");

  const NEGATIVE_TEXT = [
    "上一题",
    "上一步",
    "上一页",
    "返回",
    "取消",
    "关闭",
    "退出",
    "退出考试",
    "交卷并退出",
    "保存草稿",
    "暂存",
    "同意",
    "接受",
    "允许",
    "登录",
    "注册",
    "下载",
    "分享",
    "关注",
    "Back",
    "Previous",
    "Cancel",
    "Accept",
    "Allow",
    "Login",
    "Sign in",
  ];

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    try {
      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      ) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (_) {
      return false;
    }
  }

  function isDisabled(element) {
    if (!element) return true;
    if (element.disabled) return true;
    if (element.getAttribute("aria-disabled") === "true") return true;
    if (element.classList.contains("disabled")) return true;
    if (element.classList.contains("is-disabled")) return true;
    if (element.classList.contains("ant-btn-disabled")) return true;
    return false;
  }

  function controlText(element) {
    if (!element) return "";
    const parts = [
      element.innerText,
      element.textContent,
      element.value,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ];
    return normalizeText(parts.find((p) => normalizeText(p)) || "");
  }

  function matchesAny(text, list) {
    if (!text || !Array.isArray(list)) return false;
    const lower = text.toLowerCase();
    return list.some((keyword) => {
      const k = String(keyword || "")
        .toLowerCase()
        .trim();
      return k && lower.includes(k);
    });
  }

  function queryAllSafe(root, selector) {
    if (!root || !selector) return [];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (error) {
      console.warn("[QuizNavigation] 选择器无效:", selector, error);
      return [];
    }
  }

  // 收集开放 shadow root 中的候选元素（很多组件库会把按钮放在 shadow DOM 里）
  function collectWithShadowRoots(selector, root = document, depth = 0) {
    if (!root || depth > 4) return [];
    const found = queryAllSafe(root, selector);
    const shadowHosts = queryAllSafe(root, "*").filter(
      (el) => el.shadowRoot
    );
    shadowHosts.forEach((host) => {
      found.push(...collectWithShadowRoots(selector, host.shadowRoot, depth + 1));
    });
    return found;
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function collectCandidates(doc = document) {
    return uniqueElements(collectWithShadowRoots(CANDIDATE_SELECTOR, doc))
      .filter(isVisible)
      .filter((el) => !isDisabled(el))
      .filter((el) => !el.closest("header"))
      .filter((el) => {
        const text = controlText(el);
        if (!text) return false;
        if (text.length > 40) return false;
        return !matchesAny(text, NEGATIVE_TEXT);
      });
  }

  function scoreControl(element, text, keywords) {
    let score = 0;
    const lower = text.toLowerCase();
    keywords.forEach((keyword) => {
      const k = String(keyword).toLowerCase();
      if (lower === k) score += 1000;
      else if (lower.startsWith(k)) score += 300;
      else if (lower.includes(k)) score += 100;
    });

    // 原生可交互元素优先于同名的外层容器
    if (
      /^(BUTTON|A|INPUT)$/.test(element.tagName) ||
      element.getAttribute("role") === "button"
    ) {
      score += 200;
    }

    // 越靠近页面底部，越可能是“下一步”类按钮
    try {
      const rect = element.getBoundingClientRect();
      score += Math.min(50, Math.max(0, rect.top / 200));
    } catch (_) {
      /* ignore */
    }
    return score;
  }

  function findExplicit(doc, selector, type) {
    if (!selector) return null;
    const elements = queryAllSafe(doc, selector).filter(isVisible);
    if (!elements.length) return null;
    const element = elements[elements.length - 1];
    if (isDisabled(element)) return null;
    return {
      type,
      element,
      text: controlText(element),
      source: "selector",
    };
  }

  /**
   * 查找下一步操作。
   * @returns {{type: "next"|"submit"|null, element: Element|null, text: string, source: string}}
   */
  function findNextControl(doc = document, settings = {}) {
    const nextKeywords =
      Array.isArray(settings.nextText) && settings.nextText.length
        ? settings.nextText
        : ["下一题", "下一页", "继续", "下一步", "Next", "Continue"];
    const submitKeywords =
      Array.isArray(settings.submitText) && settings.submitText.length
        ? settings.submitText
        : ["提交", "交卷", "完成", "Submit"];

    const explicitNext = findExplicit(doc, settings.nextSelector, "next");
    if (explicitNext) return explicitNext;

    const explicitSubmit = findExplicit(doc, settings.submitSelector, "submit");
    if (explicitSubmit) return explicitSubmit;

    const candidates = collectCandidates(doc);

    const nexts = candidates
      .map((element) => ({ element, text: controlText(element) }))
      .filter(({ text }) => matchesAny(text, nextKeywords))
      .sort(
        (a, b) =>
          scoreControl(b.element, b.text, nextKeywords) -
          scoreControl(a.element, a.text, nextKeywords)
      );

    if (nexts.length) {
      return {
        type: "next",
        element: nexts[0].element,
        text: nexts[0].text,
        source: "text",
      };
    }

    const submits = candidates
      .map((element) => ({ element, text: controlText(element) }))
      .filter(({ text }) => matchesAny(text, submitKeywords))
      .sort(
        (a, b) =>
          scoreControl(b.element, b.text, submitKeywords) -
          scoreControl(a.element, a.text, submitKeywords)
      );

    if (submits.length) {
      return {
        type: "submit",
        element: submits[0].element,
        text: submits[0].text,
        source: "text",
      };
    }

    return { type: null, element: null, text: "", source: "none" };
  }

  function getPageSignature(doc = document) {
    const inputs = doc.querySelectorAll("input, textarea, select");
    const textNodes = Array.from(
      doc.querySelectorAll(
        'h1, h2, h3, .question, [class*="question"], [class*="title"], [class*="topic"]'
      )
    )
      .slice(0, 25)
      .map((el) => normalizeText(el.textContent).slice(0, 80))
      .join("|");

    return `${location.href}::${inputs.length}::${textNodes.slice(0, 800)}`;
  }

  async function waitForChange(
    previousSignature,
    timeoutMs = 10000,
    intervalMs = 200
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (getPageSignature() !== previousSignature) return true;
      await sleep(intervalMs);
    }
    return false;
  }

  function detectChallenge(doc = document) {
    const challengeSelectors = [
      'iframe[src*="captcha"]',
      '[class*="captcha"]',
      '[id*="captcha"]',
      '[class*="slider-verify"]',
      '[class*="verify-slider"]',
    ];

    for (const selector of challengeSelectors) {
      const elements = queryAllSafe(doc, selector);
      if (elements.some(isVisible)) return true;
    }

    const text = normalizeText(doc.body ? doc.body.innerText : "").slice(
      0,
      30000
    );
    return /人机验证|滑动验证|安全验证|请完成验证|拖动滑块|verify you are human/i.test(
      text
    );
  }

  window.QuizNavigation = {
    findNextControl,
    getPageSignature,
    waitForChange,
    detectChallenge,
    isVisible,
    isDisabled,
    controlText,
  };
})();
