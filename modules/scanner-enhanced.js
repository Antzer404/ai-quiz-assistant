// 修改自 rehuan/AI-ANSWER-ASSISTANT（GPL-3.0），修改日期：2026-10-26
// Scanner Enhanced Module - 增强扫描器
// 使用站点模板（内置 / 用户 / 本地学习）进行题目扫描

(function () {
  "use strict";

  function safeQueryAll(root, selector) {
    if (!root || !selector) return [];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (error) {
      console.warn("[EnhancedScanner] 选择器无效:", selector, error);
      return [];
    }
  }

  function safeQuery(root, selector) {
    if (!root || !selector) return null;
    try {
      return root.querySelector(selector);
    } catch (error) {
      console.warn("[EnhancedScanner] 选择器无效:", selector, error);
      return null;
    }
  }

  function safeMatches(element, selector) {
    if (!element || !selector) return false;
    try {
      return element.matches(selector);
    } catch (_) {
      return false;
    }
  }

  // 容器里存在可作答控件，却没有被解析出来：通常意味着模板漏了某种题型
  const ANSWERABLE_SELECTOR =
    'input[type="radio"], input[type="checkbox"], input[type="text"], input[type="number"], input:not([type]), textarea, [contenteditable="true"]';

  function hasAnswerableInput(element) {
    return Boolean(safeQuery(element, ANSWERABLE_SELECTOR));
  }

  class EnhancedScanner {
    constructor() {
      this.questions = [];
    }

    /**
     * 使用模板扫描题目
     * @param {Object} template 站点模板
     * @returns {Object} 扫描结果 { success, questions, count, found, skipped }
     */
    scanWithTemplate(template) {
      console.log("[EnhancedScanner] 开始使用模板扫描:", template.siteName);

      this.questions = [];
      const selectors = template.selectors;

      try {
        const questionElements = safeQueryAll(
          document,
          selectors.questionContainer
        );

        if (questionElements.length === 0) {
          console.warn("[EnhancedScanner] 未找到题目容器");
          return {
            success: false,
            questions: [],
            count: 0,
            found: 0,
            skipped: 0,
            missed: 0,
          };
        }

        console.log(
          `[EnhancedScanner] 找到 ${questionElements.length} 个题目容器`
        );

        let skipped = 0;
        let missed = 0;
        questionElements.forEach((element, index) => {
          const question = this._parseQuestionWithTemplate(
            element,
            index,
            template
          );
          if (question) {
            this.questions.push(question);
          } else {
            skipped += 1;
            if (hasAnswerableInput(element)) missed += 1;
          }
        });

        console.log(
          `[EnhancedScanner] 扫描完成，解析成功 ${this.questions.length} 道题` +
            (skipped ? `，跳过 ${skipped} 个非题目容器` : "")
        );

        return {
          success: this.questions.length > 0,
          questions: this.questions,
          count: this.questions.length,
          found: questionElements.length,
          skipped,
          missed,
        };
      } catch (error) {
        console.error("[EnhancedScanner] 扫描失败:", error);
        return {
          success: false,
          questions: [],
          count: 0,
          found: 0,
          skipped: 0,
          missed: 0,
          error: error.message,
        };
      }
    }

    /**
     * 使用模板解析单个题目
     * @private
     */
    _parseQuestionWithTemplate(element, index, template) {
      const selectors = template.selectors;
      const questionTypes = selectors.questionTypes;

      const isTypeConfig = (key, config) =>
        key !== "detectByAttribute" &&
        key !== "detectByInput" &&
        key !== "detectByClass" &&
        config &&
        typeof config === "object";

      // 确定题目类型
      let questionType = null;
      let typeSelectors = null;

      if (questionTypes.detectByInput) {
        // 本地学习模板：按 input 类型 / 容器特征 / 题干关键词识别题型
        for (const [type, config] of Object.entries(questionTypes)) {
          if (!isTypeConfig(type, config)) continue;

          if (config.optionInput && safeQuery(element, config.optionInput)) {
            questionType = type;
            typeSelectors = config;
            break;
          }
          if (config.inputs && safeQuery(element, config.inputs)) {
            questionType = type;
            typeSelectors = config;
            break;
          }
          if (config.detectClass && element.classList.contains(config.detectClass)) {
            questionType = type;
            typeSelectors = config;
            break;
          }
          if (
            config.detectAttribute &&
            element.getAttribute(config.detectAttribute.name) ===
              config.detectAttribute.value
          ) {
            questionType = type;
            typeSelectors = config;
            break;
          }
          if (config.detectText) {
            const titleEl = safeQuery(element, config.title);
            const text = titleEl
              ? titleEl.textContent
              : element.textContent.slice(0, 300);
            try {
              if (new RegExp(config.detectText, "i").test(text)) {
                questionType = type;
                typeSelectors = config;
                break;
              }
            } catch (_) {
              /* 无效正则忽略 */
            }
          }
        }
      } else if (questionTypes.detectByAttribute) {
        // 通过属性判断类型
        const attrName = questionTypes.detectByAttribute;
        const typeValue = element.getAttribute(attrName);

        for (const [type, config] of Object.entries(questionTypes)) {
          if (!isTypeConfig(type, config)) continue;
          if (config.typeValue === typeValue) {
            questionType = type;
            typeSelectors = config;
            break;
          }
        }
      } else {
        // 通过选择器判断类型
        for (const [type, config] of Object.entries(questionTypes)) {
          if (!isTypeConfig(type, config)) continue;
          if (safeMatches(element, config.container)) {
            questionType = type;
            typeSelectors = config;
            break;
          }
        }
      }

      if (!questionType || !typeSelectors) {
        return null;
      }

      // 提取题目文本；没有题干就无法作答，直接跳过
      const titleElement = safeQuery(element, typeSelectors.title);
      const text = titleElement
        ? this._cleanText(titleElement.textContent)
        : "";
      if (!text) {
        console.warn("[EnhancedScanner] 题目缺少题干文本，跳过:", element);
        return null;
      }

      const question = {
        index: index,
        type: questionType,
        text,
        options: [],
        inputs: [],
        answered: false,
        element: element,
      };

      if (questionType === "single" || questionType === "multiple") {
        question.options = this._parseOptions(element, typeSelectors, template);
        if (question.options.length < 2) return null;
        if (!question.options.some((option) => option.text)) return null;
      } else if (questionType === "fill") {
        question.inputs = this._parseInputs(element, typeSelectors);
        if (question.inputs.length === 0) return null;
      }

      console.log(
        `[EnhancedScanner] 题目${index + 1} [${questionType}]:`,
        question.text.substring(0, 30) + "..."
      );

      return question;
    }

    /**
     * 解析选项
     * @private
     */
    _parseOptions(container, typeSelectors, template) {
      const options = [];
      const optionElements = safeQueryAll(
        container,
        typeSelectors.optionItem
      );

      optionElements.forEach((optionEl, idx) => {
        // optionInput 为空时，选项元素本身就是点击目标
        let target = optionEl;
        if (typeSelectors.optionInput) {
          target = safeQuery(optionEl, typeSelectors.optionInput);
          if (!target) return;
        }

        // optionLabel 为空时，使用整个选项行的文本
        let optionText = "";
        if (typeSelectors.optionLabel) {
          const labelEl = safeQuery(optionEl, typeSelectors.optionLabel);
          optionText = labelEl ? labelEl.textContent.trim() : "";
        }
        if (!optionText) {
          optionText = (target !== optionEl ? optionEl : target)
            .textContent.trim();
        }

        // 提取选项字母
        let optionLabel = String.fromCharCode(65 + idx); // 默认A, B, C...

        if (typeSelectors.optionLabelPattern && optionText) {
          try {
            const pattern = new RegExp(typeSelectors.optionLabelPattern);
            const match = optionText.match(pattern);
            if (match && match[1]) {
              optionLabel = match[1];
              // 移除前缀
              optionText = optionText.substring(match[0].length).trim();
            }
          } catch (_) {
            /* 无效正则忽略 */
          }
        }

        // 生成精确选择器
        const selector = this._generateSelector(target, template);

        options.push({
          label: optionLabel,
          text: optionText,
          selector: selector,
          element: target,
        });
      });

      return options;
    }

    /**
     * 解析输入框
     * @private
     */
    _parseInputs(container, typeSelectors) {
      const inputs = [];
      const inputElements = safeQueryAll(container, typeSelectors.inputs);

      inputElements.forEach((input) => {
        const selector = this._generateSelector(input);
        inputs.push({
          selector: selector,
          element: input,
        });
      });

      return inputs;
    }

    /**
     * 生成元素的精确CSS选择器
     * @private
     */
    _generateSelector(element, template) {
      // 优先级1: ID选择器
      if (element.id) {
        return `#${element.id}`;
      }

      // 优先级2: name属性选择器
      if (element.name) {
        const tagName = element.tagName.toLowerCase();
        if (element.type) {
          return `${tagName}[name="${element.name}"][type="${element.type}"]`;
        }
        return `${tagName}[name="${element.name}"]`;
      }

      // 优先级3: 唯一属性选择器
      const uniqueAttrs = ["data-id", "data-index", "data-value"];
      for (const attr of uniqueAttrs) {
        if (element.hasAttribute(attr)) {
          const value = element.getAttribute(attr);
          return `${element.tagName.toLowerCase()}[${attr}="${value}"]`;
        }
      }

      // 优先级4: class + nth-child
      if (element.className) {
        const parent = element.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const index = siblings.indexOf(element) + 1;
          const className = element.className.split(" ")[0];
          return `.${className}:nth-child(${index})`;
        }
      }

      // 后备: 生成完整路径
      return this._getFullPath(element);
    }

    /**
     * 获取元素的完整路径
     * @private
     */
    _getFullPath(element) {
      const path = [];
      let current = element;

      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let selector = current.tagName.toLowerCase();

        if (current.id) {
          selector = `#${current.id}`;
          path.unshift(selector);
          break;
        }

        if (current.className) {
          const classList = current.className.trim().split(/\s+/);
          if (classList.length > 0 && classList[0]) {
            selector += `.${classList[0]}`;
          }
        }

        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (e) => e.tagName === current.tagName
          );
          if (siblings.length > 1) {
            const index = siblings.indexOf(current) + 1;
            selector += `:nth-of-type(${index})`;
          }
        }

        path.unshift(selector);
        current = parent;

        // 限制路径深度
        if (path.length > 5) break;
      }

      return path.join(" > ");
    }

    /**
     * 清理文本
     * @private
     */
    _cleanText(text) {
      return text
        .replace(/\s+/g, " ")
        .replace(/[\r\n]+/g, " ")
        .trim()
        .substring(0, 1000);
    }

    /**
     * 获取扫描结果
     */
    getQuestions() {
      return this.questions;
    }
  }

  // 导出到全局
  window.EnhancedScanner = EnhancedScanner;

  console.log("[EnhancedScanner] 模块已加载");
})();
