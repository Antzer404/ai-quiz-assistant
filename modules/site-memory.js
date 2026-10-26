// 修改自 rehuan/AI-ANSWER-ASSISTANT（GPL-3.0），新增日期：2026-10-26
// Site Memory Module - 本地站点结构记忆
//
// 首次用 AI 分析出题目结构后，把结构沉淀成可复用的“学习模板”：
//   - 之后同一域名的页面直接扫描 DOM，不再重复调用 AI 分析结构
//   - 同一域名可以保存多个页面结构，扫描时选取命中题目最多的一组
//   - 只保存通用选择器（不保存题目文本/答案），题目变了也能复用
//
// 存储位置：chrome.storage.local -> siteStructureMemory

(function () {
  "use strict";

  const STORAGE_KEY = "siteStructureMemory";
  const SCHEMA_VERSION = 1;
  const MAX_SITES = 100;
  const MAX_TEMPLATES_PER_SITE = 6;
  const OPTION_PREFIX_PATTERN = "^\\s*([A-Za-z])[\\.．、,，:：)）\\s]+";

  // 这些 class 通常表示题目状态，不适合作为结构选择器
  const STATE_CLASS = /^(active|selected|checked|current|focus|focused|hover|disabled|error|wrong|right|correct|done|answered|hidden|show|open|closed)$/i;

  // -------------------------------------------------------------------------
  // 通用工具
  // -------------------------------------------------------------------------

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/[\r\n]+/g, " ")
      .trim();
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function attrValue(value) {
    return JSON.stringify(String(value));
  }

  function safeQueryAll(root, selector) {
    if (!root || !selector) return [];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  function safeQuery(root, selector) {
    if (!root || !selector) return null;
    try {
      return root.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  function uniqueElements(elements) {
    return Array.from(new Set((elements || []).filter(Boolean)));
  }

  function hostOf(url) {
    try {
      return new URL(url || window.location.href).hostname;
    } catch (_) {
      return "";
    }
  }

  function originOf(url) {
    try {
      return new URL(url || window.location.href).origin;
    } catch (_) {
      return window.location.origin || "";
    }
  }

  function now() {
    return Date.now();
  }

  function generateId() {
    return "mem-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  // -------------------------------------------------------------------------
  // 选择器推导
  // -------------------------------------------------------------------------

  function classListOf(element) {
    return Array.from(element.classList || []).filter(
      (name) => name && name.length <= 60
    );
  }

  function commonClassNames(elements) {
    if (!elements.length) return [];
    let common = classListOf(elements[0]);
    for (let i = 1; i < elements.length; i += 1) {
      const set = new Set(classListOf(elements[i]));
      common = common.filter((name) => set.has(name));
    }
    return common.filter((name) => !STATE_CLASS.test(name));
  }

  // 生成某个元素的候选选择器（不包含 id，因为 id 往往每题不同）
  function elementCandidates(element) {
    if (!element) return [];
    const tag = element.tagName.toLowerCase();
    const classes = classListOf(element);
    const candidates = [];
    const add = (selector) => {
      if (selector && !candidates.includes(selector)) candidates.push(selector);
    };

    if (classes.length) {
      add(`${tag}${classes.map((name) => "." + cssEscape(name)).join("")}`);
      classes.forEach((name) => add(`${tag}.${cssEscape(name)}`));
      classes.forEach((name) => add(`.${cssEscape(name)}`));
    }

    const type = element.getAttribute("type");
    if (type) add(`${tag}[type=${attrValue(type)}]`);

    [
      "data-question-type",
      "data-type",
      "data-role",
      "role",
      "name",
    ].forEach((attr) => {
      const value = element.getAttribute(attr);
      if (value && value.length <= 60) {
        add(`${tag}[${attr}=${attrValue(value)}]`);
      }
    });

    add(tag);
    return candidates;
  }

  // 候选选择器的“简洁度”评分：优先稳定、简短的 class
  function scoreSimpleSelector(selector) {
    const classCount = (selector.match(/\./g) || []).length;
    let score = 100 - classCount * 3;
    if (selector.includes("[")) score += 6;
    if (
      /title|stem|topic|question|option|choice|answer|item|label|blank|input/i.test(
        selector
      )
    ) {
      score += 12;
    }
    return score;
  }

  function collectQuestionElements(question) {
    const elements = [];
    const push = (element) => {
      if (element && element.isConnected && !elements.includes(element)) {
        elements.push(element);
      }
    };

    (question.options || []).forEach((option) => {
      if (!option) return;
      if (option.element) push(option.element);
      else if (option.selector) push(safeQuery(document, option.selector));
    });
    (question.inputs || []).forEach((input) => {
      if (!input) return;
      if (input.element) push(input.element);
      else if (input.selector) push(safeQuery(document, input.selector));
    });

    return elements;
  }

  // 找到一道题的最小公共容器，并用题干文本向上校正（填空题的输入框通常很小）
  function findContainer(elements, questionText) {
    const valid = (elements || []).filter(Boolean);
    if (!valid.length) return null;

    let container = valid[0];
    for (let i = 1; i < valid.length; i += 1) {
      while (
        container &&
        container !== document.documentElement &&
        !container.contains(valid[i])
      ) {
        container = container.parentElement;
      }
      if (!container) return null;
    }

    const wanted = normalizeText(questionText);
    if (!wanted) return container;
    const probe = wanted.slice(0, Math.min(40, wanted.length));

    let node = container;
    for (let depth = 0; node && node !== document.body && depth < 6; depth += 1) {
      if (normalizeText(node.textContent).includes(probe)) return node;
      node = node.parentElement;
    }
    return container;
  }

  // 在题目容器内找到题干元素：文本与 AI 识别出的题干最接近、层级最深的元素
  function findTitleElement(container, questionText) {
    const wanted = normalizeText(questionText);
    if (!container || !wanted) return null;

    const nodes = safeQueryAll(
      container,
      'h1,h2,h3,h4,h5,h6,p,span,div,label,strong,b,em,i,a,td,[class*="title"],[class*="stem"],[class*="topic"],[class*="question"]'
    );

    let best = null;
    let bestScore = -Infinity;

    nodes.forEach((element) => {
      if (element === container) return;
      const text = normalizeText(element.textContent);
      if (!text || text.length > wanted.length + 80) return;

      let score = -Infinity;
      if (text === wanted) score = 1000;
      else if (text.startsWith(wanted)) score = 500 - (text.length - wanted.length);
      else if (wanted.startsWith(text) && text.length >= Math.min(6, wanted.length)) {
        score = 300 - (wanted.length - text.length) * 2;
      } else if (text.includes(wanted) && text.length <= wanted.length + 30) {
        score = 200;
      }
      if (!Number.isFinite(score)) return;

      // 越“叶子”的元素越可能是题干；带 title/stem/topic class 的加分
      score -= element.querySelectorAll("*").length * 2;
      if (/title|stem|topic|question/i.test(classListOf(element).join(" "))) {
        score += 80;
      }
      if (element.tagName === "DIV") score += 5;

      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    });

    return best;
  }

  // 为一组“容器 -> 子元素”推导同一个相对选择器
  function deriveChildSelector(containers, targets) {
    if (!containers.length || containers.length !== targets.length) return null;

    const candidates = [];
    targets.forEach((target) => {
      elementCandidates(target).forEach((selector) => {
        if (!candidates.includes(selector)) candidates.push(selector);
      });
    });

    let best = null;
    let bestScore = -Infinity;

    candidates.forEach((selector) => {
      for (let i = 0; i < containers.length; i += 1) {
        const found = safeQuery(containers[i], selector);
        if (!found) return;

        const target = targets[i];
        if (target && found !== target) {
          const wanted = normalizeText(target.textContent);
          const got = normalizeText(found.textContent);
          if (!wanted || !got) return;
          if (!(got === wanted || got.includes(wanted) || wanted.includes(got))) {
            return;
          }
        }
      }

      const score = scoreSimpleSelector(selector);
      if (score > bestScore) {
        bestScore = score;
        best = selector;
      }
    });

    return best;
  }

  function containerSelectorCandidates(containers) {
    if (!containers.length) return [];

    const sameTag = containers.every(
      (element) => element.tagName === containers[0].tagName
    );
    const tag = containers[0].tagName.toLowerCase();
    const commonClasses = commonClassNames(containers);
    const candidates = [];
    const add = (selector) => {
      if (selector && !candidates.includes(selector)) candidates.push(selector);
    };

    if (sameTag) {
      if (commonClasses.length) {
        add(`${tag}${commonClasses.map((name) => "." + cssEscape(name)).join("")}`);
        commonClasses.forEach((name) => add(`${tag}.${cssEscape(name)}`));
        if (commonClasses.length > 1) {
          commonClasses.forEach((name) => add(`.${cssEscape(name)}`));
        }
      }

      [
        "data-question-id",
        "data-question-type",
        "data-type",
        "data-role",
        "role",
        "name",
      ].forEach((attr) => {
        if (containers.every((element) => element.hasAttribute(attr))) {
          add(`${tag}[${attr}]`);
          if (commonClasses.length) {
            add(
              `${tag}${commonClasses
                .map((name) => "." + cssEscape(name))
                .join("")}[${attr}]`
            );
          }
        }
      });

      add(tag);
    } else {
      // 容器标签不一致时只能依赖共同 class
      commonClasses.forEach((name) => add(`.${cssEscape(name)}`));
    }

    return candidates;
  }

  function chooseContainerSelector(containers) {
    const candidates = containerSelectorCandidates(containers);
    let best = null;
    let bestScore = -Infinity;

    candidates.forEach((selector) => {
      // 只接受带 class 或属性的容器选择器：body / form / div 这类过宽的
      // 选择器在题目数量变化时会把多道题误当成一道题
      const classCount = (selector.match(/\./g) || []).length;
      if (!classCount && !selector.includes("[")) return;

      const matches = safeQueryAll(document, selector);
      if (!matches.length) return;
      if (!containers.every((container) => matches.includes(container))) return;

      // 匹配结果之间不能互相嵌套，否则外层容器也会被当成一道题
      const nested = matches.some((match) =>
        matches.some((other) => other !== match && match.contains(other))
      );
      if (nested) return;

      const extra = matches.length - containers.length;
      const maxExtra = containers.length === 1 ? 0 : Math.max(2, containers.length);
      if (extra > maxExtra) return;

      let score = 100 - extra * 6;
      score += classCount * 4;
      if (selector.includes("[")) score += 8;

      if (score > bestScore) {
        bestScore = score;
        best = selector;
      }
    });

    return best;
  }

  // -------------------------------------------------------------------------
  // 选项 / 输入框模板推导
  // -------------------------------------------------------------------------

  // 找到选项输入框对应的“选项行”元素（label 或包含输入框的父级）
  function findOptionItem(input, container) {
    if (!input || !container) return null;

    const label = input.closest("label");
    if (label && container.contains(label)) return label;

    if (input.id) {
      const forLabel = safeQuery(document, `label[for=${attrValue(input.id)}]`);
      if (forLabel && container.contains(forLabel)) return forLabel;
    }

    const parent = input.parentElement;
    if (parent && parent !== container && container.contains(parent)) {
      return parent;
    }

    return null;
  }

  // 纯点击选项（没有 input）：从 AI 指向的元素向上找最像“选项行”的可点击元素
  function findClickableItem(element, container) {
    if (!element || !container) return null;

    let node = element;
    let best = element;
    let depth = 0;

    while (node && node !== container && depth < 4) {
      const className = classListOf(node).join(" ");
      const role = node.getAttribute("role");
      if (
        /option|choice|answer|item|radio|checkbox/i.test(className) ||
        role === "radio" ||
        role === "checkbox"
      ) {
        best = node;
      }
      node = node.parentElement;
      depth += 1;
    }

    if (!normalizeText(best.textContent)) {
      return null;
    }
    return best;
  }

  function prepareChoiceGroup(group) {
    const prepared = [];

    for (const entry of group) {
      const options = (entry.question.options || []).filter(Boolean);
      const items = [];

      for (const option of options) {
        const element =
          option.element ||
          (option.selector ? safeQuery(document, option.selector) : null);
        if (!element || !element.isConnected) return null;

        const input =
          element.tagName === "INPUT"
            ? element
            : safeQuery(
                element,
                'input[type="radio"], input[type="checkbox"]'
              );

        if (input) {
          const item = findOptionItem(input, entry.container);
          if (!item || !entry.container.contains(item)) return null;
          items.push({ item, input, option, element });
        } else {
          // 纯点击选项：没有原生 input，靠选项行本身的点击事件
          const item = findClickableItem(element, entry.container);
          if (!item || !entry.container.contains(item)) return null;
          items.push({ item, input: null, option, element });
        }
      }

      if (items.length < 2) return null;
      prepared.push({ ...entry, items });
    }

    return prepared;
  }

  function chooseOptionInputSelector(prepared, type) {
    const expectedType = type === "multiple" ? "checkbox" : "radio";
    const candidates = [];
    const add = (selector) => {
      if (selector && !candidates.includes(selector)) candidates.push(selector);
    };

    prepared.forEach((entry) => {
      entry.items.forEach(({ input }) => {
        add(`input[type="${expectedType}"]`);
        add("input");
        classListOf(input).forEach((name) => add(`input.${cssEscape(name)}`));
      });
    });

    for (const selector of candidates) {
      let valid = true;
      for (const entry of prepared) {
        for (const { item, input } of entry.items) {
          const found = safeQuery(item, selector);
          if (!found || found !== input) {
            valid = false;
            break;
          }
          if (found.type && found.type !== expectedType) {
            valid = false;
            break;
          }
        }
        if (!valid) break;
      }
      if (valid) return selector;
    }

    return null;
  }

  function chooseOptionItemSelector(prepared, optionInput, type) {
    const expectedType = type === "multiple" ? "checkbox" : "radio";
    const candidates = [];
    prepared.forEach((entry) => {
      entry.items.forEach(({ item }) => {
        elementCandidates(item).forEach((selector) => {
          if (!candidates.includes(selector)) candidates.push(selector);
        });
      });
    });

    let best = null;
    let bestScore = -Infinity;

    candidates.forEach((selector) => {
      for (const entry of prepared) {
        const found = safeQueryAll(entry.container, selector);

        if (!entry.items.every(({ item }) => found.includes(item))) return;

        if (optionInput) {
          // 有 input 时允许少量额外匹配（例如“其他”选项、装饰性 label）：
          // 扫描器会跳过不含目标 input 的选项行，不会影响答案映射
          if (found.length < entry.items.length) return;
          if (
            found.length - entry.items.length >
            Math.max(2, entry.items.length)
          ) {
            return;
          }
          for (const { item } of entry.items) {
            const input = safeQuery(item, optionInput);
            if (!input) return;
            if (input.type && input.type !== expectedType) return;
          }
        } else {
          // 纯点击选项没有 input 作为过滤条件，要求数量完全吻合，
          // 避免把题干或其他文本行误当成选项
          if (found.length !== entry.items.length) return;
        }
      }

      const score = scoreSimpleSelector(selector);
      if (score > bestScore) {
        bestScore = score;
        best = selector;
      }
    });

    return best;
  }

  function detectOptionPrefixPattern(prepared) {
    for (const entry of prepared) {
      for (const { item, option } of entry.items) {
        const itemText = normalizeText(item.textContent);
        const optionText = normalizeText(option.text);
        if (!itemText || !optionText || itemText === optionText) continue;

        const index = itemText.indexOf(optionText);
        if (index <= 0) continue;

        const prefix = itemText.slice(0, index).trim();
        if (/^[A-Za-z][\s.．、,，:：)）]*$/.test(prefix)) {
          return OPTION_PREFIX_PATTERN;
        }
      }
    }
    return "";
  }

  function deriveChoiceConfig(group, questionContainer, titleSelector) {
    if (!group.length) return null;

    const prepared = prepareChoiceGroup(group);
    if (!prepared) return null;

    const type = group[0].question.type;
    const hasInput = prepared.every((entry) =>
      entry.items.every(({ input }) => Boolean(input))
    );
    const hasNoInput = prepared.every((entry) =>
      entry.items.every(({ input }) => !input)
    );
    if (!hasInput && !hasNoInput) return null;

    const optionInput = hasInput
      ? chooseOptionInputSelector(prepared, type)
      : "";
    if (hasInput && !optionInput) return null;

    const optionItem = chooseOptionItemSelector(
      prepared,
      optionInput,
      type
    );
    if (!optionItem) return null;

    return {
      container: questionContainer,
      title: titleSelector,
      optionItem,
      optionInput,
      optionLabel: "",
      optionLabelPattern: detectOptionPrefixPattern(prepared),
    };
  }

  function inputSelectorFor(element) {
    if (!element) return "";
    if (element.isContentEditable) return '[contenteditable="true"]';

    const tag = element.tagName.toLowerCase();
    if (tag === "textarea") return "textarea";
    if (tag === "input") {
      const type = element.getAttribute("type");
      return type ? `input[type=${attrValue(type)}]` : "input:not([type])";
    }
    return "";
  }

  function deriveFillConfig(group, questionContainer, titleSelector) {
    const selectors = [];

    for (const entry of group) {
      const inputs = entry.question.inputs || [];
      if (!inputs.length) return null;
      for (const input of inputs) {
        const element =
          input.element ||
          (input.selector ? safeQuery(document, input.selector) : null);
        if (!element || !element.isConnected) return null;
        const selector = inputSelectorFor(element);
        if (!selector) return null;
        if (!selectors.includes(selector)) selectors.push(selector);
      }
    }

    if (!selectors.length) return null;
    const combined = selectors.join(", ");

    for (const entry of group) {
      const expected = (entry.question.inputs || []).length;
      const found = safeQueryAll(entry.container, combined);
      if (found.length < expected) return null;
      if (found.length > expected + 2) return null;
    }

    return {
      container: questionContainer,
      title: titleSelector,
      inputs: combined,
    };
  }

  // 为不同类型补充“类型识别”信息：当页面没有 input/textarea 时，
  // 仍可通过容器 class / 属性 / 题干关键词区分题型。
  function applyTypeDistinguishers(types, typeContainers) {
    const keys = Object.keys(types);
    if (!keys.length) return;

    const classSets = {};
    keys.forEach((type) => {
      const elements = uniqueElements(typeContainers[type] || []);
      if (!elements.length) {
        classSets[type] = [];
        return;
      }
      let common = classListOf(elements[0]);
      for (let i = 1; i < elements.length; i += 1) {
        const set = new Set(classListOf(elements[i]));
        common = common.filter((name) => set.has(name));
      }
      classSets[type] = common.filter((name) => !STATE_CLASS.test(name));
    });

    // 只有观察到至少两种题型时，容器 class/属性才具有“区分”意义；
    // 否则会把所有题都当成同一类型，宁可放弃学习也不冒答错的风险
    const observedTypes = keys.filter(
      (type) => uniqueElements(typeContainers[type] || []).length > 0
    );
    if (observedTypes.length >= 2) {
      keys.forEach((type) => {
        const config = types[type];
        if (config.optionInput || config.inputs) return;

        const otherClasses = new Set();
        observedTypes
          .filter((key) => key !== type)
          .forEach((key) =>
            classSets[key].forEach((name) => otherClasses.add(name))
          );

        const uniqueClass = classSets[type].find(
          (name) => !otherClasses.has(name)
        );
        if (uniqueClass) config.detectClass = uniqueClass;
      });

      // 属性区分（例如 type="3" / data-question-type="radio"）
      const attrNames = ["data-question-type", "data-type", "type"];
      keys.forEach((type) => {
        const config = types[type];
        if (config.optionInput || config.inputs || config.detectClass) return;

        const elements = uniqueElements(typeContainers[type] || []);
        if (!elements.length) return;

        for (const attr of attrNames) {
          if (!elements.every((element) => element.hasAttribute(attr))) continue;
          const value = elements[0].getAttribute(attr);
          if (!value) continue;

          const others = observedTypes
            .filter((key) => key !== type)
            .flatMap((key) => uniqueElements(typeContainers[key] || []));
          if (
            others.some(
              (element) =>
                element.hasAttribute(attr) && element.getAttribute(attr) === value
            )
          ) {
            continue;
          }

          config.detectAttribute = { name: attr, value };
          break;
        }
      });
    }

    // 题干关键词（主要针对“可点击 div”类选项）
    keys.forEach((type) => {
      const config = types[type];
      if (config.optionInput || config.inputs || config.detectClass || config.detectAttribute) {
        return;
      }
      if (type === "multiple") {
        config.detectText = "多选|多项选择|不定项|choose all|select all|multiple";
      } else if (type === "single") {
        config.detectText = "单选|单项选择|single choice";
      }
    });

  }

  // 纯点击选项：用选项行自身的 class / role / data-* 区分单选和多选
  function applyOptionDistinguishers(types, groups) {
    const clickTypes = Object.keys(types).filter((type) => {
      const config = types[type];
      return (
        config &&
        !config.optionInput &&
        !config.inputs &&
        config.optionItem
      );
    });
    if (clickTypes.length < 2) return;

    const classSets = {};
    const attrSets = {};
    const attrNames = [
      "role",
      "data-type",
      "data-option-type",
      "data-choice-type",
    ];

    clickTypes.forEach((type) => {
      const config = types[type];
      const items = [];
      (groups[type] || []).forEach(({ container }) => {
        safeQueryAll(container, config.optionItem).forEach((element) => {
          if (element && !items.includes(element)) items.push(element);
        });
      });

      if (!items.length) {
        classSets[type] = [];
        attrSets[type] = {};
        return;
      }

      let common = classListOf(items[0]);
      for (let i = 1; i < items.length; i += 1) {
        const set = new Set(classListOf(items[i]));
        common = common.filter((name) => set.has(name));
      }
      classSets[type] = common.filter((name) => !STATE_CLASS.test(name));

      const attrs = {};
      attrNames.forEach((attr) => {
        const value = items[0].getAttribute(attr);
        if (!value) return;
        if (items.every((element) => element.getAttribute(attr) === value)) {
          attrs[attr] = value;
        }
      });
      attrSets[type] = attrs;
    });

    clickTypes.forEach((type) => {
      const config = types[type];
      if (config.detectClass || config.detectAttribute) return;

      const otherTypes = clickTypes.filter((key) => key !== type);
      const otherClasses = new Set();
      otherTypes.forEach((key) =>
        (classSets[key] || []).forEach((name) => otherClasses.add(name))
      );

      const uniqueClass = (classSets[type] || []).find(
        (name) => !otherClasses.has(name)
      );
      if (uniqueClass) {
        config.detectOptionClass = uniqueClass;
        return;
      }

      const attrs = attrSets[type] || {};
      for (const [name, value] of Object.entries(attrs)) {
        const usedByOthers = otherTypes.some(
          (key) => (attrSets[key] || {})[name] === value
        );
        if (!usedByOthers) {
          config.detectOptionAttribute = { name, value };
          return;
        }
      }
    });
  }

  // 没有任何识别方式的配置会让扫描器误判，直接移除
  function pruneUndetectableTypes(types) {
    Object.keys(types).forEach((type) => {
      const config = types[type];
      if (
        !config.optionInput &&
        !config.inputs &&
        !config.detectClass &&
        !config.detectAttribute &&
        !config.detectOptionClass &&
        !config.detectOptionAttribute &&
        !config.detectText
      ) {
        delete types[type];
      }
    });
  }

  // -------------------------------------------------------------------------
  // SiteMemory
  // -------------------------------------------------------------------------

  class SiteMemory {
    constructor() {
      this.STORAGE_KEY = STORAGE_KEY;
      this.lastLearnError = "";
    }

    async _read() {
      try {
        const data = await chrome.storage.local.get(STORAGE_KEY);
        const raw = data[STORAGE_KEY];
        if (
          raw &&
          raw.version === SCHEMA_VERSION &&
          raw.sites &&
          typeof raw.sites === "object"
        ) {
          return raw;
        }
      } catch (error) {
        console.warn("[SiteMemory] 读取本地记忆失败:", error);
      }
      return { version: SCHEMA_VERSION, sites: {} };
    }

    async _write(store) {
      // 裁剪过大的站点列表，避免无限增长
      const hosts = Object.keys(store.sites);
      if (hosts.length > MAX_SITES) {
        hosts
          .sort(
            (a, b) =>
              (store.sites[a].updatedAt || 0) - (store.sites[b].updatedAt || 0)
          )
          .slice(0, hosts.length - MAX_SITES)
          .forEach((host) => delete store.sites[host]);
      }
      await chrome.storage.local.set({ [STORAGE_KEY]: store });
    }

    /**
     * 读取某个域名下的学习模板，按命中次数/最近使用排序
     */
    async getTemplates(host) {
      if (!host) return [];
      const store = await this._read();
      const site = store.sites[host];
      if (!site || !Array.isArray(site.templates)) return [];

      return site.templates
        .filter((entry) => entry && entry.template)
        .sort((a, b) => {
          const hitDiff =
            ((b.stats && b.stats.hits) || 0) -
            ((a.stats && a.stats.hits) || 0);
          if (hitDiff) return hitDiff;
          return (
            ((b.stats && b.stats.lastUsedAt) || 0) -
            ((a.stats && a.stats.lastUsedAt) || 0)
          );
        });
    }

    /**
     * 记录一次成功命中（失败的模板不惩罚，避免多页面结构互相淘汰）
     */
    async recordResult(host, templateId, success) {
      if (!host || !templateId) return;
      const store = await this._read();
      const site = store.sites[host];
      if (!site || !Array.isArray(site.templates)) return;

      const entry = site.templates.find((item) => item.id === templateId);
      if (!entry) return;

      entry.stats = entry.stats || { hits: 0, misses: 0, lastUsedAt: 0 };
      if (success) {
        entry.stats.hits += 1;
        entry.stats.misses = 0;
        entry.stats.lastUsedAt = now();
      } else {
        entry.stats.misses = (entry.stats.misses || 0) + 1;
      }
      site.updatedAt = now();
      await this._write(store);
    }

    /**
     * 保存学习模板（按结构指纹去重）
     */
    async saveTemplate(host, template) {
      if (!host || !template) return null;

      const store = await this._read();
      const site =
        store.sites[host] ||
        (store.sites[host] = {
          host,
          createdAt: now(),
          updatedAt: now(),
          templates: [],
        });

      const timestamp = now();
      const fingerprint = template.fingerprint || generateId();
      let entry = site.templates.find(
        (item) => item.fingerprint === fingerprint
      );

      if (entry) {
        const previousId = entry.id;
        const previousCreatedAt = entry.createdAt;
        entry.template = { ...template, id: previousId };
        entry.updatedAt = timestamp;
        entry.createdAt = previousCreatedAt || timestamp;
        entry.fingerprint = fingerprint;
      } else {
        const id = generateId();
        entry = {
          id,
          fingerprint,
          template: { ...template, id },
          createdAt: timestamp,
          updatedAt: timestamp,
          stats: { hits: 0, misses: 0, lastUsedAt: 0 },
        };
        site.templates.push(entry);
      }

      // 超过上限时淘汰命中次数最少、最久未使用的模板
      if (site.templates.length > MAX_TEMPLATES_PER_SITE) {
        site.templates
          .slice()
          .sort((a, b) => {
            const hitDiff =
              ((a.stats && a.stats.hits) || 0) -
              ((b.stats && b.stats.hits) || 0);
            if (hitDiff) return hitDiff;
            return (
              ((a.stats && a.stats.lastUsedAt) || 0) -
              ((b.stats && b.stats.lastUsedAt) || 0)
            );
          })
          .slice(0, site.templates.length - MAX_TEMPLATES_PER_SITE)
          .forEach((victim) => {
            const index = site.templates.indexOf(victim);
            if (index >= 0) site.templates.splice(index, 1);
          });
      }

      site.updatedAt = timestamp;
      await this._write(store);
      return entry;
    }

    /**
     * 从当前页面的 AI 识别结果学习结构模板
     * @returns {Promise<Object|null>} 保存后的模板（失败返回 null）
     */
    _fail(reason) {
      this.lastLearnError = reason;
      console.log("[SiteMemory] 跳过学习:", reason);
      return null;
    }

    async learnFromQuestions({ questions, url, origin } = {}) {
      this.lastLearnError = "";

      if (!Array.isArray(questions) || !questions.length) {
        return this._fail("没有识别到题目");
      }

      const host = hostOf(url);
      if (!host) return this._fail("无法识别当前域名");

      const items = [];
      let unlocatable = 0;
      questions.forEach((question) => {
        if (!question || !question.type) {
          unlocatable += 1;
          return;
        }
        const elements = collectQuestionElements(question);
        if (!elements.length) {
          unlocatable += 1;
          return;
        }
        const container = findContainer(elements, question.text);
        if (!container) {
          unlocatable += 1;
          return;
        }
        if (container === document.body || container === document.documentElement) {
          unlocatable += 1;
          return;
        }
        items.push({ question, container, elements });
      });

      if (!items.length) {
        return this._fail(
          unlocatable
            ? "AI 返回的题目选择器在页面上无法定位（可能选择器失效或题目不在主文档）"
            : "没有可学习的题目元素"
        );
      }

      const containers = uniqueElements(items.map((item) => item.container));
      if (!containers.length) return this._fail("无法定位题目容器");

      const questionContainer = chooseContainerSelector(containers);
      if (!questionContainer) {
        return this._fail(
          "无法生成稳定的题目容器选择器（容器缺少稳定的 class/属性，或匹配范围过宽）"
        );
      }

      const titleElements = items.map((item) =>
        findTitleElement(item.container, item.question.text)
      );
      if (titleElements.some((element) => !element)) {
        return this._fail("无法在题目容器内定位题干文本");
      }

      const titleSelector = deriveChildSelector(containers, titleElements);
      if (!titleSelector) {
        return this._fail("无法生成稳定的题干选择器");
      }

      const groups = { single: [], multiple: [], fill: [] };
      items.forEach((item) => {
        if (groups[item.question.type]) groups[item.question.type].push(item);
      });

      const types = {};
      const typeContainers = {};

      ["single", "multiple"].forEach((type) => {
        if (!groups[type].length) return;
        const config = deriveChoiceConfig(
          groups[type],
          questionContainer,
          titleSelector
        );
        if (!config) {
          this.lastLearnError = `无法推导${type === "single" ? "单选" : "多选"}题的选项结构`;
          return;
        }
        types[type] = config;
        typeContainers[type] = groups[type].map((item) => item.container);
      });

      if (groups.fill.length) {
        const config = deriveFillConfig(
          groups.fill,
          questionContainer,
          titleSelector
        );
        if (config) {
          types.fill = config;
          typeContainers.fill = groups.fill.map((item) => item.container);
        } else {
          this.lastLearnError = "无法推导填空题的输入框结构";
        }
      } else if (types.single || types.multiple) {
        // 首页没有填空题时也补一个通用填空题配置：填空题的输入框特征明显，
        // 检测顺序在单选/多选之后，不会抢走选择题。
        types.fill = {
          container: questionContainer,
          title: titleSelector,
          inputs:
            'input[type="text"], input[type="number"], input:not([type]), textarea, [contenteditable="true"]',
        };
      }

      // 同一站点常见“单选/多选同一套布局”，缺哪一类就镜像补齐
      if (types.single && !types.multiple && types.single.optionInput) {
        types.multiple = {
          ...types.single,
          optionInput: 'input[type="checkbox"]',
        };
      } else if (types.multiple && !types.single && types.multiple.optionInput) {
        types.single = {
          ...types.multiple,
          optionInput: 'input[type="radio"]',
        };
      }

      applyTypeDistinguishers(types, typeContainers);
      applyOptionDistinguishers(types, groups);
      pruneUndetectableTypes(types);

      if (!Object.keys(types).length) {
        return this._fail(
          "没有可用于区分题型的结构特征（纯点击选项且没有稳定的 class/角色/文案）"
        );
      }

      const template = {
        schema: SCHEMA_VERSION,
        siteId: "learned_" + host,
        source: "learned",
        siteName: "本地记忆 · " + host,
        host,
        origin: origin || originOf(url),
        urlPatterns: [`${origin || originOf(url)}/*`],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        selectors: {
          questionContainer,
          questionTypes: {
            detectByInput: true,
            ...types,
          },
        },
      };
      template.fingerprint = this.fingerprintOf(template);

      const validation = this.validateTemplate(template, questions.length);
      if (!validation.ok) {
        const detail = this.lastLearnError
          ? `${validation.reason}；${this.lastLearnError}`
          : validation.reason;
        return this._fail(`学习模板自检未通过：${detail}`);
      }

      const saved = await this.saveTemplate(host, template);
      console.log(
        `[SiteMemory] 已记住 ${host} 的页面结构（${validation.count} 道题）`,
        template.selectors
      );
      return saved ? saved.template : null;
    }

    fingerprintOf(template) {
      const selectors = template.selectors || {};
      const types = selectors.questionTypes || {};
      const pick = (value) => ({
        container: value && value.container,
        title: value && value.title,
        optionItem: value && value.optionItem,
        optionInput: value && value.optionInput,
        inputs: value && value.inputs,
        detectClass: value && value.detectClass,
        detectAttribute: value && value.detectAttribute,
        detectOptionClass: value && value.detectOptionClass,
        detectOptionAttribute: value && value.detectOptionAttribute,
        detectText: value && value.detectText,
      });
      return JSON.stringify({
        questionContainer: selectors.questionContainer,
        single: pick(types.single),
        multiple: pick(types.multiple),
        fill: pick(types.fill),
      });
    }

    validateTemplate(template, expectedCount) {
      if (!window.EnhancedScanner) {
        return { ok: true, count: expectedCount, reason: "no-scanner" };
      }

      let result;
      try {
        const scanner = new window.EnhancedScanner();
        result = scanner.scanWithTemplate(template);
      } catch (error) {
        return { ok: false, reason: error.message };
      }

      if (!result || !result.success || !result.count) {
        return { ok: false, reason: "扫描不到题目" };
      }

      // 有输入控件却没解析出来，说明模板漏了题型，宁可重新分析
      if (result.missed > 0) {
        return {
          ok: false,
          reason: `有 ${result.missed} 个含可作答控件的容器未被解析`,
        };
      }

      const minimum = Math.max(1, Math.ceil(expectedCount * 0.9));
      if (result.count < minimum) {
        return {
          ok: false,
          reason: `只扫描到 ${result.count}/${expectedCount} 道题`,
        };
      }

      return { ok: true, count: result.count, reason: "" };
    }

    async clearAll() {
      try {
        await chrome.storage.local.remove(STORAGE_KEY);
      } catch (error) {
        console.warn("[SiteMemory] 清除本地记忆失败:", error);
      }
    }

    async getSummary() {
      const store = await this._read();
      const sites = Object.values(store.sites || {}).map((site) => ({
        host: site.host,
        templateCount: Array.isArray(site.templates)
          ? site.templates.length
          : 0,
        updatedAt: site.updatedAt || 0,
      }));
      return {
        siteCount: sites.length,
        templateCount: sites.reduce(
          (sum, site) => sum + site.templateCount,
          0
        ),
        sites,
      };
    }
  }

  window.SiteMemory = SiteMemory;
  window.siteMemory = new SiteMemory();

  console.log("[SiteMemory] 模块已加载");
})();
