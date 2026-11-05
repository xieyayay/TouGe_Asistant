// ==UserScript==
// @name         Helper
// @name:zh-CN   Helper
// @namespace    https://www.educoder.net/
// @version      1.8.5
// @description  在头歌任务页注入可视化面板：抓取题面和编辑器代码，调用你自己的 OpenAI 兼容 API 生成可提交答案。
// @description:zh-CN  在头歌任务页注入可视化面板：抓取题面和编辑器代码，调用你自己的 OpenAI 兼容 API 生成可提交答案。
// @author       xieyayaya
// @license      MIT
// @match        https://www.educoder.net/tasks/*
// @match        https://educoder.net/tasks/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================

  const STORAGE_KEY = 'educoder_ai_helper_settings_v1';
  const MAX_TASK_CHARS = 30000;
  // 与 @version 保持一致，用于识别页面上是否残留旧版实例
  const SCRIPT_VERSION = '1.8.5';

  const DEFAULTS = {
    preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.2,
    // 推理型模型的思维链会和答案抢预算，8192 很容易只够思考、
    // 结果 HTTP 200 但正文为空。默认给到 16384。
    maxTokens: 16384,
    // 默认对推理型模型关闭思考：解题要的是代码，不是推理过程
    disableThinking: true
  };

  const PRESETS = {
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat'
    },
    openai: {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini'
    },
    moonshot: {
      label: 'Moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k'
    },
    qwen: {
      label: '通义千问（兼容模式）',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus'
    },
    siliconflow: {
      label: 'SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-ai/DeepSeek-V3'
    },
    custom: {
      label: '自定义',
      baseUrl: '',
      model: ''
    }
  };

  const SYSTEM_PROMPT = [
    '你是一个专门解决头歌（EduCoder）实验任务的编程助手。用户会给你任务描述、模板代码、样例输入输出。',
    '你的唯一目标是交付**能通过平台测评**的完整代码，不是讲解知识点。',
    '',
    '## 开工前先锁定判题契约（必须逐项确认，不确定就按最保守的约定）',
    '| 项目 | 要确认的内容 |',
    '| 语言与环境 | Java/C/C++/Python？文件名、类名、包名、编译命令 |',
    '| 输入格式 | 几行、每行含义、空格分隔还是整行、是否多组、终止条件 |',
    '| 输出格式 | 是否逐字符比对、空行、行尾空格、中文标点、顺序 |',
    '| 可改范围 | 只能改 Begin/End 之间，还是整个文件 |',
    '| 样例 | 输入和预期输出是否完整，是否有隐藏样例提示 |',
    '',
    '**最关键的一条判断**：如果模板的 main 已经写死文法/参数、只从 stdin 读一行，那么判题就只喂这一行。',
    '不要按题面上"多行输入"去改 main，否则平台输入必然对不上。以模板 main 的实际读取行为为准。',
    '',
    '## 读模板，找隐性约束（头歌题的失分重灾区）',
    '模板经常把数据结构尺寸、符号表示、输出顺序写死，必须顺着模板写，不能想当然：',
    '- **数组尺寸**：是否按写死的数据量分配？新增非终结符、状态、边时会不会越界？',
    '- **符号是否按单字符处理**（charAt / indexOf / String[] 下标）？新符号不能用 E\' 这种两字符形式，改成 e、t 或单个大写字母。',
    '- **编号是否被复用**：分析表里存的是产生式序号时，打印顺序和填充顺序必须完全一致。',
    '- **空串/ε/结束符**用什么表示（-、ε、#、空字符串）？这个表示要同时贯穿集合、分析表、栈。',
    '- **语言细节**：Java 的 nextInt 后接 nextLine、C 的 fgets 保留换行、Python 的 input().strip()、C++ 的 getline 混用。',
    '- **模板自身的 bug**：越界、错误分支不退出导致死循环、查表下标为 -1。允许改模板外代码时做最小修复，并单独列出。',
    '',
    '## 硬规则（违反任何一条都会导致答案不可用）',
    '1. 只做必要修改。Begin/End 之外的修改必须单独列出并说明原因。',
    '2. 代码必须完整、可直接整体粘贴、无占位符、无 "其余同上"、无省略号、无调试输出。',
    '3. 类名 / 文件名 / 包名与模板完全一致，不要带 package（除非模板有）。',
    '4. 输出逐字符对齐：空格、空行、中文标点、全角/半角、表头、列顺序。多一个空格都可能判错。',
    '5. 不引入模板没有 import 的库；不编造"已通过测评"，只能说明本地验证覆盖了什么。',
    '6. 信息不足时不要停下来提问，按最合理约定实现，并在"不确定点"里列出假设。',
    '7. 多文件时必须逐个文件输出完整代码，文件名与输入完全一致，不能合并、不能省略、不能只改其中一个。',
    '',
    '## 各语言高频坑',
    '- Java：public class 名与文件名一致；nextInt 后 nextLine 会读到空行；split("|") 要转义成 split("\\\\|")；indexOf 返回 -1 直接访问数组会越界；错误分支打印后必须 break 否则死循环。',
    '- C：scanf("%s") 遇空格就停，整行用 fgets；fgets 保留 \\n 和 \\r，比较前要去掉；不要用 gets；数组按最大规模留余量，字符串结束符算进去；printf 宽度对齐样例。',
    '- C++：cin >> 与 getline 混用注意残留换行；大量输出用 "\\n" 不用 endl。',
    '- Python：input() 不去首尾空格，需要时 strip() 但要小心删掉有意义的空格；print 默认换行；深递归要 sys.setrecursionlimit；多组输入用 sys.stdin.read()。',
    '- 多文件：头文件与源文件的声明/定义必须一致；不要让某个文件引用另一个文件里不存在的符号。',
    '- 编译原理：分析栈按单字符处理时新非终结符不能用 E\'/T\'；ε 标记要贯穿 FIRST/FOLLOW/分析表/栈；产生式编号必须和打印顺序一致。',
    '',
    '## 自检清单（输出前在心里过一遍）',
    '- [ ] 输出格式和样例逐字符一致吗？（行尾空格、空行、标点）',
    '- [ ] 模板 main 的输入读取方式我改了吗？不该改的别改。',
    '- [ ] 数组有没有可能越界？查表下标为 -1 时处理了吗？',
    '- [ ] 错误分支会 break 吗？会不会死循环？',
    '- [ ] 类名/文件名和模板一致吗？有多余的调试输出吗？',
    '',
    '## 输出格式严格如下（默认只交代码，不要解说）',
    '',
    '用户的唯一目的是**把代码粘贴进平台交测评**。因此默认输出必须极简：',
    '- **不要写「思路」「实现说明」「算法讲解」这类段落**，一个字都不要。',
    '- 代码块之间的中文只能是**文件名行**，不能有任何别的话。',
    '- 结尾不要总结、不要"希望这对你有帮助"、不要复述题目。',
    '',
    '**代码块数量必须等于模板文件数，一个不多一个不少。** 模板有几个文件，就输出几个代码块；文件名叫什么，代码块就写什么。',
    '',
    '只有一个文件时，直接输出代码块，前面什么都不写：',
    '```<语言>',
    '完整源码',
    '```',
    '',
    '有多个文件时，每个文件一个代码块，代码块前只允许有一行文件名，格式固定为：',
    '### 文件: Main.java',
    '```java',
    '完整源码',
    '```',
    '',
    '**绝对不要输出这些东西**（会被判为模板外内容而剔除）：编译/运行命令（javac、gcc、./a.out）、Makefile（除非模板里就有）、示例输入输出、测试用例、diff、控制台截图描述、以及"再次确认版"这类重复代码。',
    '',
    '## 唯一允许的额外内容（放在所有代码块之后，能省则省）',
    '只有当确实存在**会影响判题**的假设或模板外修改时才写，否则整个段落直接省略：',
    '- 模板外修改：`Main.java:42 修正了 nextInt 后残留换行`（一行一条，没有就不写）',
    '- 不确定点：`ε 用 - 表示`（一行一条，没有就不写）',
    '',
    '本地样例验算结果用下面这个固定格式附在最后（机器读取，不占篇幅）：',
    '```',
    '本地验证',
    '输入: <这段输入>',
    '实际输出: <你的代码真正会打印的内容>',
    '与样例一致: 是 / 否（不一致时说明第一处差异）',
    '```'
  ].join('\n');

  // ============================================================
  // 存储
  // ============================================================

  function storageGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        return GM_getValue(key, fallback);
      }
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
      } else {
        localStorage.setItem(key, JSON.stringify(value));
      }
    } catch (e) {
      // 忽略存储失败，下一次重新配置即可
    }
  }

  function loadSettings() {
    let saved = storageGet(STORAGE_KEY, {});
    if (typeof saved === 'string') {
      try {
        saved = JSON.parse(saved);
      } catch (e) {
        saved = {};
      }
    }
    if (!saved || typeof saved !== 'object') {
      saved = {};
    }

    const settings = Object.assign({}, DEFAULTS, saved);

    // 一次性迁移：老默认值是 8192，推理型模型在这个预算下经常"只想不写"，
    // 表现为 HTTP 200 + 空正文。只在用户从未改动过（正好等于旧默认 8192）
    // 时抬到 16384；用户自己调过的值一律尊重，不能偷偷改。
    if (saved.maxTokens === 8192 && !saved.tokensMigrated) {
      settings.maxTokens = DEFAULTS.maxTokens;
      settings.tokensMigrated = true;
      try {
        storageSet(STORAGE_KEY, settings);
      } catch (e) {
        // 存不进去也不影响本次使用
      }
    }
    return settings;
  }

  // ============================================================
  // 状态
  // ============================================================

  const state = {
    settings: loadSettings(),
    answerRaw: '',
    answerCode: '',
    codeBlocks: [],
    busy: false,
    request: null,
    firstOpen: true,
    timerId: null,
    startTime: 0,
    generationId: 0,
    files: [],
    fileSeq: 0,
    activeFile: 0,
    pageFileNames: [],
    answerFiles: [],
    activeAnswerFile: 0,
    alignReport: null,
    sampleCheck: null,
    lastDiagnostics: null,
    lastRun: null,
    busyGrab: false
  };

  let shadow = null;

  // ============================================================
  // 工具
  // ============================================================

  function $(selector, root) {
    return (root || shadow).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.from((root || shadow).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[ch];
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function setStatus(text, type) {
    const el = $('#status');
    if (!el) return;
    el.textContent = text || '';
    el.className = type || '';
  }

  function setStatusMeta(text) {
    const el = $('#statusMeta');
    if (el) el.textContent = text || '';
  }

  async function copyText(text) {
    if (!text) throw new Error('没有可复制的内容');
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('浏览器拒绝了复制操作');
      return true;
    }
  }

  function confirmAction(message) {
    try {
      return window.confirm(message);
    } catch (e) {
      return true;
    }
  }

  function truncateText(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.slice(0, max) + '\n\n[内容过长，已截断，请检查是否遗漏关键信息]';
  }

  // ============================================================
  // API
  // ============================================================

  function buildEndpoint(baseUrl) {
    let base = String(baseUrl || '').trim();
    if (!base) throw new Error('请先填写 API Base URL');
    if (!/^https?:\/\//i.test(base)) {
      throw new Error('Base URL 必须以 http:// 或 https:// 开头');
    }
    base = base.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(base)) return base;
    return base + '/chat/completions';
  }

  function extractMessageContent(message) {
    if (!message) return '';
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(function (part) {
          if (typeof part === 'string') return part;
          if (part && typeof part.text === 'string') return part.text;
          return '';
        })
        .join('');
    }
    return '';
  }

  function maskKey(key) {
    const value = String(key || '').trim();
    if (!value) return '(未填写)';
    if (value.length <= 10) return value.slice(0, 2) + '***（长度 ' + value.length + '）';
    return value.slice(0, 6) + '…' + value.slice(-4) + '（长度 ' + value.length + '）';
  }

  function shortEndpoint(url) {
    try {
      const parsed = new URL(url);
      return parsed.host + parsed.pathname;
    } catch (e) {
      return String(url).slice(0, 100);
    }
  }

  // ============================================================
  // 空内容的根因诊断
  // ============================================================
  // 推理型模型（Qwen3 / QwQ / DeepSeek-R1 / GLM-Z1 等）把思维链写在
  // reasoning_content 里，content 才是答案。两者共用 max_tokens 预算：
  // 一旦思考阶段就把预算烧完，HTTP 依然是 200，但 choices[0].message.content
  // 是空串，finish_reason 通常是 'length'。这是"HTTP 200 却空内容"最常见的原因，
  // 也是最容易被误判成"接口坏了"的原因。
  function isReasoningModel(model) {
    const name = String(model || '').toLowerCase();
    return /(^|[/\-_.])(qwq|qvq|r1|reasoner|thinking|glm-z1|z1|o1|o3|o4)([/\-_.]|$)/.test(name) ||
      /qwen3|deepseek-r1|reasoning/.test(name);
  }

  // 有些兼容层即使 content 为空也会把答案塞在别的字段里，尽量都捞一遍
  function salvageEmptyContent(choice, data) {
    if (!choice && !data) return '';
    const sources = [
      choice && choice.message && choice.message.reasoning_content,
      choice && choice.message && choice.message.reasoning,
      data && data.reasoning_content
    ];
    for (let i = 0; i < sources.length; i += 1) {
      const value = sources[i];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  }

  function describeEmptyContent(status, text, data, maxTokensHint) {
    const choice = data && data.choices && data.choices[0];
    const finish = choice && choice.finish_reason;
    const usage = (data && data.usage) || {};
    const reasoningChars = String(salvageEmptyContent(choice, data) || '').length;
    const completionTokens = Number(usage.completion_tokens || 0);
    const maxTokens = Number(maxTokensHint || 0);

    const parts = ['接口返回了空内容（HTTP ' + status + '）'];

    if (finish === 'length' || (completionTokens && maxTokens && completionTokens >= maxTokens * 0.95)) {
      parts.push(
        '模型把 token 预算用完了还没开始写答案' +
        (reasoningChars ? '（思维链已输出 ' + reasoningChars + ' 字符，答案 0 字符）' : '') + '。' +
        '这是推理型模型的典型表现：思维链和答案共用 max_tokens。' +
        '把 Max tokens 调到 16384 或更高，或换成非推理模型（如 qwen-plus / deepseek-chat）。'
      );
    } else if (reasoningChars) {
      parts.push(
        '思维链有 ' + reasoningChars + ' 字符，但正式答案为空（finish_reason=' + (finish || '未知') + '）。' +
        '模型起手就陷进分析里了，重试通常能出来；也可以把 Temperature 调到 0.3~0.5 降低发散。'
      );
    } else if (finish === 'content_filter' || (data && data.choices && !data.choices.length)) {
      parts.push('服务端没有返回任何候选（finish_reason=' + (finish || 'no choices') + '），可能是内容审核拦截或模型名不存在。');
    } else {
      parts.push(
        '返回体里 choices[0].message.content 是空字符串。常见原因：' +
        '① 模型名写错或被路由到了非对话模型；② 推理型模型预算不足；' +
        '③ 兼容层字段不标准（可点「复制诊断」看上次返回体原文）。' +
        '原始返回体前 300 字符：' + String(text || '').slice(0, 300)
      );
    }
    return parts.join('');
  }

  function apiRequest(settings, messages, options) {
    options = options || {};
    let url;
    try {
      url = buildEndpoint(settings.baseUrl);
    } catch (error) {
      return Promise.reject(error);
    }
    const apiKey = String(settings.apiKey || '').trim();
    if (!apiKey) return Promise.reject(new Error('请先在设置里填写 API Key'));
    if (!settings.model) return Promise.reject(new Error('请先填写模型名称'));

    const body = {
      model: settings.model,
      messages: messages,
      temperature: Number(settings.temperature),
      max_tokens: Number(settings.maxTokens),
      stream: false
    };

    // 推理型模型默认关掉思考：这类任务要的是可运行的代码，不是推理过程。
    // 只在本脚本明确知道服务商支持时才加，避免不认这个字段的服务端直接 400。
    if (isReasoningModel(settings.model) && settings.disableThinking !== false) {
      body.enable_thinking = false;
      body.chat_template_kwargs = { enable_thinking: false };
    }

    const startedAt = Date.now();
    const promptChars = messages.reduce(function (sum, message) {
      return sum + String(message && message.content || '').length;
    }, 0);

    state.lastDiagnostics = {
      time: new Date().toLocaleString(),
      url: url,
      model: settings.model,
      key: maskKey(apiKey),
      status: null,
      response: '',
      error: '',
      ms: 0,
      promptChars: promptChars,
      maxTokens: Number(settings.maxTokens) || 0,
      finishReason: '',
      completionTokens: 0
    };

    return new Promise(function (resolve, reject) {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      };

      function note(status, text, error) {
        const d = state.lastDiagnostics;
        if (!d) return;
        d.status = status;
        d.response = String(text || '').slice(0, 1000);
        d.error = error || '';
        d.ms = Date.now() - startedAt;

        // 顺带把判定"为什么空"最关键的两个字段记下来，
        // 用户复制诊断时能直接看到 finish_reason 是不是 length。
        try {
          const parsed = JSON.parse(text);
          const choice = parsed && parsed.choices && parsed.choices[0];
          d.finishReason = (choice && choice.finish_reason) || '';
          d.completionTokens = Number(parsed && parsed.usage && parsed.usage.completion_tokens) || 0;
        } catch (e) {
          // 非 JSON 响应不用记这两项
        }
      }

      // 错误里带上真正请求的地址和状态码，避免"不知道打到了哪台服务器"
      function fail(message, status, text) {
        note(status, text, message);
        const code = status ? 'HTTP ' + status + ' · ' : '';
        reject(new Error(message + '（' + code + shortEndpoint(url) + '）'));
      }

      function handleResponse(status, text) {
        let data = null;
        try {
          data = JSON.parse(text);
        } catch (e) {
          fail(
            status >= 200 && status < 300
              ? '接口返回的不是 JSON'
              : '接口返回了非 JSON 内容：' + String(text).slice(0, 200),
            status,
            text
          );
          return;
        }

        if (status < 200 || status >= 300) {
          const message =
            (data && data.error && data.error.message) ||
            (data && data.message) ||
            ('HTTP ' + status);
          fail(String(message).slice(0, 300), status, text);
          return;
        }

        if (data && data.error) {
          fail(String(data.error.message || JSON.stringify(data.error)).slice(0, 300), status, text);
          return;
        }

        const choice = data && data.choices && data.choices[0];
        const content = extractMessageContent(choice && choice.message) || (choice && choice.text) || '';
        if (!content.trim()) {
          // 思维链有内容但答案为空：先把思维链当答案兜底，总比"什么都没有"强，
          // 同时明确告知用户这是兜底结果。真·全空才报错。
          const salvaged = salvageEmptyContent(choice, data);
          const message = describeEmptyContent(status, text, data, body.max_tokens);
          const error = new Error(message + (salvaged
            ? '（已把思维链内容临时作为答案显示，请自行判断是否可用）'
            : ''));
          error.emptyContent = true;
          error.reasoningChars = String(salvaged || '').length;
          error.salvaged = salvaged;
          error.finishReason = choice && choice.finish_reason;
          note(status, text, message);
          if (salvaged) {
            resolve(salvaged);
            return;
          }
          reject(error);
          return;
        }
        note(status, text, '');
        resolve(content);
      }

      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          const request = GM_xmlhttpRequest({
            method: 'POST',
            url: url,
            headers: headers,
            data: JSON.stringify(body),
            timeout: options.timeout || 300000,
            onload: function (response) {
              handleResponse(response.status, response.responseText);
            },
            onerror: function () {
              fail('网络请求失败：可能是 Base URL 错误、CORS、域名未授权或网络不通', null, '');
            },
            ontimeout: function () {
              fail('请求超时（' + Math.round((options.timeout || 300000) / 1000) + ' 秒）', null, '');
            },
            onabort: function () {
              const error = new Error('已停止生成');
              error.name = 'AbortError';
              reject(error);
            }
          });
          if (typeof options.onRequest === 'function') {
            options.onRequest(request);
          }
        } catch (e) {
          fail('无法发起请求：' + e.message, null, '');
        }
        return;
      }

      // 非 Tampermonkey 环境（例如预览页）走 fetch
      fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
      })
        .then(function (response) {
          return response.text().then(function (text) {
            handleResponse(response.status, text);
          });
        })
        .catch(function (error) {
          fail('网络请求失败：' + error.message, null, '');
        });
    });
  }

  // ============================================================
  // 空内容自动重试
  // ============================================================
  // "HTTP 200 但 content 为空"不是配置错误，重试往往就好了；
  // 而且推理型模型固定会吃掉一部分预算，所以后续几次把 max_tokens 翻倍。
  // 只对"空内容"这一种错误重试 —— 401/404/余额不足重试一万次也没用。
  async function apiRequestWithRetry(settings, messages, options) {
    options = options || {};
    const maxAttempts = Math.max(1, options.retries === undefined ? 3 : options.retries);
    const baseTokens = Number(settings.maxTokens) || 8192;
    const baseTemperature = Number(settings.temperature) || 0;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // 第 n 次：max_tokens 按 1x / 2x / 4x 抬，封顶 32768
      const boosted = Math.min(baseTokens * Math.pow(2, attempt - 1), 32768);
      const attemptSettings = attempt === 1 ? settings : Object.assign({}, settings, {
        maxTokens: boosted,
        // 温度 0 时同样的输入容易得到同样的"卡住"，轻微抬高打破僵局
        temperature: Math.min(1, baseTemperature + 0.2 * (attempt - 1))
      });

      try {
        return await apiRequest(attemptSettings, messages, options);
      } catch (error) {
        lastError = error;
        if (!error.emptyContent || attempt >= maxAttempts) throw error;
        if (typeof options.onRetry === 'function') {
          // 回调要报「下一次真正会用」的预算，不能报这一次的。
          // 这一次是 base*2^(attempt-1)，下一次是 base*2^attempt。
          const nextTokens = Math.min(baseTokens * Math.pow(2, attempt), 32768);
          options.onRetry(attempt + 1, maxAttempts, nextTokens, error);
        }
        await sleep(400 * attempt);
      }
    }
    throw lastError || new Error('请求失败');
  }

  function buildUserPrompt(input) {
    const parts = ['请根据下面的信息给出完整答案。'];

    if (input.language) {
      parts.push('【语言】\n' + input.language);
    }
    if (input.task) {
      parts.push('【任务描述】\n' + input.task);
    }
    if (input.files && input.files.length) {
      // 把交付契约写成明确的清单，而不是一句"逐个输出"。
      // 模型最容易犯的三种偏离：只改一个文件、多输出编译命令/示例输出、
      // 自己发明文件名。清单逐条堵住这三种。
      const names = input.files.map(function (file, index) {
        return file.name || ('文件 ' + (index + 1));
      });
      if (input.files.length > 1) {
        parts.push([
          '【交付契约 · 必须严格遵守】',
          '本次只允许交付下面 ' + input.files.length + ' 个文件，一个不多、一个不少：',
          names.map(function (name, i) {
            return '  ' + (i + 1) + '. ' + name;
          }).join('\n'),
          '',
          '- 文件名必须与上面**逐字符一致**（大小写、扩展名、路径都不能改）。',
          '- 每个文件都要给出**完整可编译**的内容，不能只给改动片段，不能写"其余同上"。',
          '- **禁止**输出这 ' + input.files.length + ' 个文件以外的任何代码块：不要写编译命令、运行命令、Makefile（除非它本身就在列表里）、示例输出、测试用例、diff、或多个版本的重复代码。',
          '- 说明性文字可以写，但代码块只能有 ' + input.files.length + ' 个。'
        ].join('\n'));
      } else {
        parts.push([
          '【交付契约 · 必须严格遵守】',
          '本次只允许交付 1 个文件：' + names[0] + '。',
          '- 文件名与模板完全一致，不要改名。',
          '- 只输出**一个**代码块，内容是完整可编译的文件。',
          '- **禁止**额外输出编译命令、运行命令、示例输出、测试代码、diff 或第二份重复代码。'
        ].join('\n'));
      }

      parts.push('【模板代码】');

      input.files.forEach(function (file, index) {
        const name = file.name || ('文件 ' + (index + 1));
        const language = guessLanguage(file.code);
        const fence = language ? language.toLowerCase().replace('c++', 'cpp') : '';
        parts.push('文件：' + name + '\n```' + fence + '\n' + file.code + '\n```');
      });
    } else if (input.code) {
      parts.push('【模板代码】\n```\n' + input.code + '\n```');
    }
    if (input.sampleIn) {
      parts.push('【样例输入】\n```\n' + input.sampleIn + '\n```');
    }
    if (input.sampleOut) {
      parts.push('【样例输出】\n```\n' + input.sampleOut + '\n```');
    }

    // ===== SKILL 第 4/5 步：先验算样例，再交答案 =====
    // 这是"答案过不了测评"最直接的补救：逼模型在交付前自己走一遍样例。
    // 注意：验算过程**不要写进答案正文**（用户只要代码），
    // 只允许在最后用固定格式附一小段结果，脚本解析后自己展示结论。
    if (input.sampleIn || input.sampleOut) {
      parts.push([
        '【交付前必须先验算样例（但不要把验算过程写进答案）】',
        '在给出最终代码之前，自行用样例输入把代码完整走一遍，并**逐字符**比对样例输出：',
        '行尾空格、空行、中文标点、全角半角、表头、列顺序、输出顺序。',
        '如果对不上，**先改代码让它对上，再交答案**，不要交一个自己都知道有问题答案。',
        '',
        '把结论按下面这个固定格式放在**所有代码块之后**（只写结论，不要写推导过程）：',
        '```',
        '本地验证',
        '输入: <这段输入>',
        '实际输出: <你的代码真正会打印的内容>',
        '与样例一致: 是 / 否（不一致时说明第一处差异）',
        '```',
        '多个样例写多组。除这段之外，不要再写任何解释性文字。'
      ].join('\n'));
    }
    if (input.extra) {
      parts.push('【补充要求】\n' + input.extra);
    }

    // ===== 按测评反馈修正（SKILL 第 7 步）=====
    // 核心：把"我上次给的答案"和"平台说它错在哪"一起交给模型，
    // 并要求按固定优先级收敛，而不是从头重写 —— 重写很可能把原本对的部分也改坏。
    if (input.judge) {
      parts.push(
        '【重要】下面是我上一次提交的答案，它在平台测评里**没有通过**。请修正它，不要从头重写。'
      );

      if (input.judge.error) {
        parts.push('【测评报错原文】\n```\n' + input.judge.error + '\n```');
      }
      if (input.judge.expected) {
        parts.push('【预期输出】\n```\n' + input.judge.expected + '\n```');
      }
      if (input.judge.actual) {
        parts.push('【我的实际输出】\n```\n' + input.judge.actual + '\n```');
      }
      if (input.previousAnswer) {
        parts.push('【上一次的答案】\n' + input.previousAnswer);
      }

      parts.push([
        '【修正要求】按下面的优先级逐项核对，**只改真正有问题的地方**：',
        '1. 先看是不是符号命名不同（如 e/t vs A/B vs E 撇）——这类差异最容易全盘判错。',
        '2. 再看 ε / 空串标记是否一致（- vs ε vs 空字符串）。',
        '3. 再看表头、列顺序、空格数量、空行、全角半角标点。',
        '4. 再看产生式编号或输出顺序。',
        '5. 最后才考虑算法本身错了。',
        '',
        '**只影响格式的差异不要重写算法。**',
        '如果报错是"编译错误"，优先修类名/文件名/import/语法；',
        '如果是"运行错误"，优先查数组越界、空指针、indexOf 返回 -1；',
        '如果是"运行超时"，优先查死循环（尤其错误分支没 break）；',
        '如果是"只过部分样例"，优先补边界条件（空串、单元素、最大值）。',
        '',
        '输出格式照旧：先说明这次到底改了哪里、为什么；再给完整代码；最后列出仍不确定的点。'
      ].join('\n'));
    }

    parts.push(input.judge
      ? '请输出修正后的完整答案，严格遵守系统消息中的格式。'
      : '请直接输出答案，严格遵守系统消息中的格式。');
    return parts.join('\n\n');
  }

  function guessLanguage(code) {
    if (!code) return '';
    if (/public\s+(?:final\s+)?class|import\s+java\./.test(code)) return 'Java';
    if (/#include\s*<iostream>|using\s+namespace\s+std/.test(code)) return 'C++';
    if (/#include\s*<stdio\.h>|int\s+main\s*\(/.test(code)) return 'C';
    if (/^\s*(def|import|from)\s+\w+/m.test(code)) return 'Python';
    // 编译原理类：Bison/Yacc 与 Flex/Lex
    if (/^\s*%(?:token|left|right|nonassoc|type|union|start)\b/m.test(code)) return 'Bison（Yacc 语法文件）';
    if (/^\s*%option\b/m.test(code)) return 'Flex（Lex 词法文件）';
    return '';
  }

  // ============================================================
  // 页面抓取
  // ============================================================

  function getPageWindow(doc) {
    try {
      if (doc === document && typeof unsafeWindow !== 'undefined') {
        return unsafeWindow;
      }
      return doc.defaultView || window;
    } catch (e) {
      return window;
    }
  }

  function getDocuments() {
    const docs = [document];
    try {
      Array.from(document.querySelectorAll('iframe')).forEach(function (frame) {
        try {
          if (frame.contentDocument) docs.push(frame.contentDocument);
        } catch (e) {
          // 跨域 iframe 忽略
        }
      });
    } catch (e) {
      // 忽略
    }
    return docs;
  }

  // 从当前视口里读出「逐行落位」的信息。Monaco 虚拟滚动只渲染视口内的行，
// 而且开启自动换行（word wrap）时一条逻辑行会被渲染成多个 .view-line。
// 这两个事实叠加后有个很坑的细节：**行号槽只画在逻辑行的第一段上**，
// 续行的 top 处没有 .line-numbers 节点。如果按 top 精确匹配行号、匹配不到就退回
// index+1，续行会被当成一条新的逻辑行，行号整体错位、长行后半截还会覆盖前面的行。
// 用户看到的现象就是「长行在括号中间被折断」「文件行数比实际少」。
// 所以这里统一做三件事：① 行号按 top 向下继承给续行；② 同一行号的片段按 left/顺序拼接；
// ③ 返回按行号升序的逻辑行列表，由调用方决定怎么落位。
function collectMonacoLines(editor) {
    const rows = Array.from(editor.querySelectorAll('.view-lines .view-line'));
    if (!rows.length) return { lines: [], lineHeight: 19 };

    // 行号槽：每个 .line-numbers 的 top 与对应逻辑行首段的 top 一致
    const numbers = [];
    Array.from(editor.querySelectorAll('.margin-view-overlays .line-numbers')).forEach(function (node) {
      const top = parseFloat(node.style && node.style.top);
      const value = parseInt(String(node.textContent || '').trim(), 10);
      if (isFinite(top) && isFinite(value)) numbers.push({ top: top, value: value });
    });
    numbers.sort(function (a, b) { return a.top - b.top; });

    // 给定一个 top，取「top <= 该值」里最大的那个行号 —— 即向下继承
    function lineNoAt(top) {
      let found = null;
      for (let i = 0; i < numbers.length; i += 1) {
        if (numbers[i].top <= top + 1) {
          if (found === null || numbers[i].top > found.top) found = numbers[i];
        } else {
          break;
        }
      }
      return found ? found.value : null;
    }

    // 渲染顺序 = 文档顺序；同一逻辑行的片段天然相邻且 left 递增
    const ordered = rows.map(function (row, index) {
      return {
        index: index,
        top: parseFloat(row.style && row.style.top) || 0,
        left: parseFloat(row.style && row.style.left) || 0,
        text: row.innerText || row.textContent || ''
      };
    });
    ordered.sort(function (a, b) {
      if (a.top !== b.top) return a.top - b.top;
      if (a.left !== b.left) return a.left - b.left;
      return a.index - b.index;
    });

    let lineHeight = 0;
    let lastTop = null;
    const lines = [];
    let lastLineNo = null;
    ordered.forEach(function (row) {
      let lineNo = lineNoAt(row.top);
      if (lineNo === null) lineNo = lastLineNo === null ? 1 : lastLineNo + 1;

      if (lineNo === lastLineNo && lines.length) {
        // 续行：拼到同一逻辑行后面（不要加分隔符，折行处本就没有空格）
        lines[lines.length - 1].text += row.text;
        return;
      }
      lines.push({ lineNo: lineNo, text: row.text });
      lastLineNo = lineNo;

      if (lastTop !== null && row.top > lastTop && !lineHeight) lineHeight = row.top - lastTop;
      lastTop = row.top;
    });

    return { lines: lines, lineHeight: lineHeight || 19 };
  }

  // Monaco 虚拟滚动时，DOM 只渲染视口内的行。这里按「行号槽」把渲染出来的行拼回文本。
  // 行号槽（.line-numbers）给出的是真实行号，所以即使只渲染了一部分，也能知道每行原本在哪一位。
  // 返回 { text, total, holes }：holes 是被漏掉的行数，>0 说明内容不完整。
  function readMonacoViewLines(container) {
    if (!container) return { text: '', total: 0, holes: 0 };

    const editor = container.closest('.monaco-editor') || container;
    const collected = collectMonacoLines(editor);
    const entries = collected.lines;
    if (!entries.length) {
      const fallback = container.innerText || '';
      return { text: fallback, total: fallback ? fallback.split('\n').length : 0, holes: 0 };
    }

    // 按真实行号落位，缺的行留空
    const maxLine = entries[entries.length - 1].lineNo;
    // 必须从第 1 行开始补齐，而不是从当前屏的第一行（minLine）开始。
    // 从 minLine 开始会让"滚动到第 51 行"读出的 10 行看起来 holes=0、total=60，
    // 误判成完整内容，实际前 50 行全是丢的 —— 这是抓不全最隐蔽的一环。
    const lines = [];
    let holes = 0;
    let cursor = 1;
    entries.forEach(function (entry) {
      while (cursor < entry.lineNo) {
        lines.push('');
        holes += 1;
        cursor += 1;
      }
      lines.push(entry.text);
      cursor = entry.lineNo + 1;
    });

    return { text: lines.join('\n'), total: maxLine, holes: holes };
  }

  // 通过滚动把 Monaco 的完整内容逐屏读出来（虚拟滚动导致抓不全时使用）。
  // 原理：滚到顶部开始，一屏一屏往下滚，每屏都按行号把内容放到正确位置，
  // 直到行号覆盖到总行数或滚动到底。
  async function harvestMonacoByScroll(doc) {
    const editor = doc.querySelector('.monaco-editor');
    if (!editor) return null;

    const scroller = editor.querySelector('.monaco-scrollable-element') ||
      editor.querySelector('.overflow-guard') || editor;
    const container = editor.querySelector('.view-lines');
    if (!container) return null;

    const originalTop = scroller.scrollTop || 0;
    // covered 记录"这个行号真的读到了"（即使内容是空行，也算读到了）
    const covered = new Set();
    const collected = new Map();
    let maxLine = 0;
    let guard = 0;

    function snapshot() {
      // 直接复用 collectMonacoLines：它已经处理好「自动换行导致的续行」——
      // 续行按 top 继承行号、同号片段拼接、按 lineNo 升序输出。
      const { lines, lineHeight } = collectMonacoLines(editor);
      if (!lines.length) return 0;

      lines.forEach(function (entry) {
        const lineNo = entry.lineNo;
        const text = entry.text;

        // 只有"首次读到"才写入，避免后续屏覆盖已有内容；
        // 但如果这次拼出来的明显更完整（续行这屏才渲染出来），就用更长的替换。
        if (!covered.has(lineNo)) {
          covered.add(lineNo);
          collected.set(lineNo, text);
        } else {
          const previous = collected.get(lineNo) || '';
          if (text.length > previous.length) collected.set(lineNo, text);
        }
        if (lineNo > maxLine) maxLine = lineNo;
      });

      return lineHeight || 19;
    }

    try {
      // 回到顶部，保证从第 1 行开始扫
      scroller.scrollTop = 0;
      await sleep(160);
      let lineHeight = snapshot();

      const viewport = scroller.clientHeight || 400;
      const pageStep = Math.max(lineHeight * 3, Math.floor(viewport - lineHeight * 2));

      for (; guard < 80; guard += 1) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + pageStep;
        await sleep(160);

        const moved = scroller.scrollTop > before;
        lineHeight = snapshot() || lineHeight;
        if (!moved) break;
      }

      if (!maxLine) return null;

      // 按 1..maxLine 拼回；用 covered 判断缺口，空行不算缺口
      const lines = [];
      let holes = 0;
      for (let i = 1; i <= maxLine; i += 1) {
        if (covered.has(i)) {
          lines.push(collected.get(i) || '');
        } else {
          lines.push('');
          holes += 1;
        }
      }

      // 末尾若有连续未覆盖的行，说明没滚到底，去掉它们避免产生大段空行
      while (lines.length && !covered.has(lines.length)) {
        lines.pop();
        holes -= 1;
      }

      return { text: lines.join('\n'), total: lines.length, holes: Math.max(0, holes) };
    } catch (e) {
      return null;
    } finally {
      try {
        scroller.scrollTop = originalTop;
      } catch (e) {
        // 忽略
      }
    }
  }

  // ============================================================
  // 通用滚动抓取：不依赖具体编辑器实现
  // 很多编辑器（自研 contenteditable、CodeMirror 6、Monaco）都是虚拟滚动，
  // DOM 里只有视口内那一段。唯一可靠的办法是：找它的滚动容器，从顶部逐屏往下滚，
  // 每屏读一次可见文本，再用「后缀 == 下一屏前缀」找重叠、拼成全文。
  // ============================================================

  // 找到元素最近的可滚动祖先（overflow 为 auto/scroll 且内容真的溢出）
  function findScrollableAncestor(element) {
    let node = element && element.parentElement;
    let guard = 0;
    while (node && guard < 12) {
      guard += 1;
      try {
        const style = window.getComputedStyle(node);
        const oy = style.overflowY;
        const scrollable = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
          node.scrollHeight > node.clientHeight + 4;
        if (scrollable) return node;
      } catch (e) {
        // 忽略
      }
      node = node.parentElement;
    }
    return null;
  }

  // 把多屏文本按「最长后缀 == 下一屏前缀」合并，去掉重复衔接部分。
  // 以行为单位匹配（题目代码里空行、缩进很常见，按字符匹配容易错位）。
  function mergeOverlappingText(chunks) {
    const screens = (chunks || []).filter(function (text) {
      return text && text.trim();
    }).map(function (text) {
      // 去掉每屏首尾的空行，避免误判重叠
      return text.replace(/^\n+/, '').replace(/\n+$/, '');
    });
    if (!screens.length) return '';
    if (screens.length === 1) return screens[0];

    let mergedLines = screens[0].split('\n');

    for (let i = 1; i < screens.length; i += 1) {
      const nextLines = screens[i].split('\n');
      if (!nextLines.length) continue;

      // 找最长重叠：mergedLines 的后 k 行 === nextLines 的前 k 行
      const maxK = Math.min(mergedLines.length, nextLines.length);
      let overlap = 0;
      for (let k = maxK; k > 0; k -= 1) {
        const tail = mergedLines.slice(mergedLines.length - k).join('\n');
        const head = nextLines.slice(0, k).join('\n');
        if (tail === head) {
          overlap = k;
          break;
        }
      }
      mergedLines = mergedLines.concat(nextLines.slice(overlap));
    }

    return mergedLines.join('\n');
  }

  // 通用滚动抓取。reader 返回"当前可见文本"。
  // 返回 { text, screens }，text 为合并后的全文。
  async function harvestByScrolling(scroller, reader) {
    if (!scroller || typeof reader !== 'function') return null;

    const original = scroller.scrollTop;
    const chunks = [];
    let guard = 0;

    try {
      scroller.scrollTop = 0;
      await sleep(160);

      // 用 scrollHeight / clientHeight 算出大概要滚几屏，据此定步长。
      // 步长取"一屏的 60%"能保证相邻两屏有足够重叠，合并时不会断行。
      const viewport = Math.max(60, scroller.clientHeight || 240);
      const total = Math.max(viewport, scroller.scrollHeight || viewport);
      const step = Math.max(40, Math.floor(viewport * 0.6));
      const expectedScreens = Math.min(400, Math.ceil(total / step) + 2);

      let lastTop = -1;
      let stuck = 0;
      while (guard < expectedScreens + 20 && guard < 500) {
        guard += 1;

        const text = reader();
        if (text && text.trim()) chunks.push(text);

        const before = scroller.scrollTop;
        scroller.scrollTop = before + step;
        await sleep(140);

        const after = scroller.scrollTop;

        // 位置完全没变：可能到底了，也可能是渲染没跟上，连试两次才放弃
        if (after === before) {
          stuck += 1;
          if (stuck >= 2) break;
          await sleep(200);
        } else {
          stuck = 0;
        }
        if (after === lastTop) break;
        lastTop = after;
      }

      // 关键：滚到最底部再读一次。
      // 上面循环是在"滚动前"读屏，滚到最后一个位置后内容还没被读过，
      // 漏掉的正是文件末尾那几行。
      try {
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(180);
        const tail = reader();
        if (tail && tail.trim()) chunks.push(tail);
      } catch (e) {
        // 忽略
      }

      return { text: mergeOverlappingText(chunks), screens: chunks.length };
    } catch (e) {
      return null;
    } finally {
      try {
        scroller.scrollTop = original;
      } catch (e) {
        // 忽略
      }
    }
  }

  // 针对一个"只读可见区域"的编辑器，尝试滚动读全。
  // element 是可见文本容器（contenteditable / .view-lines / .cm-content 等）。
  async function readWholeByScrolling(element, readVisible) {
    if (!element) return null;
    const scroller = findScrollableAncestor(element);
    if (!scroller) {
      // 自身可能就是滚动容器
      try {
        if (element.scrollHeight > element.clientHeight + 4) {
          return harvestByScrolling(element, readVisible || function () {
            return element.innerText || '';
          });
        }
      } catch (e) {
        // 忽略
      }
      return null;
    }
    return harvestByScrolling(scroller, readVisible || function () {
      return element.innerText || '';
    });
  }

  // 统一入口：给一个"不完整"的编辑器，尽力把全文读出来。
  // 依次尝试：① 它自己声明的滚动能力 ② Monaco 行号滚动 ③ 通用滚动重叠合并
  async function readEditorFully(editor) {
    if (!editor || !editor.partial) {
      try {
        return editor ? (editor.get() || '') : '';
      } catch (e) {
        return '';
      }
    }

    const baseline = (function () {
      try {
        return editor.get() || '';
      } catch (e) {
        return '';
      }
    })();

    // ① 编辑器自带的可见文本 + 滚动容器
    if (editor.scrollTarget && editor.readVisible) {
      try {
        const result = await readWholeByScrolling(editor.scrollTarget, editor.readVisible);
        if (result && result.text && result.text.length > baseline.length) {
          return result.text;
        }
      } catch (e) {
        // 继续尝试下一种
      }
    }

    // ② Monaco 行号精确滚动
    try {
      if (document.querySelector('.monaco-editor')) {
        const monaco = await harvestMonacoByScroll(document);
        if (monaco && monaco.text && monaco.text.length > baseline.length) {
          return monaco.text;
        }
      }
    } catch (e) {
      // 继续
    }

    // ③ 通用滚动（对任何虚拟滚动容器都适用）
    try {
      const host = document.querySelector('.monaco-editor .view-lines') ||
        document.querySelector('.cm-content') ||
        document.querySelector('[contenteditable="true"]');
      if (host) {
        const result = await readWholeByScrolling(host, function () {
          return host.innerText || '';
        });
        if (result && result.text && result.text.length > baseline.length) {
          return result.text;
        }
      }
    } catch (e) {
      // 忽略
    }

    return baseline;
  }

  function findEditorInDoc(doc) {
    const win = getPageWindow(doc);

    // Monaco
    try {
      const monaco = win.monaco;
      if (monaco && monaco.editor && typeof monaco.editor.getModels === 'function') {
        const models = monaco.editor
          .getModels()
          .filter(function (model) {
            try {
              return model && typeof model.getValue === 'function' && model.getValue().trim();
            } catch (e) {
              return false;
            }
          })
          .sort(function (a, b) {
            return b.getValue().length - a.getValue().length;
          });

        if (models.length) {
          const model = models[0];
          return {
            source: 'Monaco',
            get: function () {
              return model.getValue();
            },
            set: function (value) {
              model.setValue(value);
            }
          };
        }
      }
    } catch (e) {
      // 忽略
    }

    // Ace
    try {
      const aceElement = doc.querySelector('.ace_editor');
      if (aceElement && win.ace && typeof win.ace.edit === 'function') {
        const editor = win.ace.edit(aceElement);
        return {
          source: 'Ace',
          get: function () {
            return editor.getValue();
          },
          set: function (value) {
            editor.setValue(value, -1);
          }
        };
      }
    } catch (e) {
      // 忽略
    }

    // CodeMirror 5
    try {
      const cmElement = doc.querySelector('.CodeMirror');
      if (cmElement && cmElement.CodeMirror) {
        const cm = cmElement.CodeMirror;
        return {
          source: 'CodeMirror 5',
          get: function () {
            return cm.getValue();
          },
          set: function (value) {
            cm.setValue(value);
          }
        };
      }
    } catch (e) {
      // 忽略
    }

    // CodeMirror 6
    try {
      const cm6 = doc.querySelector('.cm-editor');
      const view = cm6 && (cm6.cmView && cm6.cmView.view ? cm6.cmView.view : cm6.view);
      if (view && view.state && view.state.doc) {
        return {
          source: 'CodeMirror 6',
          get: function () {
            return view.state.doc.toString();
          },
          set: function (value) {
            view.dispatch({
              changes: {
                from: 0,
                to: view.state.doc.length,
                insert: value
              }
            });
          }
        };
      }
    } catch (e) {
      // 忽略
    }

    // 普通 textarea
    try {
      const textareas = Array.from(doc.querySelectorAll('textarea')).filter(function (ta) {
        const rect = ta.getBoundingClientRect();
        return rect.width > 100 && rect.height > 50;
      });
      if (textareas.length) {
        const ta = textareas.sort(function (a, b) {
          return b.value.length - a.value.length;
        })[0];
        return {
          source: 'textarea',
          get: function () {
            return ta.value;
          },
          set: function (value) {
            ta.value = value;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
          }
        };
      }
    } catch (e) {
      // 忽略
    }

    // contenteditable 兜底：只读，避免误改编辑器内部状态。
    // 注意：很多平台的代码区就是 contenteditable + 虚拟滚动，innerText 只有可见那一段。
    // 必须标记 partial，并带上"滚动读全"的能力，否则上层会把残片当全文。
    try {
      const editables = Array.from(doc.querySelectorAll('[contenteditable="true"]'))
        .filter(function (element) {
          const rect = element.getBoundingClientRect();
          return rect.width > 120 && rect.height > 40;
        });
      // 选内容最长的那个（通常是代码区，而不是标题栏之类的可编辑框）
      editables.sort(function (a, b) {
        return (b.innerText || '').length - (a.innerText || '').length;
      });
      const editable = editables[0];
      if (editable) {
        const text = editable.innerText || '';
        if (text.trim()) {
          const scrollable = findScrollableAncestor(editable) ||
            (editable.scrollHeight > editable.clientHeight + 4 ? editable : null);
          return {
            source: 'contenteditable（只读）',
            // 有滚动条就说明 DOM 里不是全部内容
            partial: !!scrollable,
            scrollTarget: editable,
            readVisible: function () {
              return editable.innerText || '';
            },
            get: function () {
              return editable.innerText || '';
            },
            set: null
          };
        }
      }
    } catch (e) {
      // 忽略
    }

    // Monaco 可见区域兜底：只读。
    // 注意：Monaco 是虚拟滚动，.view-lines 里只有视口内的那几十行。
    // 把它当全文会得到"开头 + 结尾缺失"的残片 —— 这正是「模板抓不全」的直接原因。
    // 所以这里必须：① 标记 partial，让上层知道内容不完整；② 优先用行号拼出完整内容。
    try {
      const lines = doc.querySelector('.monaco-editor .view-lines');
      if (lines) {
        const partial = readMonacoViewLines(lines);
        if (partial.text.trim()) {
          return {
            source: 'Monaco 可见区域（不完整）',
            partial: true,
            get: function () {
              return partial.text;
            },
            set: null
          };
        }
      }
    } catch (e) {
      // 忽略
    }

    return null;
  }

  // ===== 文件名判定 =====
  // 这里分两层，原因：把"所有后缀"都塞进白名单必然会漏（tmpl、env、godir……列不完），
  // 而白名单太松又会让题面里的「1.5」被当成文件名、凭空多出文件页。
  // 所以：
  //   ① 白名单命中 → 直接算文件名（最常见的情况，最快最准）
  //   ② 没命中但形状像文件名 → 交给 looksLikeFileName 里的上下文检查

  // 第一层：确认为源码/文本/数据的扩展名（含编译原理、汇编、硬件描述等冷门类型）
  const CODE_FILE_EXT = 'java|c|h|cpp|cc|cxx|hpp|hh|hxx|c\\+\\+|py|pyw|pyi|ipynb|js|mjs|cjs|ts|mts|cts|jsx|tsx|vue|svelte|' +
    'go|rs|php|rb|cs|kt|kts|swift|scala|lua|pl|pm|r|m|mm|dart|hs|lhs|ml|mli|clj|cljs|ex|exs|erl|fs|fsi|vb|groovy|' +
    // 语法 / 词法定义（编译原理、语言实现）
    'y|yy|ypp|l|ll|lpp|g4|yacc|lex|' +
    // 汇编 / 链接脚本 / 硬件描述
    'asm|s|S|inc|ld|lds|v|sv|svh|vh|vhd|vhdl|' +
    // 构建
    'cmake|mk|makefile|gradle|pro|pri|ninja|bazel|bzl|sln|vcxproj|csproj|' +
    // 数据 / 配置 / 模板
    'sql|db|txt|text|json|jsonc|json5|yaml|yml|toml|ini|cfg|conf|properties|env|xml|xsd|xsl|plist|tmpl|tpl|' +
    'proto|thrift|graphql|' +
    // 文档 / 网页 / 样式
    'html|htm|xhtml|css|scss|sass|less|md|markdown|rst|tex|bib|adoc|org|' +
    // 脚本
    'sh|bash|zsh|fish|bat|cmd|ps1|vbs|awk|sed';

  // 第二层：没有好名字但形状像文件名的兜底。
  // 只允许「短、无空格、点不是小数、后缀不是纯数字」的 token，
  // 这样 `HelloWorld.tmpl` / `config.env` 能过，而「1.5」「3.1.4」「第2.3步」过不了。
  const LOOSE_FILE_NAME_RE = /^[\w][\w.\-]*\.[A-Za-z][A-Za-z0-9_+\-]{0,11}$/;

  const CODE_FILE_RE = new RegExp(
    '(^|[\\s/\\\\（(])([\\w.\\-]+\\.(?:' + CODE_FILE_EXT + '))$', 'i');

  // 严格判定：整串必须"就是一个文件名"，前面不许有中文说明。
  // 宽松版（CODE_FILE_RE）会把「请修改 Main.java」误认成文件名，是文件数量虚增的根源之一。
  const STRICT_FILE_NAME_RE = new RegExp('^[\\w.\\-]*(?:^|\\.)(?:' + CODE_FILE_EXT + ')$', 'i');

  // 没有扩展名但确实是源码文件的特例（Makefile、Dockerfile 这类）
  const BARE_FILE_NAME_RE = /^(?:Makefile|makefile|GNUmakefile|Dockerfile|Rakefile|Gemfile|Vagrantfile|CMakeLists\.txt|Cargo\.lock|go\.mod|go\.sum|requirements\.txt|\.gitignore|\.dockerignore|\.editorconfig|\.env)$/;

  // 后缀为这些的，即使形状像文件名也不要（生成物 / 压缩包 / 图片，不会是要编辑的模板）
  const IGNORED_EXT_RE = /\.(?:class|jar|war|ear|o|obj|so|dll|dylib|exe|out|bin|a|lib|pyc|pyo|whl|zip|tar|gz|tgz|bz2|xz|7z|rar|png|jpg|jpeg|gif|bmp|ico|svg|webp|pdf|doc|docx|xls|xlsx|ppt|pptx|mp3|mp4|avi|mov|ttf|otf|woff|woff2|eot|log|tmp|bak|swp)$/i;

  // 严格名判定：白名单命中，或（形状像 + 不在忽略列表里）
  function isKnownFileName(value) {
    const name = String(value || '').trim();
    if (!name) return false;
    if (BARE_FILE_NAME_RE.test(name)) return true;
    if (STRICT_FILE_NAME_RE.test(name)) return true;
    if (IGNORED_EXT_RE.test(name)) return false;
    return LOOSE_FILE_NAME_RE.test(name);
  }

  // 从一个可能夹着说明文字的字符串里，提取出真正的文件名。
  // 例如「请修改 Main.java」→「Main.java」，「src/main/java/Main.java 的实现」→「Main.java」。
  function extractFileNameToken(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    // 先按路径取末段：src/main/java/Main.java → Main.java
    const parts = text.split(/[\\/]/);
    const last = parts[parts.length - 1].trim();
    if (isKnownFileName(last)) return last;
    // 整串里挑最后一个像文件名的 token
    const matches = text.match(
      new RegExp('[\\w.\\-]+\\.(?:' + CODE_FILE_EXT + ')', 'gi'));
    if (!matches || !matches.length) return '';
    return matches[matches.length - 1];
  }

  function cleanFileName(value) {
    let name = String(value || '').trim();
    if (!name) return '';
    name = name.replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, '').trim();
    // 注意：这里必须提取 token，不能直接 split('/').pop()。
    // 「请修改 Main.java」整串会被当成文件名，导致滑框上显示中文长句、且和真实标签对不上。
    name = extractFileNameToken(name);
    if (!name || name.length > 80) return '';
    return name;
  }

  function looksLikeFileName(value) {
    const name = cleanFileName(value);
    return !!name && isKnownFileName(name);
  }

  // 从页面 DOM 里找文件名（文件树、标签页、data 属性）。
  // 很多平台一次只挂载当前打开的编辑器，这时这些名字是判断「实际有几个文件」的唯一线索。
  function collectFileNamesFromDom(doc) {
    const names = [];
    const seen = new Set();

    function push(value) {
      const name = cleanFileName(value);
      if (!looksLikeFileName(name)) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(name);
    }

    try {
      // 只认「明确是文件名」的属性。title / aria-label 是按钮和链接的提示文字
      // （比如「保存并运行 Main.java」），把它们当文件名会凭空多出文件页，这是数量对不上的主因。
      const required = ['[data-file]', '[data-filename]', '[data-path]', '[data-file-name]'];
      Array.from(doc.querySelectorAll(required.join(','))).forEach(function (element) {
        ['data-file', 'data-filename', 'data-path', 'data-file-name'].forEach(function (attr) {
          push(element.getAttribute(attr));
        });
      });

      // 文件树 / 标签页：只看叶子节点，避免把整块容器文字当文件名
      Array.from(doc.querySelectorAll(
        '[class*="file"], [class*="File"], [class*="tab"], [class*="tree"]'
      )).forEach(function (element) {
        if (element.children.length > 2) return;
        const text = String(element.textContent || '').trim();
        if (text && text.length <= 40) push(text);
      });
    } catch (e) {
      // 忽略
    }

    return names;
  }

  // 汇总主文档与同源 iframe 里的文件名，按文件名去重
  function detectPageFileNames() {
    return detectPageFileTabs().map(function (tab) { return tab.name; });
  }

  // 只取元素自身的直接文本节点，不含子元素文字。
// textContent 会把整块容器（含按钮、关闭图标）的文字拼在一起，导致标签判定失效。
  function elementOwnText(element) {
    if (!element) return '';
    let text = '';
    try {
      for (let i = 0; i < element.childNodes.length; i += 1) {
        const node = element.childNodes[i];
        if (node.nodeType === 3) text += node.nodeValue;
      }
    } catch (e) {
      return '';
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  // 找到「文件标签」元素本身，用于自动依次点击切换、逐个读取模板。
  // 只认真正像标签的节点：文本恰好是文件名，且尺寸像可点击项。
  function detectPageFileTabs() {
    const tabs = [];
    const seen = new Set();

    function consider(element, name) {
      const clean = cleanFileName(name);
      if (!looksLikeFileName(clean)) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      if (!element || !element.getBoundingClientRect) return;

      let rect;
      try {
        rect = element.getBoundingClientRect();
      } catch (e) {
        return;
      }
      // 只过滤不可见 / 明显是整块大容器的节点。
      // 注意不能限制宽度：块级标签（display:block 的 div/li）经常横向撑满整行。
      if (rect.width <= 0 || rect.height <= 0) return;
      if (rect.height > 120) return;
      if (rect.width * rect.height > window.innerWidth * window.innerHeight * 0.5) return;

      seen.add(key);
      tabs.push({ name: clean, element: element });
    }

    getDocuments().forEach(function (doc) {
      try {
        const candidates = Array.from(doc.querySelectorAll(
          '[data-file], [data-filename], [data-file-name], [role="tab"], ' +
          '[class*="file"], [class*="File"], [class*="tab"], [class*="Tab"], [class*="tree"], ' +
          'li, a, span, div'
        ));
        candidates.forEach(function (element) {
          if (element.children.length > 2) return;

          // 1) 明确声明文件名的属性，可信度最高
          const strongAttrs = ['data-file', 'data-filename', 'data-file-name'];
          for (let i = 0; i < strongAttrs.length; i += 1) {
            const value = element.getAttribute(strongAttrs[i]);
            if (value && looksLikeFileName(value)) {
              consider(element, value);
              return;
            }
          }

          // 2) 元素的直接文本必须"整个就是文件名"。
          //    不能用 cleanFileName 去抠 token —— 那会把「Main.java 已保存」也当成标签。
          const ownText = elementOwnText(element);
          if (ownText && ownText.length <= 40 && isKnownFileName(ownText)) {
            consider(element, ownText);
          }
        });
      } catch (e) {
        // 忽略
      }
    });

    return tabs.slice(0, 20);
  }

  function describeEditor(editor) {
    if (!editor) return '';
    return editor.name ? editor.name + '（' + editor.source + '）' : editor.source;
  }

  function findEditorsInDoc(doc) {
    const win = getPageWindow(doc);
    const editors = [];
    const domNames = collectFileNamesFromDom(doc);

    function withName(editor, index) {
      // 关键：不要按 domNames[index] 硬对应。
      // DOM 扫描顺序和编辑器/模型的顺序没有任何关系（模型按创建顺序，DOM 按文档流），
      // 按下标取名正是「文件数量和命名对不上」的直接原因。
      // 编辑器能自己给出名字时用它；给不出就留空，由 inferFileName 按代码内容推断，
      // 任何情况下都不要拿一个"别的文件的名字"来凑。
      editor.nameSource = editor.name ? 'editor' : '';
      if (!editor.name) {
        const own = extractFileNameToken(editor.rawName || '');
        if (own) {
          editor.name = own;
          editor.nameSource = 'editor';
        }
      }
      if (!editor.name) {
        try {
          const inferred = inferFileName(editor.get ? editor.get() : '');
          if (inferred) {
            editor.name = inferred;
            // 按代码内容猜出来的名字，不能拿它当"页面上确实有这个文件"的证据：
            // 猜错了就会把 A 文件的代码挂到 B 文件名下。
            editor.nameSource = 'inferred';
          }
        } catch (e) {
          // 忽略
        }
      }
      if (!editor.name) {
        editor.name = '文件 ' + (index + 1);
        editor.nameSource = 'placeholder';
      }
      return editor;
    }

    // Monaco：每个 model 就是一个文件
    try {
      const monaco = win.monaco;
      if (monaco && monaco.editor && typeof monaco.editor.getModels === 'function') {
        const models = monaco.editor.getModels() || [];
        // 多文件题里常有还没写内容的空模板，也要算进文件数量
        const keepEmptyModels = models.length > 1 && models.length <= 12;
        models.forEach(function (model, index) {
          try {
            if (!model || typeof model.getValue !== 'function') return;
            const value = model.getValue();

            let name = '';
            try {
              const uri = model.uri;
              const path = uri && (uri.path || uri.fsPath);
              if (path && CODE_FILE_RE.test(' ' + cleanFileName(path))) {
                name = cleanFileName(path);
              }
            } catch (e) {
              // 忽略
            }

            // 空文件但有真实文件名、或属于多文件题的空模板时保留
            if (!value.trim() && !name && !keepEmptyModels) return;

            editors.push(withName({
              source: 'Monaco',
              name: name,
              keepEmpty: keepEmptyModels && !value.trim(),
              get: function () {
                return model.getValue();
              },
              set: function (next) {
                model.setValue(next);
              }
            }, index));
          } catch (e) {
            // 忽略
          }
        });
      }
    } catch (e) {
      // 忽略
    }

    if (editors.length) return editors;

    // Ace：每个 .ace_editor 可能对应一个文件
    try {
      const aceElements = Array.from(doc.querySelectorAll('.ace_editor'));
      if (aceElements.length && win.ace && typeof win.ace.edit === 'function') {
        aceElements.forEach(function (element, index) {
          try {
            const editor = win.ace.edit(element);
            const value = editor.getValue();
            if (!value || !value.trim()) return;
            let name = element.getAttribute('data-file') || element.getAttribute('data-filename') || '';
            if (!name) {
              const holder = element.closest('[data-file], [data-filename]');
              if (holder) name = holder.getAttribute('data-file') || holder.getAttribute('data-filename') || '';
            }
            editors.push(withName({
              source: 'Ace',
              name: cleanFileName(name),
              get: function () {
                return editor.getValue();
              },
              set: function (next) {
                editor.setValue(next, -1);
              }
            }, index));
          } catch (e) {
            // 忽略
          }
        });
      }
    } catch (e) {
      // 忽略
    }

    if (editors.length) return editors;

    // CodeMirror 5：每个 .CodeMirror 实例
    try {
      const cmElements = Array.from(doc.querySelectorAll('.CodeMirror'));
      cmElements.forEach(function (element, index) {
        try {
          const cm = element.CodeMirror;
          if (!cm || typeof cm.getValue !== 'function') return;
          const value = cm.getValue();
          if (!value || !value.trim()) return;
          editors.push(withName({
            source: 'CodeMirror 5',
            name: cleanFileName(element.getAttribute('data-file') || ''),
            get: function () {
              return cm.getValue();
            },
            set: function (next) {
              cm.setValue(next);
            }
          }, index));
        } catch (e) {
          // 忽略
        }
      });
    } catch (e) {
      // 忽略
    }

    if (editors.length) return editors;

    // CodeMirror 6：通常只暴露当前激活的 view
    try {
      const cm6Elements = Array.from(doc.querySelectorAll('.cm-editor'));
      cm6Elements.forEach(function (element, index) {
        try {
          const view = element.cmView && element.cmView.view ? element.cmView.view : element.view;
          if (!view || !view.state || !view.state.doc) return;
          const value = view.state.doc.toString();
          if (!value || !value.trim()) return;
          editors.push(withName({
            source: 'CodeMirror 6',
            name: cleanFileName(element.getAttribute('data-file') || ''),
            get: function () {
              return view.state.doc.toString();
            },
            set: function (next) {
              view.dispatch({
                changes: {
                  from: 0,
                  to: view.state.doc.length,
                  insert: next
                }
              });
            }
          }, index));
        } catch (e) {
          // 忽略
        }
      });
    } catch (e) {
      // 忽略
    }

    if (editors.length) return editors;

    // 普通 textarea：页面上可能有多个代码框
    try {
      const textareas = Array.from(doc.querySelectorAll('textarea')).filter(function (ta) {
        const rect = ta.getBoundingClientRect();
        return rect.width > 100 && rect.height > 50;
      });

      textareas.forEach(function (ta, index) {
        if (!ta.value || !ta.value.trim()) return;
        let name = ta.getAttribute('data-file') || ta.getAttribute('data-filename') || '';
        if (!name) {
          const holder = ta.closest('[data-file], [data-filename]');
          if (holder) name = holder.getAttribute('data-file') || holder.getAttribute('data-filename') || '';
        }
        editors.push(withName({
          source: 'textarea',
          name: cleanFileName(name),
          get: function () {
            return ta.value;
          },
          set: function (next) {
            ta.value = next;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, index));
      });
    } catch (e) {
      // 忽略
    }

    if (editors.length) return editors;

    // 兜底：只读识别（contenteditable / Monaco 可见区域）
    try {
      const single = findEditorInDoc(doc);
      if (single) {
        single.name = domNames[0] || '文件 1';
        editors.push(single);
      }
    } catch (e) {
      // 忽略
    }

    return editors;
  }

  function findEditors() {
    const editors = [];
    const seen = new Set();

    getDocuments().forEach(function (doc) {
      findEditorsInDoc(doc).forEach(function (editor) {
        let code = '';
        try {
          code = editor.get() || '';
        } catch (e) {
          code = '';
        }
        // 空文件只在有真实文件名或标记为多文件空模板时保留
        if (!code.trim() && !looksLikeFileName(editor.name) && !editor.keepEmpty) return;

        const key = (editor.name || '').toLowerCase() + '\u0000' + code;
        if (seen.has(key)) return;
        seen.add(key);

        editors.push(editor);
      });
    });

    return editors;
  }

  function findEditor() {
    const editors = findEditors();
    if (!editors.length) return null;

    function lengthOf(editor) {
      try {
        return (editor.get() || '').trim().length;
      } catch (e) {
        return 0;
      }
    }

    // 单文件回填时优先选内容最多的编辑器，避免误选页面上的空 textarea
    return editors.slice().sort(function (a, b) {
      return lengthOf(b) - lengthOf(a);
    })[0];
  }

  function extractTaskTextFromDoc(doc) {
    const keywords = ['任务描述', '编程要求', '测试说明', '实验步骤', '相关知识'];
    const candidates = [];

    function push(text, weight) {
      const normalized = String(text || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (normalized.length >= 80) {
        candidates.push({ text: normalized, weight: weight || 0 });
      }
    }

    const selectors = [
      '[class*="task-content"]',
      '[class*="taskContent"]',
      '[class*="task_detail"]',
      '[class*="taskDetail"]',
      '[class*="markdown"]',
      '[class*="rich-text"]',
      '[class*="problem"]',
      '[class*="subject"]',
      'article',
      'main'
    ];

    selectors.forEach(function (selector) {
      try {
        Array.from(doc.querySelectorAll(selector)).forEach(function (element) {
          const text = element.innerText || '';
          if (text.length > 200 && keywords.some(function (k) { return text.includes(k); })) {
            push(text, 20);
          }
        });
      } catch (e) {
        // 忽略
      }
    });

    // 通过“任务描述”等标题向上找容器
    try {
      Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,div,span,p')).forEach(function (element) {
        if (element.children.length > 2) return;
        const text = (element.innerText || '').trim();
        if (!text || text.length > 30) return;
        if (!keywords.some(function (k) { return text.includes(k); })) return;

        let parent = element.parentElement;
        for (let depth = 0; depth < 5 && parent; depth++, parent = parent.parentElement) {
          const parentText = parent.innerText || '';
          if (parentText.length > 300 && parentText.length < 50000) {
            push(parentText, 30 - depth);
            break;
          }
        }
      });
    } catch (e) {
      // 忽略
    }

    // 整页兜底
    if (doc.body) {
      push(doc.body.innerText, 0);
    }

    // 去重
    const seen = new Set();
    const unique = [];
    candidates.forEach(function (candidate) {
      const key = candidate.text.slice(0, 120);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(candidate);
      }
    });

    unique.sort(function (a, b) {
      return b.weight - a.weight || b.text.length - a.text.length;
    });

    if (!unique.length) return null;

    const best = unique[0];
    const keywordCount = keywords.reduce(function (count, keyword) {
      return count + (best.text.includes(keyword) ? 1 : 0);
    }, 0);

    return {
      text: best.text,
      score: keywordCount * 1000 + best.weight * 10 + Math.min(best.text.length, 20000)
    };
  }

  function extractTaskText() {
    let best = null;
    getDocuments().forEach(function (doc) {
      const candidate = extractTaskTextFromDoc(doc);
      if (candidate && (!best || candidate.score > best.score)) {
        best = candidate;
      }
    });
    return truncateText(best ? best.text : '', MAX_TASK_CHARS);
  }

  // ===== 从题面里自动拆出样例输入/输出 =====
  // SKILL 第 1 步要求"锁定判题契约"，其中样例是最容易被忽略的一项。
  // 头歌题面常见写法：
  //   测试说明
  //   输入: 5
  //   输出: 15
  //   或者一个 ```  代码块里先输入后输出
  // 抓不到也不报错，只是留空让用户自己填 —— 不要为了"显得聪明"去猜错样例。
  function extractSamplesFromTaskText(text) {
    const result = { input: '', output: '' };
    if (!text || typeof text !== 'string') return result;

    const src = text.replace(/\r/g, '');

    // 方式一：显式的「输入：xxx  输出：yyy」标签（全角/半角冒号都认）
    // 注意：label 里可能含 |，必须整体包一层 (?:...)，
    // 否则 `(?:样例)?输出|预期输出` 会被 | 拆成两个分支，
    // 前一个分支没有捕获组，match[1] 就是 undefined —— 这里踩过一次。
    function grabByLabel(label) {
      const re = new RegExp(
        '(?:' + label + ')' + '\\s*[:：]\\s*([^\\n]+(?:\\n(?![\\u4e00-\\u9fa5]*\\s*[:：])[^\\n]*)*)');
      const match = src.match(re);
      return match && match[1] ? match[1].trim() : '';
    }

    const inByLabel = grabByLabel('(?:样例)?输入');
    const outByLabel = grabByLabel('(?:样例)?输出|预期输出');
    if (inByLabel || outByLabel) {
      result.input = inByLabel;
      result.output = outByLabel;
      return result;
    }

    // 方式二：「输入」和「输出」各自后面紧跟一个独立的示例块
    const chunks = src.split(/\n{2,}/);
    let pendingInput = '';
    chunks.forEach(function (chunk) {
      const trimmed = chunk.trim();
      if (!trimmed) return;
      if (/^(?:样例)?输入\s*[:：]?\s*$/.test(trimmed.split('\n')[0])) {
        pendingInput = trimmed.split('\n').slice(1).join('\n').trim();
        return;
      }
      if (/^(?:样例)?输出\s*[:：]?\s*$/.test(trimmed.split('\n')[0]) && pendingInput) {
        result.input = pendingInput;
        result.output = trimmed.split('\n').slice(1).join('\n').trim();
        pendingInput = '';
      }
    });

    return result;
  }

  function grabTask(silent) {
    const text = extractTaskText();
    if (!text) {
      if (!silent) setStatus('没有抓到题目文本，请手动粘贴', 'warn');
      return false;
    }

    const field = $('#taskText');
    if (!field) return false;
    if (field.value.trim() && !silent && !confirmAction('任务描述已有内容，是否覆盖？')) {
      return false;
    }

    field.value = text;

    // 顺带把样例拆出来填进「更多输入」——很多人不知道样例要单独填，
    // 结果模型只能靠猜输出格式，这是答案对不上的常见原因之一。
    const samples = extractSamplesFromTaskText(text);
    const sampleInField = $('#sampleIn');
    const sampleOutField = $('#sampleOut');
    let filledSample = 0;
    if (samples.input && sampleInField && !sampleInField.value.trim()) {
      sampleInField.value = samples.input;
      filledSample += 1;
    }
    if (samples.output && sampleOutField && !sampleOutField.value.trim()) {
      sampleOutField.value = samples.output;
      filledSample += 1;
    }

    if (!silent) {
      const extra = filledSample ? '，并自动填了 ' + filledSample + ' 项样例' : '';
      setStatus('已抓取题目（' + text.length + ' 字）' + extra + '，请检查是否完整', 'ok');
    }
    return true;
  }

  function nextFileId() {
    state.fileSeq += 1;
    return 'file-' + state.fileSeq;
  }

  function hasAnyCode() {
    return state.files.some(function (file) {
      return (file.code || '').trim();
    });
  }

  function inferFileName(code) {
    if (!code) return '';
    const javaClass = code.match(/\bpublic\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (javaClass) return javaClass[1] + '.java';
    if (/\bint\s+main\s*\(/.test(code)) {
      if (/^\s*#include\s*<iostream>/m.test(code)) return 'main.cpp';
      if (/^\s*#include\s*<stdio\.h>/m.test(code)) return 'main.c';
      return 'main.c';
    }
    if (/^\s*(?:def|class)\s+\w+/m.test(code) && /:\s*(?:$|\n)/.test(code)) return 'main.py';
    // 编译原理：Bison / Yacc 语法定义文件
    if (/^\s*%token\b/m.test(code) || /^\s*%left\b/m.test(code) || /^\s*%%\s*$/m.test(code)) {
      return 'parser.y';
    }
    // 编译原理：Flex / Lex 词法定义文件
    if (/^\s*%option\b/m.test(code) || (/^\s*%%\s*$/m.test(code) && /\{[\s\S]*return\s+[A-Z_]+\s*;/.test(code))) {
      return 'lexer.l';
    }
    return '';
  }

  // origin: blank（占位）/ manual（用户手动添加或改过）/ grabbed（脚本抓取）/ placeholder（按页面文件名补齐）
  function ensureOneFileCard() {
    if (!state.files.length) {
      state.files.push({ id: nextFileId(), name: '', code: '', origin: 'blank' });
    }
  }

  function isPendingFile(file) {
    return !!file && !(file.code || '').trim() &&
      (file.origin === 'placeholder' || file.origin === 'blank');
  }

  function sameFileName(a, b) {
    const norm = function (value) {
      return cleanFileName(value).toLowerCase();
    };
    const left = norm(a);
    const right = norm(b);
    return !!left && !!right && (left === right);
  }

  // 判断两段代码是不是"同一个文件的两份抓取结果"（其中一份可能只抓到一部分）。
  // 只做前缀/后缀重叠是不够的：虚拟滚动残片可能从中间断开，也可能前后都断。
  // 做法：短的那份按行切片，看有多少片能在长的那份里原样找到。
  function isLikelySameCode(a, b) {
    const left = String(a || '').trim();
    const right = String(b || '').trim();
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.indexOf(right) >= 0 || right.indexOf(left) >= 0) return true;

    const shortText = left.length <= right.length ? left : right;
    const longText = left.length <= right.length ? right : left;
    const shortLines = shortText.split('\n');
    const longSet = new Set(longText.split('\n').map(function (line) { return line.trim(); }));

    // 只看有实质内容的行（`}`、空行这类到处都有的行不能作为证据）
    const meaningful = shortLines.filter(function (line) {
      const text = line.trim();
      return text.length >= 6 && text !== '}' && text !== '});' && text !== '};';
    });
    if (!meaningful.length) {
      // 短文本没有足够的特征行：用首行做最后一道判断
      return longSet.has(shortLines[0].trim());
    }

    let hit = 0;
    meaningful.forEach(function (line) {
      if (longSet.has(line.trim())) hit += 1;
    });
    return hit / meaningful.length >= 0.8;
  }

  function currentFile() {
    ensureOneFileCard();
    state.activeFile = clamp(state.activeFile, 0, state.files.length - 1);
    return state.files[state.activeFile];
  }

  function shortFileName(name, index) {
    const clean = cleanFileName(name);
    if (!clean) return '文件 ' + (index + 1);
    const base = clean.split(/[\\/]/).pop() || clean;
    return base.length > 20 ? base.slice(0, 17) + '…' : base;
  }

  // 切换当前查看的模板文件。direction: 1 向右、-1 向左、0 不播放动画
  function showFileAt(index, direction) {
    ensureOneFileCard();
    const next = clamp(index, 0, state.files.length - 1);
    if (next === state.activeFile) return;
    state.activeFile = next;
    renderFiles();
    const viewport = $('#fileViewport');
    if (viewport && direction) {
      viewport.classList.remove('slide-from-left', 'slide-from-right');
      void viewport.offsetWidth;
      viewport.classList.add(direction > 0 ? 'slide-from-right' : 'slide-from-left');
    }
  }

  function addFileCard(name, code, origin) {
    state.files.push({
      id: nextFileId(),
      name: name || '',
      code: code || '',
      origin: origin || 'manual'
    });
    state.activeFile = state.files.length - 1;
    renderFiles();
    const field = $('#fileCode');
    if (field) field.focus();
  }

  function removeCurrentFile() {
    ensureOneFileCard();
    if (state.files.length <= 1) {
      state.files[0].name = '';
      state.files[0].code = '';
      state.files[0].origin = 'blank';
      renderFiles();
      return;
    }
    const index = state.activeFile;
    state.files.splice(index, 1);
    state.activeFile = clamp(index, 0, state.files.length - 1);
    renderFiles();
  }

  function renderFileCount() {
    const count = $('#fileCount');
    if (!count) return;
    const n = state.files.length;
    const pageCount = state.pageFileNames.length;
    if (pageCount > 1 && pageCount !== n) {
      count.textContent = n + ' / 页面 ' + pageCount + ' 个文件';
      count.title = '页面显示了 ' + pageCount + ' 个文件，当前列表只有 ' + n + ' 个';
    } else {
      count.textContent = n > 1 ? n + ' 个文件' : '';
      count.title = '';
    }
  }

  // 滑框：一次只显示一个文件，顶部文件名胶囊 + 左右箭头用于切换
  function renderFiles() {
    const tabs = $('#fileTabs');
    if (!tabs) return;

    ensureOneFileCard();
    state.activeFile = clamp(state.activeFile, 0, state.files.length - 1);

    tabs.innerHTML = '';
    let pendingCount = 0;
    state.files.forEach(function (file, index) {
      const pending = isPendingFile(file);
      if (pending) pendingCount += 1;
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'slider-tab' + (index === state.activeFile ? ' active' : '') + (pending ? ' pending' : '');
      tab.dataset.fileIndex = String(index);
      tab.title = (file.name || ('文件 ' + (index + 1))) + (pending ? '（待填：切到该文件后点「+ 追加当前编辑器」）' : '');
      tab.textContent = shortFileName(file.name, index);
      tabs.appendChild(tab);
    });

    const current = state.files[state.activeFile];
    const nameInput = $('#fileName');
    const codeInput = $('#fileCode');
    if (nameInput) nameInput.value = current.name || '';
    if (codeInput) codeInput.value = current.code || '';

    const counter = $('#fileCounter');
    if (counter) counter.textContent = (state.activeFile + 1) + ' / ' + state.files.length;

    const multiple = state.files.length > 1;
    const prev = $('#filePrev');
    const next = $('#fileNext');
    if (prev) prev.disabled = !multiple;
    if (next) next.disabled = !multiple;

    const nav = $('#fileNav');
    if (nav) nav.classList.toggle('single', !multiple);

    renderFileCount();

    const tip = $('#fileTip');
    if (tip) {
      tip.textContent = (pendingCount > 0 && state.files.length > 1)
        ? '还有 ' + pendingCount + ' 个待填文件：切到页面对应文件标签后点「+ 追加当前编辑器」'
        : '左右滑动 / ← → 键切换文件';
    }

    const activeTab = tabs.querySelector('.slider-tab.active');
    if (activeTab && activeTab.scrollIntoView) {
      try {
        activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch (e) {
        // 忽略
      }
    }
  }

  // 把抓到的文件合并进当前列表。
  // 规则：手动添加/编辑过的文件（origin=manual 且有代码）绝不覆盖；silent 模式下也不覆盖任何已有代码。
  function mergeCapturedFiles(captured, silent) {
    const stats = { added: 0, updated: 0, kept: 0 };

    captured.forEach(function (item) {
      let target = null;

      if (item.name) {
        target = state.files.find(function (file) {
          return sameFileName(file.name, item.name);
        }) || null;
      }
      if (!target && item.code.trim()) {
        target = state.files.find(function (file) {
          return (file.code || '').trim() === item.code.trim();
        }) || null;
      }
      // 单文件题的关键保护：已有一张卡的内容和本次抓取内容"高度重叠"，
      // 就说明它们来自同一个文件（上一轮滚动没读全的残片，这轮读全了），
      // 应该覆盖那一张，而不是再新建一张卡，否则内容会"翻倍"。
      // 注意不能用"互为子串"判断：两次抓取的截断位置不同时（70 行 / 100 行），
      // 前缀相同但都缺尾部，既不是子串也不相等，那样就会漏判。
      if (!target && item.code.trim()) {
        const incoming = item.code.trim();
        target = state.files.find(function (file) {
          const existing = (file.code || '').trim();
          if (!existing) return false;
          if (file.origin === 'manual') return false;
          return isLikelySameCode(existing, incoming);
        }) || null;
      }
      if (!target) {
        // 复用一张「无名字、无代码」的占位卡，避免凭空多出空白页
        target = state.files.find(function (file) {
          return !file.name && !(file.code || '').trim() && file.origin === 'blank';
        }) || null;
      }

      if (!target) {
        state.files.push({
          id: nextFileId(), name: item.name, code: item.code, origin: 'grabbed'
        });
        stats.added += 1;
        return;
      }

      const manual = target.origin === 'manual' && !!(target.code || '').trim();
      if (manual) {
        // 用户手动写的内容优先，只帮忙补上文件名
        if (!target.name && item.name) target.name = item.name;
        return;
      }
      if (silent && (target.code || '').trim() && target.code.trim() !== item.code.trim()) {
        return;
      }

      // 同一文件的两份内容：留住更完整的那份。
      // 滚动读取偶尔会被页面骨架干扰，返回的内容反而比已有的短，
      // 这时若直接覆盖，用户会觉得"越抓越少"。
      const existingCode = (target.code || '').trim();
      const incomingCode = (item.code || '').trim();
      const sameFile = !!existingCode && !!incomingCode && isLikelySameCode(existingCode, incomingCode);
      if (sameFile && existingCode.length >= incomingCode.length && existingCode !== incomingCode) {
        target.name = item.name || target.name;
        stats.updated += 1;
        return;
      }

      target.name = item.name || target.name;
      target.code = item.code;
      target.origin = 'grabbed';
      stats.updated += 1;
    });

    // 清掉多余的「无名字、无代码」占位卡，但保留至少一张
    for (let i = state.files.length - 1; i >= 0 && state.files.length > 1; i--) {
      const file = state.files[i];
      if (file.origin === 'blank' && !file.name && !(file.code || '').trim()) {
        state.files.splice(i, 1);
      }
    }

    // 单文件题：如果只抓到 1 个文件，就不该因为页面上零散的文件名线索
    // 留下一堆空白的「待填」页 —— 那会让用户以为抓到了多个文件。
    const grabbedCount = state.files.filter(function (file) {
      return (file.code || '').trim();
    }).length;
    if (grabbedCount === 1) {
      for (let i = state.files.length - 1; i >= 0 && state.files.length > 1; i--) {
        const file = state.files[i];
        const empty = !(file.code || '').trim();
        if (empty && file.origin !== 'manual') {
          state.files.splice(i, 1);
        }
      }
      state.activeFile = 0;
    }
    state.activeFile = clamp(state.activeFile, 0, Math.max(0, state.files.length - 1));

    // 被保护下来的手动文件（含这次抓取根本没匹配到的），用于状态栏反馈
    stats.kept = state.files.filter(function (file) {
      return file.origin === 'manual' && !!(file.code || '').trim();
    }).length;
    return stats;
  }

  // 平台只挂载当前打开的一个编辑器时，DOM 里的文件标签是文件数量的唯一线索。
  // 按这些名字补齐空白卡片，让滑框页数和实际文件数一致，用户再逐个切标签「追加当前编辑器」。
  function fillMissingFromDom(domNames) {
    // 单文件题不补齐：页面里零散出现的某个 .java 字样多半是题面文字，不是文件标签
    if (!domNames || domNames.length < 2 || domNames.length > 12) return [];
    const filled = [];

    domNames.forEach(function (name) {
      const exists = state.files.some(function (file) {
        return sameFileName(file.name, name);
      });
      if (exists) return;

      const blank = state.files.find(function (file) {
        return !file.name && !(file.code || '').trim() && file.origin !== 'manual';
      });
      if (blank) {
        blank.name = name;
        blank.origin = 'placeholder';
      } else {
        state.files.push({ id: nextFileId(), name: name, code: '', origin: 'placeholder' });
      }
      filled.push(name);
    });

    return filled;
  }

  // silent: 自动抓取（不弹确认、不覆盖已有代码）
  // forceReplace: 用户显式点「重新抓取（覆盖）」，整体替换
  async function grabCode(silent, forceReplace) {
    // 并发保护：面板打开 400ms 自动抓一次、1800ms 补抓一次，用户这时往往
    // 已经点了「抓取代码」。两个 grabCode 同时滚动读全、各自 merge 一次，
    // 就会在列表里留下两张内容不同、都不完整的卡 —— 这正是"抓到了但内容
    // 不全 + 文件数量对不上"的直接原因。同一时刻只允许一个在跑。
    if (state.busyGrab) return false;
    state.busyGrab = true;
    try {
      return await grabCodeInner(silent, forceReplace);
    } finally {
      state.busyGrab = false;
    }
  }

  async function grabCodeInner(silent, forceReplace) {
    const domNames = detectPageFileNames();
    const pageTabs = detectPageFileTabs();
    state.pageFileNames = domNames;

    const editors = findEditors();
    const multiTab = pageTabs.length > 1;

    if (!editors.length && !multiTab) {
      if (!silent) setStatus('未检测到编辑器，请手动粘贴代码', 'warn');
      return false;
    }

    // 多文件题且页面有多个标签：自动逐个切换，把所有模板都读出来
    let captured = [];
    const sources = [];
    let harvested = false;

    if (multiTab) {
      if (!silent) setStatus('正在逐个切换文件标签抓取模板…', '');
      try {
        const list = await harvestAllFiles(function (done, total, name) {
          if (!silent) setStatus('正在抓取第 ' + done + '/' + total + ' 个文件：' + name, '');
        });
        // 判据：只要收到了有名字的文件就采纳，不能要求"必须多于 1 个"。
        // 反例（真实存在）：两个标签内容完全相同，或点击标签不换内容时，
        // 只能收到 1 个文件；若这时判"收割失败"退回通用读取，就会额外
        // 产生一张没有名字的卡片，看起来像"多出一个文件、文件名和内容对不上"。
        const usable = list.filter(function (item) {
          return item.name && (item.code || '').trim();
        });
        if (usable.length) {
          captured = list;
          harvested = true;
          list.forEach(function (item) {
            if (item.source && sources.indexOf(item.source) < 0) sources.push(item.source);
          });
        }
      } catch (e) {
        // 抓取失败时退回单编辑器逻辑
      }
    }

    if (!harvested && !captured.length) {
      // 逐个编辑器读取；遇到"只读了可见区域"的编辑器，先尽力滚动读全
      if (!silent) setStatus('正在读取编辑器内容…', '');
      for (let i = 0; i < editors.length; i += 1) {
        const editor = editors[i];
        let code = '';
        try {
          code = editor.get() || '';
        } catch (e) {
          continue;
        }

        // 内容不完整就读全
        if (editor.partial) {
          if (!silent) setStatus('编辑器内容超出可视区域，正在滚动读取完整内容…', '');
          try {
            const full = await readEditorFully(editor);
            if (full && full.length >= code.length) {
              code = full;
              editor.partialResolved = true;
            }
          } catch (e) {
            // 保持原内容
          }
        }

        if (!code.trim() && !looksLikeFileName(editor.name) && !editor.keepEmpty) continue;

        let name = cleanFileName(editor.name);
        if (!name || /^文件\s*\d+$/.test(name)) {
          name = inferFileName(code) || (/^文件\s*\d+$/.test(name) ? '' : name);
        }

        captured.push({
          name: name,
          code: code,
          // 滚动后仍标记不完整，才提示用户
          partial: !!editor.partial && !editor.partialResolved,
          source: editor.source + (editor.partialResolved ? ' + 滚动读全' : '')
        });
        if (sources.indexOf(editor.source) < 0) sources.push(editor.source);
      }
    }

    // 只读到可见区域、滚动也补不全：必须明确告诉用户内容不完整，
    // 否则拿残片去生成答案，结果必然是错的，而用户以为抓到了全文。
    const partialFiles = captured.filter(function (item) { return item.partial; });
    if (partialFiles.length && !silent) {
      const detail = partialFiles.map(function (item) {
        return (item.name || '未命名') + '（' + item.code.split('\n').length + ' 行）';
      }).join('、');
      setStatus('编辑器只暴露了视口内的内容，抓到的是不完整的 ' + detail +
        '。请把编辑器滚动到底部再点一次「抓取代码」，或直接「+ 添加文件」手动粘贴完整代码。', 'warn');
    }

    if (!captured.length) {
      const filled = fillMissingFromDom(domNames);
      renderFiles();
      if (!silent) {
        setStatus(filled.length
          ? '编辑器内容为空；已按页面文件标签建好 ' + filled.length + ' 个空白文件：' + filled.join('、')
          : '编辑器内容为空，请手动粘贴代码', 'warn');
      }
      return filled.length > 0;
    }

    // 抓到的文件数少于页面标签数：说明有些标签点了没换出内容
    const missing = domNames.filter(function (name) {
      return !captured.some(function (item) { return sameFileName(item.name, name); });
    });

    let stats = { added: 0, updated: 0, kept: 0 };
    if (forceReplace) {
      if (!confirmAction('用页面上的 ' + captured.length + ' 个文件【整体覆盖】当前列表？手动添加或修改过的代码会被丢弃。')) {
        return false;
      }
      state.files = captured.map(function (item) {
        return { id: nextFileId(), name: item.name, code: item.code, origin: 'grabbed' };
      });
      state.activeFile = 0;
    } else {
      stats = mergeCapturedFiles(captured, !!silent);
    }

    const filled = fillMissingFromDom(domNames);
    state.activeFile = clamp(state.activeFile, 0, Math.max(0, state.files.length - 1));
    renderFiles();

    const languageField = $('#language');
    if (languageField && !languageField.value.trim()) {
      const language = guessLanguage(captured.map(function (file) { return file.code; }).join('\n'));
      if (language) languageField.value = language;
    }

    if (!silent) {
      const parts = [];
      if (forceReplace) {
        parts.push('已重新抓取并覆盖为 ' + captured.length + ' 个文件');
      } else {
        parts.push('已抓取 ' + captured.length + ' 个文件（' + sources.join(' / ') + '）' +
          (harvested ? '，自动切换了 ' + pageTabs.length + ' 个标签' : ''));
        if (stats.kept) parts.push('保留 ' + stats.kept + ' 个手动文件未覆盖');
      }
      if (domNames.length > 1) {
        parts.push(state.files.length > domNames.length
          ? '页面 ' + domNames.length + ' 个文件，当前列表 ' + state.files.length + ' 个（含手动添加）'
          : '页面共 ' + domNames.length + ' 个文件，当前列表 ' + state.files.length + ' 个');
      }
      if (missing.length) {
        parts.push('这些标签没读到内容：' + missing.join('、') + '（内容可能还没加载完，切过去后点「+ 追加当前编辑器」）');
      }
      if (filled.length) parts.push('仍缺：' + filled.join('、'));
      setStatus(parts.join('；'), missing.length ? 'warn' : 'ok');
    }
    return true;
  }

  function appendCurrentCode() {
    const editor = findEditor();
    if (!editor) {
      setStatus('未检测到编辑器', 'warn');
      return;
    }

    let code = '';
    try {
      code = editor.get() || '';
    } catch (e) {
      setStatus('读取编辑器失败：' + e.message, 'error');
      return;
    }

    if (!code.trim()) {
      setStatus('当前编辑器是空的，没有可追加的内容', 'warn');
      return;
    }

    const duplicate = state.files.some(function (file) {
      return (file.code || '').trim() === code.trim();
    });
    if (duplicate) {
      setStatus('当前编辑器的代码已经在文件列表里了（确认是否已切到另一个文件标签）', 'warn');
      return;
    }

    let name = cleanFileName(editor.name);
    if (!name || /^文件\s*\d+$/.test(name)) {
      name = inferFileName(code) || '';
    }

    // 优先填进「按页面文件名补齐」留下的空白页，避免又多出一张卡片
    let target = null;
    if (name) {
      target = state.files.find(function (file) {
        return sameFileName(file.name, name) && !(file.code || '').trim();
      }) || null;
    }
    if (!target && isPendingFile(state.files[state.activeFile])) {
      target = state.files[state.activeFile];
    }
    if (!target) target = state.files.find(isPendingFile) || null;

    if (target) {
      target.code = code;
      target.origin = 'manual';
      if (name && !target.name) target.name = name;
      state.activeFile = state.files.indexOf(target);
      renderFiles();
      setStatus('已填入「' + (target.name || ('文件 ' + (state.activeFile + 1))) + '」（' + editor.source + '）' +
        (target.name ? '' : '；请补上文件名'), 'ok');
      return;
    }

    addFileCard(name, code, 'manual');
    setStatus('已追加：' + (name || ('文件 ' + state.files.length)) + '（' + editor.source + '）', 'ok');
  }

  async function autoGrab() {
    // 自动抓取时也走"逐个标签"逻辑，页面一打开就把所有模板读齐
    const taskFilled = grabTask(true);
    let codeFilled = false;
    try {
      codeFilled = await grabCode(true);
    } catch (e) {
      codeFilled = false;
    }
    if (taskFilled || codeFilled) {
      setStatus('已尝试自动抓取，请检查题目和代码是否完整', '');
    }
  }

  function updateEditorHint() {
    const hint = $('#editorHint');
    if (!hint) return;
    const editors = findEditors();
    const pageNames = detectPageFileNames();
    state.pageFileNames = pageNames;
    const pageNote = pageNames.length > editors.length
      ? ' · 页面文件标签 ' + pageNames.length + ' 个'
      : '';
    if (editors.length) {
      const sources = [];
      editors.forEach(function (editor) {
        if (sources.indexOf(editor.source) < 0) sources.push(editor.source);
      });
      hint.textContent = '已检测：' + sources.join(' / ') +
        (editors.length > 1 ? ' × ' + editors.length + ' 个文件' : '') + pageNote;
      hint.classList.add('ok');
    } else {
      hint.textContent = '未检测到编辑器' + pageNote;
      hint.classList.remove('ok');
    }
    renderFileCount();
  }

  // ============================================================
  // 逐个文件标签自动抓取
  // ============================================================

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // 读取所有可见编辑器的代码，返回 { name, code } 列表（不依赖文件名推断）
  function readVisibleEditors() {
    const result = [];
    findEditors().forEach(function (editor) {
      let code = '';
      try {
        code = editor.get() || '';
      } catch (e) {
        return;
      }
      if (!code.trim()) return;
      result.push({
        editor: editor,
        code: code,
        source: editor.source,
        partial: !!editor.partial,
        name: cleanFileName(editor.name),
        // editor: 编辑器/模型自己报的名字（可信）
        // inferred: 按代码内容猜的（不可信，不能当"页面有这个文件"的证据）
        // placeholder: 「文件 N」这种占位名（完全不可信）
        nameSource: editor.nameSource || (editor.name ? 'editor' : '')
      });
    });
    return result;
  }

  // 编辑器内容指纹：用于判断"点了标签后界面是否真的换了"
  function editorSignature() {
    return readVisibleEditors().map(function (item) {
      return item.code.length + ':' + item.code.slice(0, 80);
    }).join('|');
  }

  async function waitForEditorChange(previousSignature, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 900);
    while (Date.now() < deadline) {
      await sleep(60);
      if (editorSignature() !== previousSignature) return true;
    }
    return false;
  }

  function clickTabElement(element) {
    if (!element || !element.isConnected) return false;
    try {
      const rect = element.getBoundingClientRect();
      const x = rect.left + Math.min(rect.width / 2, 20);
      const y = rect.top + rect.height / 2;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
        const Ctor = type.indexOf('pointer') === 0 && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        element.dispatchEvent(new Ctor(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: x, clientY: y, button: 0, buttons: type.indexOf('down') > 0 ? 1 : 0,
          pointerId: 1, pointerType: 'mouse', isPrimary: true
        }));
      });
      return true;
    } catch (e) {
      try {
        element.click();
        return true;
      } catch (err) {
        return false;
      }
    }
  }

  // 依次点击页面上的每个文件标签，把每个文件的内容都读出来。
  // 这是"平台一次只挂载一个编辑器"时唯一能抓全模板的办法。
  //
  // v1.8.1 核心修正：不能"按标签名找不到就取内容最多的那个编辑器"。
  // 那等于把 B 文件的代码强行挂在 A 文件名下 —— 正是用户反馈的
  // 「抓取的文件和每个文件的代码内容对不上」。现在改为：
  //   · 名字能对上（且名字是编辑器自己报的）→ 采用
  //   · 名字对不上但内容指纹能证明是同一个 → 采用
  //   · 都对不上 → 宁可不收这个文件，让它走 placeholder 留空待填，
  //     也绝不张冠李戴
  async function harvestAllFiles(onProgress) {
    const tabs = detectPageFileTabs();
    const collected = [];

    // 内容指纹 → 已经分配给哪个文件名。同一份内容绝不允许挂在两个文件名下，
    // 这是「名字与内容错配」的最后一道闸门。
    const contentOwner = new Map();

    function fingerprintOf(code) {
      const text = String(code || '').trim();
      if (!text) return '';
      // 用长度 + 首尾片段 + 中间片段组成指纹，避免长文件前缀相同误判
      const mid = text.slice(Math.floor(text.length / 2), Math.floor(text.length / 2) + 60);
      return text.length + '\u0000' + text.slice(0, 60) + '\u0000' + mid;
    }

    // 名字可信度：编辑器自己报的名字才可信；猜出来的、占位的都不算
    function isTrustedName(item) {
      return item.nameSource === 'editor' && !!item.name;
    }

    // absorb 必须是异步的：Monaco 虚拟滚动下，读到的只是视口内那几行，
    // 需要额外逐屏滚动才能拿到全文。若在这里同步收下，就会把残片当模板。
    async function absorb(name) {
      const editors = readVisibleEditors();
      if (!editors.length) return false;

      const cleanName = cleanFileName(name);

      // 1) 优先：编辑器自己报的名字和标签名一致
      let picked = cleanName
        ? editors.find(function (item) {
            return isTrustedName(item) && sameFileName(item.name, cleanName);
          })
        : null;

      // 2) 单编辑器且它没有可信名字 → 页面上就这一个编辑器，标签点到谁它就是谁。
      //    这是唯一允许"用标签名给无主内容命名"的情形。
      if (!picked && editors.length === 1 && !isTrustedName(editors[0])) {
        picked = editors[0];
      }

      // 3) 对不上就留空，交给 placeholder。「取内容最多的那个」这种兜底
      //    会把 B 文件的代码挂到 A 文件名下，正是用户报的错配。
      if (!picked) return false;

      let code = picked.code;
      let partial = !!picked.partial;
      let source = picked.source;

      // 虚拟滚动补全：用统一入口尽力读全（Monaco 行号滚 / contenteditable 通用滚 / 重叠合并）
      if (partial) {
        try {
          const full = await readEditorFully(picked.editor);
          if (full && full.length > code.length) {
            code = full;
            partial = false;
            source = picked.source + ' + 滚动读全';
          }
        } catch (e) {
          // 读不全就保留已读到的内容，并维持 partial 标记
        }
      }

      // 文件名：有标签名就用标签名；没有才用编辑器自己的名字
      const finalName = cleanName || picked.name || '';
      if (!finalName) return false;

      // 该文件名已经收过内容 → 只保留更完整的那份，不重复入列
      const key = finalName.toLowerCase();
      const existing = collected.find(function (item) {
        return item.name && item.name.toLowerCase() === key;
      });
      if (existing) {
        if (code.length > existing.code.length) {
          existing.code = code;
          existing.partial = partial;
          existing.source = source;
        }
        return false;
      }

      // 内容指纹闸门：这份内容已经挂到别的文件名下了，说明标签点击
      // 有可能没换内容。要么是同一个文件的别名（保留已收的），
      // 要么就是错配 —— 两种都不该再挂一遍。
      const fp = fingerprintOf(code);
      if (fp) {
        const owner = contentOwner.get(fp);
        if (owner && !sameFileName(owner, finalName)) return false;
        contentOwner.set(fp, finalName);
      }

      collected.push({
        name: finalName,
        code: code,
        source: source,
        partial: partial
      });
      return true;
    }

    // 1) 先收当前已经挂载的编辑器。
    //    这里不传空名字：此时还不知道当前显示的是哪个文件，
    //    若强收下来，后面点到同名标签时会重复；交给第 2 步按标签逐个收更准。
    const mounted = readVisibleEditors();
    const mountedTrusted = mounted.filter(isTrustedName);
    if (mountedTrusted.length) {
      // 编辑器自己报了名字，可以安全地按自己的名字收
      for (let i = 0; i < mountedTrusted.length; i += 1) {
        await absorb(mountedTrusted[i].name);
      }
    } else if (tabs.length === 0 && mounted.length === 1) {
      // 页面上没有可点的标签，只有孤零零一个没名字的编辑器：收下
      await absorb('');
    }

    // 2) 逐个点标签，等界面切换后再收
    for (let i = 0; i < tabs.length; i += 1) {
      const tab = tabs[i];
      if (onProgress) onProgress(i + 1, tabs.length, tab.name);
      const before = editorSignature();
      if (!clickTabElement(tab.element)) continue;

      // 标签可能与当前文件相同（点击后内容不变），稍等即可
      const changed = await waitForEditorChange(before, 900);
      if (!changed) await sleep(80);

      // 关键校验：点了这个标签，但内容完全没变，且这个内容的指纹已经
      // 挂在另一个文件名下 —— 说明点击没生效或平台只挂了一个编辑器。
      // 这时候绝不能把同一份内容当成新标签的内容。
      await absorb(tab.name);
    }

    // 3) 回到第一个标签，避免把用户停在最后一个文件
    if (tabs.length > 1 && tabs[0] && tabs[0].element) {
      clickTabElement(tabs[0].element);
      await sleep(120);
    }

    return collected;
  }

  // ============================================================
  // 答案渲染
  // ============================================================

  const CODE_LANGUAGES = [
    'java', 'c', 'cpp', 'c++', 'python', 'py', 'javascript', 'js',
    'typescript', 'ts', 'go', 'rust', 'php', 'ruby', 'csharp', 'cs',
    'kotlin', 'swift', 'scala', 'sql', 'html', 'css', 'shell', 'bash'
  ];

  const NON_CODE_LANGUAGES = [
    'diff', 'text', 'plain', 'output', 'input', 'console', 'log',
    '输入', '输出', '运行结果', '测试结果'
  ];

  // 编译/运行命令、终端会话，不是答案文件
  const SHELL_LANGUAGES = [
    'bash', 'sh', 'shell', 'zsh', 'shellsession', 'powershell', 'ps1', 'bat', 'cmd', 'terminal'
  ];

  function looksLikeShellSession(code) {
    const trimmed = String(code || '').trim();
    if (!trimmed) return false;
    // 真正的 shell 脚本（有 shebang 或文件名 .sh）不算命令块
    if (/^#!/.test(trimmed)) return false;

    const lines = trimmed.split('\n').filter(function (line) {
      return line.trim() && !line.trim().startsWith('#');
    });
    if (!lines.length) return false;

    const commandRe = /^\s*(?:[$>]|PS>)\s*\S|^\s*(?:javac|java|gcc|g\+\+|clang|clang\+\+|python3?|pip3?|node|npm|npx|yarn|pnpm|go|rustc|cargo|make|cmake|gdb|dotnet|mvn|gradle|git|cd|ls|dir|cat|type|echo|mkdir|rm|del|cp|copy|mv|move|touch|chmod|export|set)\b/i;
    return lines.every(function (line) {
      return commandRe.test(line);
    });
  }

  function isSourceCodeLanguage(language) {
    const lang = String(language || '').toLowerCase().trim();
    if (!lang) return false;
    if (SHELL_LANGUAGES.indexOf(lang) >= 0) return false;
    return CODE_LANGUAGES.some(function (item) {
      return lang === item || lang.split(/\s*\|\s*/).indexOf(item) >= 0;
    });
  }

  function normalizeCode(code) {
    return String(code || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(function (line) { return line.replace(/\s+$/, ''); })
      .join('\n')
      .trim();
  }

  function parseAnswerBlocks(answer) {
    const blocks = [];
    const re = /```([^\n`]*)\n([\s\S]*?)```/g;
    let match;
    let previousEnd = 0;

    while ((match = re.exec(answer))) {
      const info = (match[1] || '').trim();
      let lang = info;
      let name = '';

      const named = info.match(/(?:filename|file|name|路径)\s*[=:：]\s*([^\s`]+)/i);
      if (named) {
        name = cleanFileName(named[1]);
        lang = info.replace(named[0], '').trim();
      } else {
        const tokens = info.split(/\s+/).filter(Boolean);
        const fileToken = tokens.filter(function (token) {
          return looksLikeFileName(token);
        })[0];
        if (fileToken) {
          name = cleanFileName(fileToken);
          lang = tokens.filter(function (token) {
            return token !== fileToken;
          }).join(' ').trim();
        }
      }

      if (!name) {
        // 只在“上一个代码块结束到当前代码块开始”之间找，取最近的文件标题
        const gap = answer.slice(previousEnd, match.index);
        const headingRe = /(?:^|\n)[ \t#*>-]*(?:文件|文件名|file|filename)[ \t]*[:：]?[ \t]*`?([^\s`\n]+)`?[ \t]*(?=\n|$)/gi;
        let heading;
        let lastHeading = null;
        while ((heading = headingRe.exec(gap))) {
          lastHeading = heading;
        }
        if (lastHeading) name = cleanFileName(lastHeading[1]);
      }

      blocks.push({
        lang: lang,
        name: name,
        code: match[2].replace(/\s+$/, ''),
        start: match.index,
        end: re.lastIndex
      });

      previousEnd = re.lastIndex;
    }

    return blocks;
  }

  function isCodeBlock(block) {
    const language = String(block.lang || '').toLowerCase().trim();
    if (NON_CODE_LANGUAGES.some(function (item) { return language === item || language.indexOf(item) >= 0; })) {
      return false;
    }
    // 编译/运行命令不是答案文件
    if (SHELL_LANGUAGES.indexOf(language) >= 0) return false;
    if (looksLikeShellSession(block.code)) return false;

    if (isSourceCodeLanguage(language)) return true;
    if (block.name && /\.[a-z0-9]+$/i.test(block.name)) return true;
    return /\b(public|class|void|int|def|import|#include|function|return|for|while|struct|System\.out|printf|println)\b/.test(block.code);
  }

  // 同一份代码被模型切碎成多块（例如在类中间插了个说明）时合并回去
  function mergeFragmentedBlocks(blocks) {
    const merged = [];
    blocks.forEach(function (block) {
      const last = merged[merged.length - 1];
      if (!last) {
        merged.push(Object.assign({}, block));
        return;
      }
      const sameFile = last.name && block.name && last.name.toLowerCase() === block.name.toLowerCase();
      const sameLang = (last.lang || '').toLowerCase() === (block.lang || '').toLowerCase();
      const lastText = String(last.code || '').trim();
      const thisText = String(block.code || '').trim();

      // 判断依据：同文件同名 / 都无文件名同语言，且前一块明显没写完
      const looksUnfinished = lastText && !/[;}]$/.test(lastText) &&
        /^\s*(?:public|private|protected|static|final|class|void|int|String|return|\}|\/\/|\/\*|import|#|def |function )/.test(thisText);
      const sameName = sameFile || (!last.name && !block.name && sameLang);

      if (sameName && looksUnfinished) {
        last.code = lastText + '\n' + thisText;
        last.end = block.end;
        return;
      }
      merged.push(Object.assign({}, block));
    });
    return merged;
  }

  function extractAnswerFiles(answer) {
    const blocks = mergeFragmentedBlocks(parseAnswerBlocks(answer).filter(isCodeBlock));

    // 同一份代码重复输出（模型常见：完整版 + "再次确认"版）只保留第一份
    const seen = new Set();
    return blocks
      .filter(function (block) {
        const key = normalizeCode(block.code);
        if (!key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(function (block) {
        return {
          name: block.name || '',
          lang: block.lang || '',
          code: block.code
        };
      });
  }

  function extractMainCode(answer) {
    const blocks = mergeFragmentedBlocks(parseAnswerBlocks(answer).filter(isCodeBlock));
    if (!blocks.length) return '';

    function score(block) {
      const language = String(block.lang || '').toLowerCase();
      let value = block.code.length;

      if (isSourceCodeLanguage(language)) {
        value += 1000000;
      }
      if (/\b(public|class|void|int|def|import|#include|function|return|for|while|struct)\b/.test(block.code)) {
        value += 50000;
      }
      return value;
    }

    blocks.sort(function (a, b) {
      return score(b) - score(a);
    });
    return blocks[0].code;
  }

  // ============================================================
  // 模板契约对齐（v1.8.2）
  // ============================================================
  // 目标：答案的文件数、文件名、文件顺序**必须**和模板完全一致，
  // 多一个少一个都不行。只靠提示词约束模型是不够的（模型会多吐
  // 「编译命令」「示例输出」「再次确认版」），必须在解析层强制执行：
  //   · 按文件数对齐：以模板为准，多出来的丢弃，缺的标出来
  //   · 按文件名对齐：名字归一化后能对上的就改名，对不上的按顺序 + 内容特征兜底
  //   · 文件顺序对齐：滑框 tab 的顺序必须与模板一致

  // 模板里"算数的文件"：有代码的那些（空白占位页不算，否则会和答案对不上）
  function templateContract() {
    const files = state.files.filter(function (file) {
      return (file.code || '').trim();
    });
    return files.map(function (file, index) {
      return {
        name: (file.name || '').trim(),
        code: file.code,
        lang: guessLanguage(file.code),
        index: index
      };
    });
  }

  // 两个文件名是否指同一个文件。比 sameFileName 宽松一档：
  // 允许大小写差异、路径前缀差异（src/main/java/Main.java vs Main.java）。
  function isSameFileLoose(a, b) {
    const left = normalizeFileName(a);
    const right = normalizeFileName(b);
    if (!left || !right) return false;
    if (left === right) return true;
    const leftBase = left.split('/').pop() || left;
    const rightBase = right.split('/').pop() || right;
    return leftBase === rightBase;
  }

  // 在没有文件名可依据时，用代码内容猜这块属于模板的哪个文件。
  // 依据：语言一致 + 关键特征（类名 / 头文件名 / 函数名）出现。
  function scoreBlockAgainstTemplate(block, template) {
    let score = 0;
    const code = String(block.code || '');
    const target = String(template.code || '');

    if (!code.trim()) return -1;

    // 语言一致加分
    const blockLang = String(block.lang || '').toLowerCase();
    const templateLang = String(template.lang || '').toLowerCase();
    if (blockLang && templateLang && blockLang === templateLang) score += 20;

    // 文件名主干出现在代码里（Main.java → 代码里有 class Main）
    const stem = (template.name || '').replace(/\.[^.]+$/, '');
    if (stem && new RegExp('\\b' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(code)) {
      score += 40;
    }

    // #include 的头文件名对得上
    const headerMatch = target.match(/#include\s*[<"]([^>"]+)[>"]/);
    if (headerMatch && code.indexOf(headerMatch[1]) >= 0) score += 30;

    // 模板里独有的标识符（长度 ≥5，排除关键字）在答案里也出现
    const words = new Set();
    (target.match(/\b[A-Za-z_][A-Za-z0-9_]{4,}\b/g) || []).forEach(function (word) {
      if (!/^(?:public|private|protected|static|class|void|int|char|float|double|return|include|import|struct|const|using|namespace|stdio|stdlib|string|vector|while|for|else|switch|case|break|continue|define|ifndef|endif)$/.test(word)) {
        words.add(word);
      }
    });
    let hits = 0;
    words.forEach(function (word) {
      if (code.indexOf(word) >= 0) hits += 1;
    });
    if (words.size) score += Math.min(30, Math.round(30 * hits / words.size));

    return score;
  }

  // 把模型给的答案文件对齐到模板契约。返回 { files, report }
  // report 用于在状态栏/正文里如实告知用户对齐结果，绝不静默改。
  function alignAnswerToTemplate(answerFiles, templates) {
    const list = (answerFiles || []).filter(function (file) {
      return (file.code || '').trim();
    });
    const report = {
      aligned: true,
      dropped: [],       // 多出来、已丢弃的（人类可读描述）
      extras: [],        // 模板外的代码块（保留内容，但不占滑框）
      renamed: [],       // 改过名的
      missing: [],       // 模板有、答案缺的
      orderFixed: false
    };

    if (!templates || !templates.length) {
      return { files: list, report: report };
    }

    // ---------- 1) 先按文件名精确配对 ----------
    const used = new Array(list.length).fill(false);
    const slots = templates.map(function (template) {
      let hitIndex = -1;
      for (let i = 0; i < list.length; i += 1) {
        if (used[i]) continue;
        if (isSameFileLoose(list[i].name, template.name)) {
          hitIndex = i;
          break;
        }
      }
      if (hitIndex >= 0) {
        used[hitIndex] = true;
        return { template: template, file: list[hitIndex] };
      }
      return { template: template, file: null };
    });

    // ---------- 2) 剩下的按内容特征打分配对 ----------
    slots.forEach(function (slot) {
      if (slot.file) return;
      let bestIndex = -1;
      let bestScore = 0;
      for (let i = 0; i < list.length; i += 1) {
        if (used[i]) continue;
        const score = scoreBlockAgainstTemplate(list[i], slot.template);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }
      // 分数门槛：至少要有"语言一致 + 一点内容重合"才敢认，
      // 否则宁可判缺，也不把别的文件塞进这个槽位。
      if (bestIndex >= 0 && bestScore >= 20) {
        used[bestIndex] = true;
        slot.file = list[bestIndex];
        report.orderFixed = true;
      }
    });

    // ---------- 3) 单文件模板的特殊处理 ----------
    // 模板只有一个文件、模型给的代码块也没写名字时，那唯一一块就是它。
    if (templates.length === 1 && !slots[0].file) {
      const onlyCodeBlocks = list.filter(function (file, i) { return !used[i]; });
      if (onlyCodeBlocks.length === 1) {
        slots[0].file = onlyCodeBlocks[0];
        used[list.indexOf(onlyCodeBlocks[0])] = true;
      }
    }

    // ---------- 4) 组装 ----------
    // 铁律：对齐是"整理"，不是"销毁"。
    // 早期版本在这里遇到配不上的槽位直接 return，结果是：
    // 模板 N 个文件、模型文件名稍有差异（或模板抓到的是占位名）
    // → 所有槽位都判缺 → files 为空 → 代码块既不进滑框也不进正文
    // → 用户看到"根本没有生成答案文件"。
    // 现在：配不上的槽位保留为"待补"，没被认领的答案文件原样保留。
    const files = [];
    slots.forEach(function (slot) {
      const template = slot.template;
      if (!slot.file) {
        report.missing.push(template.name);
        report.aligned = false;
        return;
      }
      const name = template.name || slot.file.name || '';
      if (slot.file.name && template.name && !isSameFileLoose(slot.file.name, template.name)) {
        report.renamed.push(slot.file.name + ' → ' + template.name);
      }
      files.push({
        name: name,
        lang: slot.file.lang || template.lang || '',
        code: slot.file.code,
        templateIndex: template.index,
        missing: false
      });
    });

    // 没被任何槽位认领的答案文件：模板里没有它。
    // 两个约束要同时满足：
    //   ① 用户要求"滑框里不能有模板外的文件" → 不能放进 files
    //   ② 也不能凭空丢内容，万一模板没抓全，丢了就是丢答案
    // 所以单独放进 report.extras，由界面渲染到"模板外内容"折叠区，
    // 用户能看到、能手动复制，但它不占滑框的文件位。
    report.extras = [];
    list.forEach(function (file, i) {
      if (used[i]) return;
      if (!(file.code || '').trim()) return;
      report.dropped.push((file.name || '未命名代码块') + '（' + (file.code || '').split('\n').length + ' 行）');
      report.extras.push({
        name: file.name || '',
        lang: file.lang || '',
        code: file.code
      });
    });

    // 兜底：对齐把一切都配丢了（模板与答案完全不匹配，且没有可保留的模板外内容），
    // 这时必须把原始答案原样交出来，绝不能显示空白。
    if (!files.length && !report.extras.length && list.length) {
      report.aligned = false;
      report.fallback = true;
      list.forEach(function (file) {
        files.push({
          name: file.name || '',
          lang: file.lang || '',
          code: file.code,
          templateIndex: -1,
          missing: false
        });
      });
    }

    // 极端情况：槽位全缺，但确实有多块模板外代码。
    // 这时不能让滑框空着（用户会以为没生成），全部转成文件展示。
    if (!files.length && report.extras.length) {
      report.aligned = false;
      report.fallback = true;
      report.extras.forEach(function (file) {
        files.push({
          name: file.name || '',
          lang: file.lang || '',
          code: file.code,
          templateIndex: -1,
          missing: false
        });
      });
      report.extras = [];
      report.dropped = [];
    }

    // 用户模板本身为空（还没抓模板）时不要判定"缺文件"
    if (!templates.length) {
      report.missing = [];
      report.aligned = true;
    }

    return { files: files, report: report };
  }

  function renderTextBlock(text) {
    const div = document.createElement('div');
    div.className = 'md';
    let html = escapeHtml(text);
    html = html
      .replace(/^#### (.*)$/gm, '<h5>$1</h5>')
      .replace(/^### (.*)$/gm, '<h4>$1</h4>')
      .replace(/^## (.*)$/gm, '<h3>$1</h3>')
      .replace(/^# (.*)$/gm, '<h2>$1</h2>')
      .replace(/^\s*[-*] (.*)$/gm, '• $1')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
    div.innerHTML = html;
    return div;
  }

  function renderCodeBlock(language, code, copyIndex) {
    const index = typeof copyIndex === 'number' ? copyIndex : state.codeBlocks.push(code) - 1;
    const wrap = document.createElement('div');
    wrap.className = 'code-block';

    const head = document.createElement('div');
    head.className = 'code-head';

    const label = document.createElement('span');
    label.textContent = language || 'code';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-code';
    button.dataset.index = String(index);
    button.textContent = '复制';

    head.appendChild(label);
    head.appendChild(button);

    const pre = document.createElement('pre');
    const codeElement = document.createElement('code');
    codeElement.textContent = code;
    pre.appendChild(codeElement);

    wrap.appendChild(head);
    wrap.appendChild(pre);
    return wrap;
  }

  // 模型写 "### 文件: Main.java" 时，文件名已显示在滑框 tab 上，正文里不必重复
  function stripFileHeadings(text) {
    return text
      .replace(/(^|\n)[ \t#*>-]*(?:文件|文件名|file|filename)[ \t]*[:：]?[ \t]*`?[^\s`\n]+`?[ \t]*(?=\n|$)/gi, '$1')
      .replace(/\n{3,}/g, '\n\n');
  }

  function appendAnswerText(parent, text) {
    const cleaned = stripFileHeadings(text);
    if (cleaned.trim()) parent.appendChild(renderTextBlock(cleaned));
  }

  // 答案滑框的骨架，内容由 renderAnswerSlider 填充
  function buildAnswerSlider() {
    const slider = document.createElement('div');
    slider.className = 'slider answer-slider';
    slider.id = 'answerSlider';

    const nav = document.createElement('div');
    nav.className = 'slider-nav';
    nav.id = 'answerNav';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'slider-arrow';
    prev.dataset.sliderAction = 'ans-prev';
    prev.title = '上一个文件（←）';
    prev.textContent = '‹';

    const tabs = document.createElement('div');
    tabs.className = 'slider-tabs';
    tabs.id = 'answerTabs';

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'slider-arrow';
    next.dataset.sliderAction = 'ans-next';
    next.title = '下一个文件（→）';
    next.textContent = '›';

    nav.appendChild(prev);
    nav.appendChild(tabs);
    nav.appendChild(next);

    const block = document.createElement('div');
    block.className = 'code-block';
    block.id = 'answerCodeBlock';

    const foot = document.createElement('div');
    foot.className = 'slider-foot';
    foot.id = 'answerFoot';

    slider.appendChild(nav);
    slider.appendChild(block);
    slider.appendChild(foot);

    bindSwipe(block, function (direction) {
      showAnswerFileAt(state.activeAnswerFile + direction, direction);
    });

    // 键盘左右键切换（焦点在滑框的按钮上时生效）
    slider.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (state.answerFiles.length < 2) return;
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      event.preventDefault();
      showAnswerFileAt(state.activeAnswerFile + direction, direction);
    });

    return slider;
  }

  function showAnswerFileAt(index, direction) {
    if (!state.answerFiles.length) return;
    const next = clamp(index, 0, state.answerFiles.length - 1);
    if (next === state.activeAnswerFile) return;
    state.activeAnswerFile = next;
    renderAnswerSlider();
    const block = $('#answerCodeBlock');
    if (block && direction) {
      block.classList.remove('slide-from-left', 'slide-from-right');
      void block.offsetWidth;
      block.classList.add(direction > 0 ? 'slide-from-right' : 'slide-from-left');
    }
  }

  function renderAnswerSlider() {
    const tabs = $('#answerTabs');
    const block = $('#answerCodeBlock');
    const foot = $('#answerFoot');
    const nav = $('#answerNav');
    if (!tabs || !block || !foot) return;

    const files = state.answerFiles;
    if (!files.length) return;
    state.activeAnswerFile = clamp(state.activeAnswerFile, 0, files.length - 1);
    const index = state.activeAnswerFile;
    const file = files[index];
    const multiple = files.length > 1;

    tabs.innerHTML = '';
    files.forEach(function (item, i) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'slider-tab' + (i === index ? ' active' : '');
      tab.dataset.ansIndex = String(i);
      tab.title = item.name || ('代码块 ' + (i + 1));
      tab.textContent = shortFileName(item.name, i);
      tabs.appendChild(tab);
    });

    if (nav) nav.classList.toggle('single', !multiple);

    block.innerHTML =
      '<div class="code-head">' +
        '<span class="code-label"></span>' +
        '<span class="code-actions">' +
          '<button type="button" class="copy-code" data-index="' + index + '">复制</button>' +
          '<button type="button" class="insert-single-code" data-index="' + index + '">填入此文件</button>' +
        '</span>' +
      '</div>' +
      '<pre><code></code></pre>';
    block.querySelector('.code-label').textContent =
      (file.name || ('代码块 ' + (index + 1))) + (file.lang ? ' · ' + file.lang : '');
    block.querySelector('code').textContent = file.code;

    foot.innerHTML =
      '<span class="file-tip">第 ' + (index + 1) + ' / ' + files.length + ' 个文件</span>' +
      '<span class="file-tip">' + (multiple ? '点文件名 / 左右滑动切换' : '可直接填入编辑器') + '</span>';

    const activeTab = tabs.querySelector('.slider-tab.active');
    if (activeTab && activeTab.scrollIntoView) {
      try {
        activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch (e) {
        // 忽略
      }
    }
  }

  // ============================================================
  // 样例验算比对（v1.8.2）
  // ============================================================
  // 浏览器里跑不了 javac/python，所以没法真的执行代码。但可以做两件有价值的事：
  //   ① 检查模型有没有按约定**真的交一份验算结果**（没交 = 它没验算，属于高风险）
  //   ② 把它声称的"实际输出"和样例输出**逐字符**比对，差异直接标出来
  // 这样"模型自己说和样例一致"就不再是一句无法验证的话。

  // 从答案尾部抽出 输入 / 实际输出 / 与样例一致
  // 兼容两种写法：旧的「## 本地验证」段落，和新的「本地验证」裸标记块。
  function parseVerificationTrace(answer) {
    const text = String(answer || '');
    let section = '';

    const heading = text.match(/##\s*本地验证([\s\S]*?)(?=\n##\s|$)/);
    if (heading) {
      section = heading[1];
    } else {
      // 新格式：代码块里以「本地验证」开头的那一段
      const fenced = text.match(/```[^\n`]*\n\s*本地验证\s*\n([\s\S]*?)```/);
      if (fenced) section = fenced[1];
      else {
        const loose = text.match(/(?:^|\n)\s*本地验证\s*\n([\s\S]*)$/);
        if (loose) section = loose[1];
      }
    }
    if (!section.trim()) return [];

    const traces = [];
    // 按「输入:」切段，每段内部找实际输出和一致性结论
    const chunks = section.split(/(?:^|\n)\s*(?:\*\*)?输入(?:\*\*)?\s*[:：]/);
    chunks.slice(1).forEach(function (chunk) {
      const inputMatch = chunk.match(/^([\s\S]*?)(?=\n\s*(?:\*\*)?(?:实际输出|输出|与样例一致))/);
      const outMatch = chunk.match(/(?:^|\n)\s*(?:\*\*)?(?:实际输出|输出)(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:\*\*)?与样例一致|$)/);
      const verdictMatch = chunk.match(/与样例一致\s*[:：]?\s*([^\n]*)/);

      traces.push({
        input: inputMatch ? inputMatch[1].replace(/```/g, '').trim() : '',
        actual: outMatch ? outMatch[1].replace(/```/g, '').trim() : '',
        verdict: verdictMatch ? verdictMatch[1].trim() : ''
      });
    });

    return traces.filter(function (item) {
      return item.actual || item.verdict;
    });
  }

  // 逐字符比对，返回第一处差异的描述
  function diffFirstMismatch(expected, actual) {
    const left = String(expected || '').replace(/\r\n?/g, '\n');
    const right = String(actual || '').replace(/\r\n?/g, '\n');
    if (left === right) return null;

    const leftLines = left.split('\n');
    const rightLines = right.split('\n');
    const max = Math.max(leftLines.length, rightLines.length);
    for (let i = 0; i < max; i += 1) {
      const a = leftLines[i];
      const b = rightLines[i];
      if (a === b) continue;
      if (a === undefined) {
        return '第 ' + (i + 1) + ' 行：预期已结束，实际多出「' + String(b).slice(0, 60) + '」';
      }
      if (b === undefined) {
        return '第 ' + (i + 1) + ' 行：实际缺少「' + String(a).slice(0, 60) + '」';
      }
      // 行内第一处字符差异
      let col = 0;
      while (col < a.length && col < b.length && a[col] === b[col]) col += 1;
      return '第 ' + (i + 1) + ' 行第 ' + (col + 1) + ' 列：预期「' +
        String(a).slice(col, col + 20) + '」，实际「' + String(b).slice(col, col + 20) + '」';
    }
    return '存在空行/行尾差异';
  }

  // 综合评估样例验算结果
  function evaluateSampleCheck(answer, sampleIn, sampleOut) {
    const result = {
      required: !!(sampleIn || sampleOut),
      traces: [],
      hasTrace: false,
      claimedMismatch: false,
      confirmedMismatch: null,
      ok: false,
      message: ''
    };
    if (!result.required) return result;

    result.traces = parseVerificationTrace(answer);
    result.hasTrace = result.traces.length > 0;

    // 模型自己承认不一致 → 直接判为高风险
    result.traces.forEach(function (trace) {
      if (/否|不一致|不符|differs|mismatch/i.test(trace.verdict)) {
        result.claimedMismatch = true;
      }
    });

    // 拿模型声称的实际输出和样例输出比对（只在单样例、且两边都有内容时做）
    const sampleOutText = String(sampleOut || '').trim();
    if (sampleOutText && result.hasTrace) {
      const firstWithOutput = result.traces.filter(function (t) { return t.actual; })[0];
      if (firstWithOutput) {
        const diff = diffFirstMismatch(sampleOutText, firstWithOutput.actual);
        if (diff) result.confirmedMismatch = diff;
      }
    }

    result.ok = result.hasTrace && !result.claimedMismatch && !result.confirmedMismatch;

    if (!result.hasTrace) {
      result.message = '模型没有按约定给出样例验算结果 —— 说明它很可能没有真正验算过，直接提交风险较高。';
    } else if (result.confirmedMismatch) {
      result.message = '样例对不上：' + result.confirmedMismatch;
    } else if (result.claimedMismatch) {
      result.message = '模型自己承认样例没对上（说明它交了一个已知有问题的答案）。';
    } else {
      result.message = '模型声明样例已逐字符比对通过。';
    }
    return result;
  }

  // ============================================================
  // 正文过滤：只留代码，把解释收起来（v1.8.2）
  // ============================================================
  // 用户的原话是"只要把答案以文件的形式给我就好了"。所以默认界面里
  // 代码块之外的中文一律折叠，只保留两类必要信息：
  //   · 文件名行（### 文件: Main.java）—— 没有它就不知道这是哪个文件
  //   · 本地验证结论 —— 用来判断能不能交
  // 其余（思路/算法讲解/总结/客套话）收进「展开说明」，想看再点。

  const KEEP_LINE_RE = /^(?:#{1,6}\s*)?(?:文件|文件名|file|filename)\s*[:：]/i;
  const VERIFY_LINE_RE = /^(?:本地验证|输入\s*[:：]|实际输出\s*[:：]|与样例一致)/;

  function filterAnswerProse(raw) {
    const text = String(raw || '');
    if (!text.trim()) return { keep: '', hidden: '' };

    const keep = [];
    const hidden = [];

    text.split('\n').forEach(function (line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (KEEP_LINE_RE.test(trimmed) || VERIFY_LINE_RE.test(trimmed)) {
        keep.push(line);
        return;
      }
      hidden.push(line);
    });

    return {
      keep: keep.length ? keep.join('\n') : '',
      hidden: hidden.length ? hidden.join('\n') : ''
    };
  }

  // 折叠起来的说明：默认收起，点一下才展开
  function buildNotesDisclosure(text) {
    const wrap = document.createElement('details');
    wrap.className = 'notes-box';

    const summary = document.createElement('summary');
    summary.textContent = '展开说明（模型额外写的解释，不影响代码）';
    wrap.appendChild(summary);

    wrap.appendChild(renderTextBlock(text));
    return wrap;
  }

  // 模板外代码：不进滑框，但也别丢，折叠起来留给用户自己判断
  function buildExtrasDisclosure(extras) {
    const wrap = document.createElement('details');
    wrap.className = 'notes-box extras-box';

    const summary = document.createElement('summary');
    summary.textContent = '模板外代码 ' + extras.length + ' 块（不属于模板文件，未放入滑框；确认有用可手动复制）';
    wrap.appendChild(summary);

    extras.forEach(function (item) {
      const title = document.createElement('div');
      title.className = 'extra-title';
      title.textContent = item.name || '未命名代码块';
      wrap.appendChild(title);
      // 显式传索引：这些块追加在滑框代码之后，不能挤掉前面模板文件的索引，
      // 否则「填入此文件」会取到错误的代码。
      const index = state.codeBlocks.push(item.code) - 1;
      wrap.appendChild(renderCodeBlock(item.lang, item.code, index));
    });

    return wrap;
  }

  function renderAlignBar(report, templates, sampleCheck) {
    const bar = $('#alignBar');
    if (!bar) return;

    const hasContract = templates && templates.length > 0;
    const hasSample = sampleCheck && sampleCheck.required;
    if (!report && !hasContract && !hasSample) {
      bar.classList.add('hidden');
      bar.textContent = '';
      return;
    }

    bar.classList.remove('hidden');
    const parts = [];
    let level = 'ok';

    if (hasContract && report) {
      const okAll = report.aligned && !report.missing.length && !report.dropped.length;
      parts.push('模板契约：' + templates.length + ' 个文件（' +
        templates.map(function (t) { return t.name || '未命名'; }).join('、') + '）');

      if (okAll) {
        parts.push('✓ 答案与模板一一对应，无多余文件');
      } else {
        level = 'warn';
        if (report.missing.length) {
          parts.push('⚠ 缺 ' + report.missing.length + ' 个文件：' + report.missing.join('、'));
        }
        if (report.dropped.length) {
          parts.push('模板外 ' + report.dropped.length + ' 块已收进折叠区');
        }
        if (report.fallback) {
          parts.push('模板文件名对不上，已直接展示模型给的代码');
        }
        if (report.renamed.length) {
          parts.push('文件名已对齐模板：' + report.renamed.join('、'));
        }
      }
    }

    if (hasSample) {
      if (sampleCheck.ok) {
        parts.push('✓ 样例验算：' + sampleCheck.message);
      } else {
        level = 'warn';
        parts.push('⚠ ' + sampleCheck.message);
      }
    }

    bar.className = 'align-bar ' + level;
    bar.textContent = parts.join(' · ');
  }

  function renderAnswer(markdown) {
    const answerElement = $('#answer');
    answerElement.innerHTML = '';
    answerElement.classList.remove('empty');
    state.codeBlocks = [];
    state.answerFiles = [];
    state.activeAnswerFile = 0;

    const blocks = parseAnswerBlocks(markdown);
    // 与 extractAnswerFiles 保持完全一致：合并碎片、去掉 shell 命令、去重
    const rawFiles = extractAnswerFiles(markdown);

    // 关键：答案必须严格按模板契约（文件数 / 文件名 / 文件顺序）呈现。
    // 模型多吐的"编译命令""示例输出""再次确认版"在这里被剔除，
    // 文件顺序也强制与模板一致，滑框里一个不多一个不少。
    const templates = templateContract();
    const aligned = alignAnswerToTemplate(rawFiles, templates);
    const files = aligned.files;
    state.alignReport = aligned.report;

    // SKILL 第 4/5 步落到脚本里：核对模型有没有真的验算样例，
    // 并把"它声称的实际输出"和样例输出逐字符比对。
    state.sampleCheck = evaluateSampleCheck(
      markdown,
      ($('#sampleIn') || {}).value || '',
      ($('#sampleOut') || {}).value || ''
    );

    state.answerFiles = files;

    // 模型没写文件名时，按模板文件顺序补齐，让滑框 tab 显示真实文件名
    const templateNames = templates.map(function (t) { return t.name; });
    if (state.answerFiles.length === templateNames.length) {
      state.answerFiles.forEach(function (file, i) {
        if (!file.name && templateNames[i]) file.name = templateNames[i];
      });
    }

    // 滑框里的代码块占用前 N 个复制索引；示例/输出类代码块随后追加
    state.codeBlocks = state.answerFiles.map(function (file) { return file.code; });

    // 这些代码块已经进了滑框，正文里不再重复渲染
    const usedKeys = new Set(files.map(function (file) { return normalizeCode(file.code); }));

    // 正文文本过滤：用户只要代码，中间夹的一大段中文解释必须收起来。
    // 保留：文件名行（### 文件: xxx）、本地验证块；其它说明性文字一律折叠。
    let hiddenNotes = '';

    function flushText(raw) {
      const filtered = filterAnswerProse(raw);
      if (filtered.keep) {
        appendAnswerText(answerElement, filtered.keep);
      }
      if (filtered.hidden) hiddenNotes += filtered.hidden;
    }

    let cursor = 0;
    let sliderPlaced = false;
    blocks.forEach(function (block) {
      flushText(markdown.slice(cursor, block.start));
      cursor = block.end;
      if (!isCodeBlock(block)) {
        const copyIndex = state.codeBlocks.push(block.code) - 1;
        answerElement.appendChild(renderCodeBlock(block.lang, block.code, copyIndex));
        return;
      }
      // 被合并进别的块、或判定为重复的块，不再单独显示
      if (!usedKeys.has(normalizeCode(block.code))) return;
      usedKeys.delete(normalizeCode(block.code));
      if (!sliderPlaced) {
        answerElement.appendChild(buildAnswerSlider());
        sliderPlaced = true;
      }
    });
    flushText(markdown.slice(cursor));

    // 兜底：只要还有答案文件，滑框就必须出现。
    // 上面那个 forEach 只有"在正文里定位到原始代码块"时才置 sliderPlaced；
    // 一旦归一化后对不上（比如模型重排了空白、或块被合并），滑框就永远不建，
    // 结果是 answerFiles 明明有内容、界面上却一片空白。
    if (!sliderPlaced && state.answerFiles.length) {
      answerElement.appendChild(buildAnswerSlider());
      sliderPlaced = true;
    }

    if (sliderPlaced) renderAnswerSlider();

    // 模型写的解释默认收进「展开说明」，不占版面
    if (hiddenNotes.trim()) {
      answerElement.appendChild(buildNotesDisclosure(hiddenNotes));
    }

    // 模板外的代码块：不进滑框（用户要求滑框只放模板对应的文件），
    // 但也不丢——收进折叠区，需要时可以复制。
    const extras = (state.alignReport && state.alignReport.extras) || [];
    if (extras.length) {
      answerElement.appendChild(buildExtrasDisclosure(extras));
    }

    // 对齐结果如实告知：少了/多了/改名了都要让用户看见，绝不静默处理
    renderAlignBar(state.alignReport, templates, state.sampleCheck);

    // 最终兜底：如果页面上没有任何"可看的代码"，直接把原始答案贴出来。
    // 判据不能用 children.length —— 状态条本身也是一个 child，
    // 那样即使一个代码块都没渲染出来，也会被误认为"已经有内容了"。
    const hasVisibleCode = !!answerElement.querySelector('.answer-slider, .code-block, pre, code');
    if (!hasVisibleCode) {
      appendAnswerText(answerElement, markdown);
    }

    state.answerCode = extractMainCode(markdown);

    setTimeout(function () {
      try {
        answerElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (e) {
        // 忽略
      }
    }, 50);
  }

  // ============================================================
  // 设置表单 / 连接诊断
  // ============================================================

  function updateLastResult() {
    const element = $('#lastResult');
    if (!element) return;
    const d = state.lastDiagnostics;
    if (!d) {
      element.textContent = '尚未测试';
      element.classList.remove('warn-text');
      return;
    }
    if (d.error) {
      element.textContent = '上次：' + (d.status ? 'HTTP ' + d.status + ' ' : '') + '失败 · ' + d.ms + 'ms';
      element.classList.add('warn-text');
    } else if (d.status) {
      element.textContent = '上次：HTTP ' + d.status + ' 成功 · ' + d.ms + 'ms';
      element.classList.remove('warn-text');
    } else {
      element.textContent = '上次：未收到响应';
      element.classList.add('warn-text');
    }
  }

  function setDiagMessage(text, ok) {
    const element = $('#diagMessage');
    if (!element) return;
    element.textContent = text || '';
    element.classList.toggle('ok', !!ok);
  }

  function updateDiagnosticsPreview() {
    const settings = readSettingsForm();
    const preview = $('#endpointPreview');
    if (preview) {
      try {
        preview.textContent = buildEndpoint(settings.baseUrl);
      } catch (error) {
        preview.textContent = '（Base URL 无效：' + error.message + '）';
      }
    }
    const keyPreview = $('#keyPreview');
    if (keyPreview) keyPreview.textContent = 'Key：' + maskKey(settings.apiKey);
    // 已经配好 Key 的用户不需要再看到首次使用引导
    const firstRunHint = $('#firstRunHint');
    if (firstRunHint) firstRunHint.classList.toggle('hidden', !!String(settings.apiKey || '').trim());
    updateLastResult();
  }

  // 诊断文本不含完整 Key，可安全复制给他人排查
  function buildDiagnosticText() {
    const d = state.lastDiagnostics;
    const s = readSettingsForm();
    let endpoint;
    try {
      endpoint = buildEndpoint(s.baseUrl);
    } catch (e) {
      endpoint = s.baseUrl || '(空)';
    }
    return [
      'Helper · 连接诊断（v' + SCRIPT_VERSION + '）',
      '时间：' + new Date().toLocaleString(),
      '当前将请求：' + endpoint,
      '当前模型：' + (s.model || '(空)'),
      '是否推理型模型：' + (isReasoningModel(s.model) ? '是（思维链会与答案抢 max_tokens）' : '否'),
      '关闭思考模式：' + (s.disableThinking === false ? '关（不发送 enable_thinking）' : '开'),
      '当前 Key：' + maskKey(s.apiKey),
      '上次请求：' + (d ? d.url : '(尚未发起)'),
      '上次状态：' + (d ? (d.status === null ? '无响应' : 'HTTP ' + d.status) : '尚未测试'),
      '上次错误：' + (d && d.error ? d.error : '无'),
      '上次耗时：' + (d ? d.ms + 'ms（' + formatDuration(d.ms) + '）' : '—'),
      '输入字符：' + (d && d.promptChars ? d.promptChars : '—'),
      'max_tokens：' + (d && d.maxTokens ? d.maxTokens : '—'),
      'finish_reason：' + (d && d.finishReason ? d.finishReason : '—'),
      'completion_tokens：' + (d && d.completionTokens ? d.completionTokens : '—'),
      '本次生成：' + (state.lastRun ? state.lastRun.text : '尚未生成'),
      '上次返回体：' + (d && d.response ? d.response : '(空)')
    ].join('\n');
  }

  function fillSettingsForm() {
    const settings = state.settings;
    const preset = $('#preset');
    const baseUrl = $('#baseUrl');
    const apiKey = $('#apiKey');
    const model = $('#model');
    const temperature = $('#temperature');
    const maxTokens = $('#maxTokens');
    const disableThinking = $('#disableThinking');

    if (preset) preset.value = PRESETS[settings.preset] ? settings.preset : 'custom';
    if (baseUrl) baseUrl.value = settings.baseUrl || '';
    if (apiKey) apiKey.value = settings.apiKey || '';
    if (model) model.value = settings.model || '';
    if (temperature) temperature.value = String(settings.temperature);
    if (maxTokens) maxTokens.value = String(settings.maxTokens);
    // 老配置里没有这个字段：按"默认开"处理，与 DEFAULTS 保持一致
    if (disableThinking) disableThinking.checked = settings.disableThinking !== false;
    setStatusMeta(settings.model || '未配置模型');
  }

  function readSettingsForm() {
    const preset = $('#preset');
    const baseUrl = $('#baseUrl');
    const apiKey = $('#apiKey');
    const model = $('#model');
    const temperature = $('#temperature');
    const maxTokens = $('#maxTokens');
    const disableThinking = $('#disableThinking');

    return {
      preset: preset ? preset.value : 'custom',
      baseUrl: baseUrl ? baseUrl.value.trim() : '',
      apiKey: apiKey ? apiKey.value.trim() : '',
      model: model ? model.value.trim() : '',
      temperature: clamp(parseFloat(temperature && temperature.value) || 0, 0, 2),
      maxTokens: Math.max(256, parseInt(maxTokens && maxTokens.value, 10) || DEFAULTS.maxTokens),
      disableThinking: disableThinking ? !!disableThinking.checked : true
    };
  }

  function saveSettings(silent) {
    const settings = readSettingsForm();
    if (!settings.baseUrl) {
      if (!silent) setStatus('请填写 API Base URL', 'warn');
      return false;
    }
    if (!settings.model) {
      if (!silent) setStatus('请填写模型名称', 'warn');
      return false;
    }
    state.settings = settings;
    storageSet(STORAGE_KEY, settings);
    setStatusMeta(settings.model);
    if (!silent) setStatus('设置已保存', 'ok');
    return true;
  }

  function switchTab(name) {
    $$('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.tab === name);
    });
    $$('.pane').forEach(function (pane) {
      pane.classList.toggle('active', pane.dataset.pane === name);
    });
  }

  // ============================================================
  // 生成
  // ============================================================

  function startTimer() {
    state.startTime = Date.now();
    const timer = $('#timer');
    if (timer) timer.textContent = '0s';
    clearInterval(state.timerId);
    state.timerId = setInterval(function () {
      const seconds = Math.floor((Date.now() - state.startTime) / 1000);
      const element = $('#timer');
      if (element) element.textContent = seconds + 's';
    }, 1000);
  }

  function stopTimer() {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  function formatDuration(ms) {
    const value = Math.max(0, Number(ms) || 0);
    if (value < 1000) return value + ' 毫秒';
    const total = Math.round(value / 1000);
    if (total < 60) return total + ' 秒';
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes + ' 分 ' + seconds + ' 秒';
  }

  // 生成结束后把耗时、token、答案文件数写进状态栏和诊断区，方便回头核对"这次到底跑了多久、出了几个文件"
  function buildRunSummary(answer) {
    const elapsed = state.startTime ? Date.now() - state.startTime : 0;
    const d = state.lastDiagnostics || {};
    const promptChars = Number(d.promptChars || 0);
    const answerChars = String(answer || '').length;
    const fileCount = state.answerFiles.length;
    const parts = ['用时 ' + formatDuration(elapsed)];
    if (fileCount) {
      const names = state.answerFiles.map(function (file, i) {
        return file.name || ('代码块 ' + (i + 1));
      });
      parts.push('答案 ' + fileCount + ' 个文件（' + names.join('、') + '）');
    }
    if (promptChars) parts.push('输入约 ' + promptChars + ' 字符');
    parts.push('输出 ' + answerChars + ' 字符');
    return { text: parts.join('；'), elapsed: elapsed, promptChars: promptChars, answerChars: answerChars, fileCount: fileCount };
  }

  // mode: 'fresh' 首次生成；'fix' 按测评反馈修正（会带上当前答案）
  async function generateAnswer(mode) {
    if (state.busy) return;
    const isFix = mode === 'fix';

    const settings = readSettingsForm();
    if (!settings.apiKey) {
      switchTab('settings');
      setStatus('请先在设置里填写 API Key', 'warn');
      return;
    }
    if (!settings.baseUrl || !settings.model) {
      switchTab('settings');
      setStatus('请先完善 API 设置', 'warn');
      return;
    }

    const task = $('#taskText').value.trim();
    const files = state.files
      .map(function (file) {
        return {
          name: (file.name || '').trim(),
          code: (file.code || '').trim()
        };
      })
      .filter(function (file) {
        return file.code;
      });

    if (!task && !files.length) {
      setStatus('请至少填写任务描述或模板代码', 'warn');
      return;
    }

    // 修正模式：必须有报错原文或预期/实际输出，否则无从下手
    const judgeError = ($('#judgeError') || {}).value || '';
    const judgeExpected = ($('#judgeExpected') || {}).value || '';
    const judgeActual = ($('#judgeActual') || {}).value || '';
    if (isFix) {
      if (!judgeError.trim() && !judgeExpected.trim() && !judgeActual.trim()) {
        setStatus('请先在「测评没通过」里填报错原文，或至少填预期输出/实际输出', 'warn');
        return;
      }
      if (!state.answerRaw.trim()) {
        setStatus('还没有答案可以修正，请先「生成答案」', 'warn');
        return;
      }
    }

    state.settings = settings;
    storageSet(STORAGE_KEY, settings);
    setStatusMeta(settings.model);

    state.busy = true;
    // 关键：修正模式要在清空之前把上一轮答案存下来。
    // 这里原本直接 state.answerRaw = ''，导致 previousAnswer 永远是空串，
    // 模型只能看到"你上次错了"却看不到"上次写的是什么"，等于让它盲改。
    const previousAnswer = isFix ? state.answerRaw : '';
    state.answerRaw = '';
    state.answerCode = '';
    state.codeBlocks = [];
    state.answerFiles = [];
    state.activeAnswerFile = 0;
    const runId = ++state.generationId;

    const generateButton = $('#generate');
    const cancelButton = $('#cancel');
    const answerElement = $('#answer');
    const copyButton = $('#copyAll');
    const insertButton = $('#insertCode');

    generateButton.disabled = true;
    cancelButton.classList.remove('hidden');
    copyButton.disabled = true;
    insertButton.disabled = true;
    answerElement.classList.remove('empty');
    answerElement.textContent = isFix ? '正在按测评反馈修正，请稍候…' : '正在生成，请稍候…';
    setStatus(isFix ? '正在按测评反馈修正…' : '正在调用模型…', '');
    startTimer();

    const input = {
      language: $('#language').value.trim(),
      task: truncateText(task, MAX_TASK_CHARS),
      files: files,
      sampleIn: $('#sampleIn').value.trim(),
      sampleOut: $('#sampleOut').value.trim(),
      extra: $('#extraReq').value.trim(),
      previousAnswer: previousAnswer,
      judge: isFix ? {
        error: judgeError.trim(),
        expected: judgeExpected.trim(),
        actual: judgeActual.trim()
      } : null
    };

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input) }
    ];

    try {
      const answer = await apiRequestWithRetry(settings, messages, {
        retries: 3,
        onRequest: function (request) {
          state.request = request;
        },
        onRetry: function (attempt, total, tokens, error) {
          if (runId !== state.generationId) return;
          setStatus(
            '第 ' + attempt + '/' + total + ' 次尝试（上次返回空内容，已把 max_tokens 提到 ' +
            tokens + ' 重试）…',
            'warn'
          );
          answerElement.textContent =
            '接口上次返回了空内容，正在重试（第 ' + attempt + '/' + total + ' 次，max_tokens=' + tokens + '）…';
        }
      });

      if (runId !== state.generationId) return;

      state.answerRaw = answer;
      renderAnswer(answer);
      copyButton.disabled = false;
      insertButton.disabled = !state.answerCode;

      const summary = buildRunSummary(answer);
      state.lastRun = summary;
      setStatus('生成完成 · ' + summary.text, 'ok');
      updateLastResult();
      updateDiagnosticsPreview();

      // 对齐结果反馈：滑框里已经强制成"模板几个文件就几个文件"，
      // 这里只负责把"缺了哪个 / 剔掉了什么"讲清楚，不再让用户自己去数。
      const report = state.alignReport;
      const contract = templateContract();
      const check = state.sampleCheck;
      const problems = [];

      if (contract.length && report) {
        if (report.missing.length) {
          problems.push('缺 ' + report.missing.join('、'));
        }
        if (report.dropped.length) {
          problems.push('有 ' + report.dropped.length + ' 块模板外内容已收进下方折叠区（' +
            report.dropped.join('、') + '），没放进滑框');
        }
        if (report.fallback) {
          problems.push('模板文件名对不上，已把模型给的代码直接当作文件显示');
        }
      }
      // 样例没验算 / 对不上，是"过不了测评"最直接的预警，必须顶到状态栏
      if (check && check.required && !check.ok) {
        problems.push(check.message);
      }

      if (problems.length) {
        setStatus(
          '生成完成 · ' + summary.text + ' —— ' + problems.join('；') +
          '。可直接点「按报错修正答案」补，别手动粘贴模板外的文件。',
          'warn'
        );
      } else if (contract.length && report) {
        setStatus('生成完成 · ' + summary.text + ' —— 文件数与命名已与模板对齐，样例验算通过', 'ok');
      }
    } catch (error) {
      if (runId !== state.generationId) return;
      if (error.name === 'AbortError') {
        setStatus('已停止生成', 'warn');
        answerElement.textContent = '已停止生成。';
      } else {
        setStatus('生成失败：' + error.message, 'error');
        answerElement.textContent = '生成失败：' + error.message;
      }
    } finally {
      if (runId === state.generationId) {
        state.busy = false;
        state.request = null;
        generateButton.disabled = false;
        cancelButton.classList.add('hidden');
        stopTimer();
      }
    }
  }

  function normalizeFileName(value) {
    return cleanFileName(value).toLowerCase();
  }

  function findEditorByName(editors, name) {
    const target = normalizeFileName(name);
    if (!target) return null;

    const exact = editors.filter(function (editor) {
      return normalizeFileName(editor.name) === target;
    });
    if (exact.length) return exact[0];

    const stem = target.replace(/\.[^.]+$/, '');
    const byStem = editors.filter(function (editor) {
      const editorName = normalizeFileName(editor.name);
      return editorName && editorName.replace(/\.[^.]+$/, '') === stem;
    });
    if (byStem.length === 1) return byStem[0];

    return null;
  }

  function mergeFilesForClipboard(files) {
    return files
      .map(function (file) {
        return (file.name ? '// ===== ' + file.name + ' =====\n' : '') + file.code;
      })
      .join('\n\n');
  }

  // onlyIndex 有值时只填滑框里当前这一个文件；否则一次填全部
  function insertAnswerCode(onlyIndex) {
    const all = state.answerFiles.length
      ? state.answerFiles
      : extractAnswerFiles(state.answerRaw);
    const files = (typeof onlyIndex === 'number' && onlyIndex >= 0 && onlyIndex < all.length)
      ? [all[onlyIndex]]
      : all;

    if (!files.length) {
      setStatus('答案里没有可填入的代码块', 'warn');
      return;
    }

    const editors = findEditors();
    if (!editors.length) {
      copyText(mergeFilesForClipboard(files))
        .then(function () {
          setStatus('未检测到可写入的编辑器，代码已复制到剪贴板', 'warn');
        })
        .catch(function (error) {
          setStatus('复制失败：' + error.message, 'error');
        });
      return;
    }

    const plans = [];
    const unmatched = [];
    const writable = editors.filter(function (editor) {
      return typeof editor.set === 'function';
    });

    files.forEach(function (file, index) {
      let target = findEditorByName(writable, file.name);
      if (!target && files.length === 1 && typeof onlyIndex !== 'number') {
        target = findEditor();
      }
      if (!target && writable.length === editors.length && files.length === editors.length) {
        target = writable[index];
      }
      // 单文件填入时，按滑框里的文件序号对应编辑器
      if (!target && typeof onlyIndex === 'number' && writable[onlyIndex]) {
        target = writable[onlyIndex];
      }
      if (target) {
        plans.push({ file: file, target: target });
      } else {
        unmatched.push(file);
      }
    });

    if (!plans.length) {
      copyText(mergeFilesForClipboard(files))
        .then(function () {
          setStatus('没有匹配到编辑器，代码已复制到剪贴板', 'warn');
        })
        .catch(function (error) {
          setStatus('复制失败：' + error.message, 'error');
        });
      return;
    }

    const names = plans.map(function (plan) {
      return plan.target.name || plan.target.source;
    });
    let message = '将把答案写入 ' + plans.length + ' 个编辑器：\n' + names.join('\n');
    if (unmatched.length) {
      message += '\n\n另有 ' + unmatched.length + ' 个文件没匹配到编辑器，会复制到剪贴板：\n' +
        unmatched.map(function (file) { return file.name || '未命名文件'; }).join('\n');
    }
    message += '\n\n继续？';

    if (!confirmAction(message)) return;

    const failed = [];
    plans.forEach(function (plan) {
      try {
        plan.target.set(plan.file.code);
      } catch (error) {
        failed.push((plan.target.name || plan.target.source) + '：' + error.message);
      }
    });

    if (unmatched.length) {
      copyText(mergeFilesForClipboard(unmatched)).catch(function () {
        // 剪贴板失败时保留状态提示即可
      });
    }

    if (failed.length) {
      setStatus('部分文件写入失败：' + failed.join('；'), 'error');
    } else if (unmatched.length) {
      setStatus('已写入 ' + plans.length + ' 个文件；' + unmatched.length + ' 个未匹配，已复制到剪贴板', 'warn');
    } else {
      setStatus('已写入 ' + plans.length + ' 个文件，请逐个检查后提交', 'ok');
    }
  }

  async function testApi() {
    const settings = readSettingsForm();
    if (!settings.apiKey) {
      setStatus('请先填写 API Key', 'warn');
      return;
    }
    if (!settings.baseUrl || !settings.model) {
      setStatus('请先填写 Base URL 和模型', 'warn');
      return;
    }

    // 测的就是当前表单值，顺手保存，避免"改了没保存 / 刷新又变回旧地址"
    saveSettings(true);
    updateDiagnosticsPreview();
    setDiagMessage('', false);

    const button = $('#testApi');
    button.disabled = true;
    setStatus('正在测试连接…', '');

    try {
      const reply = await apiRequest(
        Object.assign({}, settings, {
          // 推理型模型即使只回 OK，也会先花掉一大截思维链预算；
          // 32 太小会让"连接其实是通的"被误判成失败。
          maxTokens: isReasoningModel(settings.model) ? 2048 : 64
        }),
        [
          { role: 'system', content: '你是连接测试助手。' },
          { role: 'user', content: '请只回复 OK' }
        ],
        { timeout: 60000 }
      );
      setStatus('连接成功，模型返回：' + String(reply).trim().slice(0, 40), 'ok');
      const d = state.lastDiagnostics;
      setDiagMessage('连接成功：' + (d ? shortEndpoint(d.url) : '接口') + ' 已正常返回。', true);
    } catch (error) {
      const raw = String(error.message || '');
      let hint = '';
      if (error && error.emptyContent) {
        hint = raw;
      } else if (/insufficient.?balance|余额不足|欠费|quota|额度|402/i.test(raw)) {
        hint = '这是【服务端】返回的余额不足，不是脚本配置错误。请核对上方「本次请求将发往」是不是你充值的那家服务商；如果地址一直没变，说明只换了 Key 或模型，Base URL 还指向旧的中转站。也确认该账号确实有余额，或改用官方直连地址。';
      } else if (/invalid.?api.?key|unauthorized|authentication|401|incorrect api key/i.test(raw)) {
        hint = 'Key 无效，或 Key 与 Base URL 不属于同一家服务商。中转站的 Key 不能用于官方地址，反之亦然。';
      } else if (/404|not found/i.test(raw)) {
        hint = '接口路径不对。Base URL 通常需要带 /v1，且服务商要支持 /chat/completions。';
      } else if (/网络请求失败|timeout|超时|CORS/i.test(raw)) {
        hint = '检查 Base URL 拼写、网络，以及 Tampermonkey 是否允许了跨域（第一次请求时选「总是允许」）。';
      }
      setStatus('连接失败：' + raw, 'error');
      setDiagMessage(hint || raw, false);
    } finally {
      button.disabled = false;
      updateDiagnosticsPreview();
    }
  }

  // ============================================================
  // UI
  // ============================================================

  function buildUI() {
    // Tampermonkey 里同时装了两份脚本时，旧版面板会盖在新版上面，
    // 表现出来就是"怎么拖都没反应/界面还是旧的"。这里保留新的一份，移除其它实例。
    try {
      Array.from(document.querySelectorAll('#educoder-ai-helper-host')).forEach(function (old) {
        const version = old.getAttribute('data-helper-version');
        if (version !== SCRIPT_VERSION) {
          old.remove();
        }
      });
    } catch (e) {
      // 忽略
    }

    const host = document.createElement('div');
    host.id = 'educoder-ai-helper-host';
    host.setAttribute('data-helper-version', SCRIPT_VERSION);
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host {
          --bg: #ffffff;
          --bg-soft: #f6f7fb;
          --text: #1f2430;
          --muted: #6b7280;
          --border: #e5e7eb;
          --primary: #4f46e5;
          --primary-2: #7c3aed;
          --danger: #dc2626;
          --ok: #059669;
          --warn: #d97706;
          --code-bg: #0f172a;
          --code-text: #e2e8f0;
          --shadow: 0 20px 60px rgba(15, 23, 42, .22);
          all: initial;
        }
        @media (prefers-color-scheme: dark) {
          :host {
            --bg: #151821;
            --bg-soft: #1c2030;
            --text: #e5e7eb;
            --muted: #9ca3af;
            --border: #2b3244;
            --primary: #6366f1;
            --primary-2: #8b5cf6;
            --code-bg: #0b1020;
            --shadow: 0 20px 60px rgba(0, 0, 0, .55);
          }
        }
        * { box-sizing: border-box; }
        button { font: inherit; }
        .fab {
          position: fixed; right: 20px; bottom: 20px;
          display: flex; align-items: center; gap: 8px;
          border: 0; border-radius: 999px; padding: 10px 14px 10px 10px;
          background: linear-gradient(135deg, var(--primary), var(--primary-2));
          color: #fff; font: 600 13px/1 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          box-shadow: 0 12px 30px rgba(79, 70, 229, .35);
          cursor: grab; pointer-events: auto; z-index: 2147483647;
          transition: transform .15s ease, box-shadow .15s ease;
          /* 触摸拖动时不要触发页面滚动 */
          touch-action: none;
          user-select: none;
        }
        /* 拖过之后改用 left/top 定位，避免 right/bottom 与拖动结果打架 */
        .fab.moved { right: auto; bottom: auto; }
        .fab.dragging {
          cursor: grabbing;
          transform: scale(1.06);
          box-shadow: 0 18px 42px rgba(79, 70, 229, .5);
          transition: none;
        }
        .fab:hover { transform: translateY(-1px); box-shadow: 0 16px 36px rgba(79, 70, 229, .42); }
        .fab.dragging:hover { transform: scale(1.06); }
        .fab-mark {
          display: grid; place-items: center; width: 28px; height: 28px;
          border-radius: 50%; background: rgba(255, 255, 255, .18);
          font-size: 11px; font-weight: 800; letter-spacing: .02em;
        }
        .panel {
          position: fixed; right: 20px; bottom: 88px;
          width: 480px; max-width: calc(100vw - 24px);
          /* 留出一段可以拖动的空间：原来 780px 几乎占满视口，纵向上基本挪不动 */
          height: min(660px, calc(100vh - 170px));
          min-height: 260px;
          background: var(--bg); color: var(--text);
          border: 1px solid var(--border); border-radius: 16px;
          box-shadow: var(--shadow);
          display: flex; flex-direction: column; overflow: hidden;
          pointer-events: auto;
          font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          z-index: 2147483647;
        }
        .panel.dragged { right: auto; bottom: auto; }
        .panel.hidden { display: none; }
        /* 折叠：只保留标题栏。
           注意必须同时覆盖 min-height —— 否则 .panel 的 min-height: 260px 仍然生效，
           高度被撑到 260px，标题栏下面会空出一大块。 */
        .panel.minimized {
          height: auto;
          min-height: 0;
          /* 折叠时不应再占满宽度，让它缩成一个"胶囊" */
          width: auto;
          min-width: 220px;
        }
        .panel.minimized .tabs,
        .panel.minimized .panel-body,
        .panel.minimized .statusbar { display: none; }
        /* 折叠后标题栏是唯一可见部分，底部圆角要补齐（否则下半截是直角） */
        .panel.minimized .panel-header {
          border-bottom: 0;
          border-radius: 16px;
        }
        .panel-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 14px; gap: 8px;
          background: linear-gradient(135deg, rgba(79, 70, 229, .10), rgba(124, 58, 237, .06));
          border-bottom: 1px solid var(--border);
          cursor: move; user-select: none;
          touch-action: none;
        }
        .panel-header:active { cursor: grabbing; }
        .drag-dots {
          display: inline-flex; gap: 2px; margin-left: 2px;
          color: var(--muted); opacity: .55; font-size: 10px; letter-spacing: -1px;
        }
        #versionTag {
          font-size: 10px; font-weight: 600; color: var(--muted);
          background: rgba(99, 102, 241, .12); border-radius: 999px;
          padding: 1px 6px; margin-left: 2px; letter-spacing: 0;
        }
        /* 键盘也能移动面板：标题栏拿到焦点后给个可见提示 */
        #dragHandle:focus { outline: 2px solid var(--primary); outline-offset: -2px; }
        #dragHandle:focus:not(:focus-visible) { outline: none; }
        /* 面板位置预设按钮 */
        .pos-row {
          display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;
        }
        .pos-row button {
          flex: 1 1 auto; min-width: 62px; padding: 6px 8px;
          border: 1px solid var(--border); border-radius: 8px;
          background: var(--bg); color: var(--text); cursor: pointer;
          font-size: 12px;
        }
        .pos-row button:hover { border-color: var(--primary); color: var(--primary); }
        .diag-pre {
          margin-top: 6px; padding: 8px; border-radius: 8px;
          background: var(--bg-soft); border: 1px solid var(--border);
          font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: pre-wrap; overflow-wrap: anywhere;
          max-height: 190px; overflow: auto; color: var(--text);
        }
        /* 注意：shadow DOM 里的样式选择不到宿主页面的 html，所以拖动时的全局禁选
           不放在这里，而是由 applyDragLock() 直接给 documentElement 加内联样式 */
        .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; }
        .brand-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: linear-gradient(135deg, var(--primary), var(--primary-2));
          box-shadow: 0 0 0 4px rgba(99, 102, 241, .15);
        }
        .header-actions { display: flex; gap: 2px; }
        .header-actions button {
          width: 28px; height: 28px; border: 0; background: transparent;
          color: var(--muted); border-radius: 8px; cursor: pointer;
          font-size: 16px; line-height: 1;
        }
        .header-actions button:hover { background: var(--bg-soft); color: var(--text); }
        .tabs {
          display: flex; gap: 4px; padding: 8px 12px 0;
          border-bottom: 1px solid var(--border);
        }
        .tab {
          border: 0; background: transparent; color: var(--muted);
          padding: 8px 12px; border-radius: 8px 8px 0 0;
          cursor: pointer; font-size: 13px; font-weight: 600;
        }
        .tab.active {
          color: var(--primary); background: var(--bg-soft);
          box-shadow: inset 0 -2px 0 var(--primary);
        }
        .panel-body { flex: 1; min-height: 0; display: flex; }
        .pane {
          display: none; flex: 1; min-height: 0; overflow-y: auto;
          padding: 12px 14px 16px;
        }
        .pane.active { display: flex; flex-direction: column; gap: 10px; }
        .toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .grow { flex: 1; }
        .editor-hint { color: var(--muted); font-size: 11px; }
        .editor-hint.ok { color: var(--ok); }
        button:disabled { opacity: .5; cursor: not-allowed; }
        .toolbar button,
        .answer-actions button,
        .actions button,
        .input-row button {
          border: 1px solid var(--border); background: var(--bg-soft); color: var(--text);
          padding: 6px 10px; border-radius: 8px; cursor: pointer;
          font-size: 12px; font-weight: 600;
        }
        .toolbar button:hover,
        .answer-actions button:hover,
        .actions button:hover,
        .input-row button:hover { border-color: var(--primary); color: var(--primary); }
        .actions .primary {
          background: linear-gradient(135deg, var(--primary), var(--primary-2));
          color: #fff; border: 0; padding: 8px 16px; font-size: 13px;
        }
        .actions .primary:hover { color: #fff; opacity: .92; }
        .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .timer { color: var(--muted); font-size: 11px; }
        .field { display: flex; flex-direction: column; gap: 5px; }
        .field > span { font-size: 12px; font-weight: 600; color: var(--muted); }
        /* 复选框行：input 的 width:100% 会把 checkbox 拉成一整行，必须单独复位 */
        .check {
          display: flex; align-items: flex-start; gap: 8px;
          font-size: 12px; color: var(--text); cursor: pointer;
          padding: 2px 0;
        }
        .check > input[type="checkbox"] {
          width: 14px; height: 14px; min-width: 14px; flex: 0 0 14px;
          margin: 1px 0 0; padding: 0; accent-color: var(--primary);
          border-radius: 3px;
        }
        .check > span { line-height: 1.45; }
        input, textarea, select {
          width: 100%; background: var(--bg-soft); color: var(--text);
          border: 1px solid var(--border); border-radius: 8px;
          padding: 8px 10px; font: inherit; outline: none;
        }
        input:focus, textarea:focus, select:focus {
          border-color: var(--primary);
          box-shadow: 0 0 0 3px rgba(99, 102, 241, .15);
        }
        textarea { resize: vertical; min-height: 60px; }
        textarea.mono, .answer code, .code-block code {
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
        }
        .file-count { font-size: 11px; font-weight: 400; color: var(--primary); }
        .slider {
          border: 1px solid var(--border); border-radius: 10px;
          background: var(--bg); overflow: hidden;
        }
        .slider-nav {
          display: flex; align-items: center; gap: 4px;
          padding: 6px; background: var(--bg-soft);
          border-bottom: 1px solid var(--border);
        }
        .slider-arrow {
          flex: 0 0 26px; width: 26px; height: 26px;
          border: 1px solid var(--border); border-radius: 7px;
          background: var(--bg); color: var(--text);
          font-size: 18px; line-height: 1; cursor: pointer; padding: 0;
        }
        .slider-arrow:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
        .slider-arrow:disabled { opacity: .35; }
        .slider-nav.single .slider-arrow { visibility: hidden; }
        .slider-tabs {
          flex: 1; min-width: 0; display: flex; gap: 4px;
          overflow-x: auto; scrollbar-width: none; padding: 1px 2px;
        }
        .slider-tabs::-webkit-scrollbar { display: none; }
        .slider-tab {
          flex: 0 0 auto; max-width: 150px; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap;
          border: 1px solid var(--border); border-radius: 999px;
          background: var(--bg); color: var(--muted);
          padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer;
        }
        .slider-tab:hover { color: var(--primary); border-color: var(--primary); }
        .slider-tab.active {
          background: linear-gradient(135deg, var(--primary), var(--primary-2));
          color: #fff; border-color: transparent;
        }
        .slider-tab.pending { border-style: dashed; opacity: .8; }
        .slider-tab.pending.active { opacity: 1; }
        .slider-meta {
          display: flex; align-items: center; gap: 6px;
          padding: 6px 8px; border-bottom: 1px solid var(--border);
        }
        .slider-counter {
          flex: 0 0 auto; font-size: 11px; font-weight: 700;
          color: var(--muted); font-variant-numeric: tabular-nums;
        }
        .file-name {
          flex: 1; min-width: 0; border: 0; background: transparent;
          font-size: 12px; font-weight: 700; padding: 4px 6px;
        }
        .file-name:focus { background: var(--bg-soft); box-shadow: none; }
        .file-remove {
          flex: 0 0 24px; width: 24px; height: 24px; border: 0; border-radius: 6px;
          background: transparent; color: var(--muted); cursor: pointer;
          font-size: 15px; line-height: 1;
        }
        .file-remove:hover { background: rgba(220, 38, 38, .12); color: var(--danger); }
        .slider-viewport { position: relative; overflow: hidden; }
        .file-code {
          display: block; width: 100%; height: 150px; box-sizing: border-box;
          border: 0; border-radius: 0; background: var(--bg);
          padding: 8px 10px; font-size: 12px; resize: vertical; min-height: 90px;
        }
        .file-code:focus { box-shadow: none; border: 0; }
        .slider-foot {
          padding: 4px 10px 6px; border-top: 1px solid var(--border);
          background: var(--bg-soft);
        }
        @keyframes slide-in-right {
          from { opacity: .35; transform: translateX(18px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes slide-in-left {
          from { opacity: .35; transform: translateX(-18px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .slide-from-right { animation: slide-in-right .18s ease-out; }
        .slide-from-left { animation: slide-in-left .18s ease-out; }
        .file-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .file-actions button {
          border: 1px dashed var(--border); background: transparent; color: var(--text);
          padding: 5px 10px; border-radius: 8px; cursor: pointer;
          font-size: 12px; font-weight: 600;
        }
        .file-actions button:hover { border-color: var(--primary); color: var(--primary); }
        .file-tip { font-size: 11px; color: var(--muted); }
        .more { border: 1px dashed var(--border); border-radius: 10px; padding: 8px 10px; }
        .more summary { cursor: pointer; font-weight: 600; font-size: 12px; color: var(--muted); }
        .details-body { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }
        .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .input-row { display: flex; gap: 6px; }
        .input-row input { flex: 1; }
        .hint { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
        .diag {
          border: 1px solid var(--border); border-radius: 10px;
          background: var(--bg-soft); padding: 8px 10px;
          display: flex; flex-direction: column; gap: 5px;
        }
        .diag-title { font-size: 11px; font-weight: 700; color: var(--muted); }
        .diag-url {
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 12px; font-weight: 700; color: var(--primary);
          overflow-wrap: anywhere; line-height: 1.4;
        }
        .diag-row { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
        .diag-row span { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
        .diag-row .warn-text { color: var(--warn); }
        .diag-msg {
          font-size: 11px; line-height: 1.55; color: var(--warn);
          overflow-wrap: anywhere;
        }
        .diag-msg.ok { color: var(--ok); }
        .answer-head { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
        .answer-head > span {
          font-weight: 700; font-size: 11px; color: var(--muted);
          text-transform: uppercase; letter-spacing: .06em;
        }
        .answer-actions { display: flex; gap: 6px; }
        /* 模板契约对齐结果：必须显眼，用户要能一眼看出答案和模板是否一一对应 */
        .align-bar {
          margin-top: 6px; padding: 7px 10px; border-radius: 8px;
          font-size: 11px; line-height: 1.5; overflow-wrap: anywhere;
          border: 1px solid var(--border); background: var(--bg-soft); color: var(--muted);
        }
        .align-bar.ok { border-color: rgba(34, 197, 94, .45); color: var(--ok); background: rgba(34, 197, 94, .08); }
        .align-bar.warn { border-color: rgba(245, 158, 11, .45); color: var(--warn); background: rgba(245, 158, 11, .08); }
        .align-bar b { font-weight: 700; }
        /* 模型额外写的解释默认收起，不占版面 */
        .notes-box {
          margin-top: 8px; padding: 6px 10px; border-radius: 8px;
          border: 1px dashed var(--border); background: transparent;
          font-size: 11px; color: var(--muted);
        }
        .notes-box > summary {
          cursor: pointer; outline: none; font-size: 11px;
          color: var(--muted); user-select: none;
        }
        .notes-box > summary:hover { color: var(--text); }
        .notes-box .md { margin-top: 6px; font-size: 11px; line-height: 1.55; color: var(--muted); }
        .extras-box .extra-title {
          margin: 8px 0 4px; font-size: 11px; font-weight: 700; color: var(--text);
        }
        .extras-box .code-block { margin-top: 0; }
        .answer {
          border: 1px solid var(--border); border-radius: 10px;
          background: var(--bg-soft); padding: 10px 12px;
          min-height: 80px; overflow-wrap: anywhere;
        }
        .answer.empty { color: var(--muted); font-size: 12px; }
        .answer .md h2, .answer .md h3, .answer .md h4, .answer .md h5 {
          margin: 12px 0 6px; line-height: 1.35;
        }
        .answer .md h2 { font-size: 15px; }
        .answer .md h3 { font-size: 14px; }
        .answer .md h4, .answer .md h5 { font-size: 13px; }
        .answer .md code {
          background: rgba(99, 102, 241, .12); padding: 1px 4px;
          border-radius: 4px; font-size: .92em;
        }
        .code-block {
          margin: 10px 0; border-radius: 10px; overflow: hidden;
          border: 1px solid rgba(148, 163, 184, .25);
        }
        .code-head {
          display: flex; justify-content: space-between; align-items: center;
          padding: 6px 10px; background: #1e293b; color: #cbd5e1; font-size: 11px;
        }
        .code-head button {
          border: 0; background: rgba(255, 255, 255, .12); color: #e2e8f0;
          border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 11px;
        }
        .code-block pre {
          margin: 0; padding: 10px; background: var(--code-bg); color: var(--code-text);
          overflow-x: auto; max-height: 360px;
        }
        .code-block code { white-space: pre; font-size: 12px; }
        .answer-slider { margin: 10px 0; }
        .answer-slider .slider-nav { border-radius: 10px 10px 0 0; }
        .answer-slider .slider-nav.single .slider-arrow { display: none; }
        .answer-slider .code-block {
          margin: 0; border-radius: 0; border-left: 0; border-right: 0;
        }
        .answer-slider .code-head { gap: 6px; flex-wrap: wrap; }
        .answer-slider .code-actions { display: flex; gap: 6px; }
        .answer-slider .code-head button { font-size: 11px; }
        .answer-slider .code-block pre { max-height: 300px; }
        .answer-slider .slider-foot {
          display: flex; align-items: center; justify-content: space-between;
          border: 1px solid rgba(148, 163, 184, .25); border-top: 0;
          border-radius: 0 0 10px 10px;
        }
        .statusbar {
          display: flex; justify-content: space-between; gap: 8px;
          padding: 6px 12px; border-top: 1px solid var(--border);
          background: var(--bg-soft); font-size: 11px; color: var(--muted);
        }
        #status { overflow-wrap: anywhere; line-height: 1.4; }
        #status.ok { color: var(--ok); }
        #status.warn { color: var(--warn); }
        #status.error { color: var(--danger); }
        .hidden { display: none !important; }
        @media (max-width: 640px) {
          .panel {
            right: 8px; left: 8px; width: auto;
            bottom: 76px; height: calc(100vh - 96px);
          }
          /* 窄屏下折叠态要压过上面的 height，否则折叠后仍占满整屏高度 */
          .panel.minimized {
            right: 8px; left: 8px; width: auto;
            height: auto; min-height: 0;
          }
          .fab-label { display: none; }
        }
      </style>

      <button class="fab" id="fab" type="button" title="点击打开面板；按住可拖动，双击复位">
        <span class="fab-mark">AI</span>
        <span class="fab-label">Helper</span>
      </button>

      <div class="panel hidden" id="panel" role="dialog" aria-label="Helper">
        <div class="panel-header" id="dragHandle" tabindex="0" title="按住标题栏可拖动，双击复位；聚焦后方向键微调（Shift 加速）">
          <div class="brand">
            <span class="brand-dot"></span>
            <span>Helper</span>
            <span id="versionTag" title="当前运行的脚本版本（用来确认是否已更新到新版）"></span>
            <span class="drag-dots" aria-hidden="true">⋮⋮</span>
          </div>
          <div class="header-actions">
            <button type="button" data-action="settings" title="设置">⚙</button>
            <button type="button" data-action="minimize" title="最小化">—</button>
            <button type="button" data-action="close" title="关闭">×</button>
          </div>
        </div>

        <div class="tabs" id="tabs">
          <button type="button" class="tab active" data-tab="solve">解题</button>
          <button type="button" class="tab" data-tab="settings">设置</button>
        </div>

        <div class="panel-body">
          <section class="pane active" data-pane="solve">
            <div class="toolbar">
              <button type="button" id="grabTask">抓取题目</button>
              <button type="button" id="grabCode">抓取代码</button>
              <button type="button" id="clearAll">清空</button>
              <span class="grow"></span>
              <span class="editor-hint" id="editorHint">检测编辑器…</span>
            </div>

            <label class="field">
              <span>任务描述 / 编程要求</span>
              <textarea id="taskText" rows="6" placeholder="粘贴任务描述、编程要求、测试说明……"></textarea>
            </label>

            <div class="field">
              <span>模板代码 <span class="file-count" id="fileCount"></span></span>
              <div class="slider file-slider" id="fileSlider">
                <div class="slider-nav" id="fileNav">
                  <button type="button" class="slider-arrow" id="filePrev" title="上一个文件（←）">‹</button>
                  <div class="slider-tabs" id="fileTabs"></div>
                  <button type="button" class="slider-arrow" id="fileNext" title="下一个文件（→）">›</button>
                </div>
                <div class="slider-meta">
                  <span class="slider-counter" id="fileCounter">1 / 1</span>
                  <input id="fileName" class="file-name" placeholder="文件名，例如 Main.java" spellcheck="false">
                  <button type="button" id="fileRemove" class="file-remove" title="删除当前文件">×</button>
                </div>
                <div class="slider-viewport" id="fileViewport">
                  <textarea id="fileCode" class="file-code mono" spellcheck="false" placeholder="粘贴这个文件的完整代码……"></textarea>
                </div>
                <div class="slider-foot">
                  <span class="file-tip" id="fileTip">左右滑动 / ← → 键切换文件</span>
                </div>
              </div>
              <div class="file-actions">
                <button type="button" id="addFile">+ 添加文件</button>
                <button type="button" id="appendCode">+ 追加当前编辑器</button>
                <button type="button" id="regrabCode" title="丢弃当前列表，重新按页面内容抓取（会二次确认）">↻ 重新抓取（覆盖）</button>
                <span class="file-tip">页面只暴露一个编辑器时，切到每个文件标签后点「追加」；「抓取代码」会保留手动内容</span>
              </div>
            </div>

            <details class="more">
              <summary>更多输入（样例、语言、补充要求）</summary>
              <div class="details-body">
                <label class="field">
                  <span>语言</span>
                  <input id="language" placeholder="Java / C / C++ / Python">
                </label>
                <label class="field">
                  <span>样例输入</span>
                  <textarea id="sampleIn" rows="3" class="mono"></textarea>
                </label>
                <label class="field">
                  <span>样例输出</span>
                  <textarea id="sampleOut" rows="3" class="mono"></textarea>
                </label>
                <label class="field">
                  <span>补充要求</span>
                  <textarea id="extraReq" rows="3" placeholder="例如：只能改 Begin/End；必须保留类名 ex2"></textarea>
                </label>
              </div>
            </details>

            <div class="actions">
              <button type="button" class="primary" id="generate">生成答案</button>
              <button type="button" id="cancel" class="hidden">停止</button>
              <span class="timer" id="timer"></span>
            </div>

            <!-- 测评失败后按报错迭代：这是 SKILL 第 7 步的闭环。
                 没有这块，脚本只能生成一次，用户拿着跑不过的答案无处可去。 -->
            <details class="more feedback" id="feedbackBox">
              <summary>测评没通过？把报错贴进来，按反馈修正</summary>
              <div class="details-body">
                <label class="field">
                  <span>测评报错原文（编译错误 / 答案错误 / 运行超时 等）</span>
                  <textarea id="judgeError" rows="3" class="mono" placeholder="例如：答案错误&#10;测试输入: 5&#10;预期输出: 15&#10;实际输出: 14"></textarea>
                </label>
                <label class="field">
                  <span>预期输出（和报错里同一个用例）</span>
                  <textarea id="judgeExpected" rows="2" class="mono" placeholder="15"></textarea>
                </label>
                <label class="field">
                  <span>实际输出</span>
                  <textarea id="judgeActual" rows="2" class="mono" placeholder="14"></textarea>
                </label>
                <div class="file-actions">
                  <button type="button" id="fixByFeedback">按报错修正答案</button>
                  <span class="file-tip">会带上当前答案一起发给模型，只做针对性修改，不重写整个算法</span>
                </div>
              </div>
            </details>

            <div class="answer-head">
              <span>答案</span>
              <div class="answer-actions">
                <button type="button" id="copyAll" disabled>复制全部</button>
                <button type="button" id="insertCode" disabled>填入编辑器</button>
              </div>
            </div>
            <div id="alignBar" class="align-bar hidden"></div>
            <div id="answer" class="answer empty">生成结果会显示在这里。</div>
          </section>

          <section class="pane" data-pane="settings">
            <p class="hint" id="firstRunHint">第一次使用：脚本<b>不自带任何 API Key</b>，需要你用自己的。选一个服务商预设 → 去它的控制台申请 Key → 粘到下面「API Key」→ 点「测试连接」确认可用 → 保存。DeepSeek 最便宜，几块钱能用很久。</p>
            <label class="field">
              <span>服务商预设</span>
              <select id="preset">
                <option value="deepseek">DeepSeek</option>
                <option value="openai">OpenAI</option>
                <option value="moonshot">Moonshot</option>
                <option value="qwen">通义千问（兼容模式）</option>
                <option value="siliconflow">SiliconFlow</option>
                <option value="custom">自定义</option>
              </select>
            </label>

            <label class="field">
              <span>API Base URL</span>
              <input id="baseUrl" placeholder="https://api.deepseek.com/v1">
            </label>

            <label class="field">
              <span>API Key</span>
              <div class="input-row">
                <input id="apiKey" type="password" autocomplete="off" placeholder="sk-...">
                <button type="button" id="toggleKey">显示</button>
              </div>
            </label>

            <label class="field">
              <span>模型</span>
              <input id="model" placeholder="deepseek-chat">
            </label>

            <div class="grid2">
              <label class="field">
                <span>Temperature</span>
                <input id="temperature" type="number" min="0" max="2" step="0.1">
              </label>
              <label class="field">
                <span>Max tokens</span>
                <input id="maxTokens" type="number" min="256" step="256">
              </label>
            </div>

            <label class="check">
              <input id="disableThinking" type="checkbox">
              <span>对推理型模型关闭思考模式（enable_thinking=false）</span>
            </label>
            <p class="hint">推理型模型（Qwen3 / R1 / QwQ / GLM-Z1）的思维链和答案<b>共用</b> Max tokens。思维链吃光预算时，接口会返回 HTTP 200 但正文为空。关掉思考、或把 Max tokens 提到 16384，都能解决。</p>

            <div class="diag">
              <div class="diag-title">本次请求将发往（实时）</div>
              <div class="diag-url" id="endpointPreview">—</div>
              <div class="diag-row">
                <span id="keyPreview">Key：—</span>
                <span id="lastResult">尚未测试</span>
              </div>
              <div class="diag-msg" id="diagMessage"></div>
            </div>

            <div class="actions">
              <button type="button" class="primary" id="saveSettings">保存设置</button>
              <button type="button" id="testApi">测试连接</button>
              <button type="button" id="copyDiagnostics">复制诊断</button>
              <button type="button" id="clearSettings">清除配置</button>
            </div>

            <p class="hint">点「测试连接」会自动保存当前配置。换了服务商却仍报同样的错，先看上方「本次请求将发往」是不是还指向旧地址。</p>
            <p class="hint">API Key 只保存在 Tampermonkey 的本地存储中。请求通过 GM_xmlhttpRequest 直接发往你填写的 Base URL，不经过第三方服务器。</p>
            <p class="hint">接口需兼容 OpenAI 的 /chat/completions。如果 Base URL 已经包含该路径，脚本不会重复拼接。</p>

            <div class="diag">
              <div class="diag-title">面板位置</div>
              <div class="pos-row">
                <button type="button" id="posLeft" title="贴到左上角">⇤ 左上</button>
                <button type="button" id="posRight" title="贴到右上角">⇥ 右上</button>
                <button type="button" id="posCenter" title="居中">◎ 居中</button>
                <button type="button" id="posReset" title="回到默认位置（右下角）">↺ 默认</button>
              </div>
              <p class="hint">面板拖不动时用这里的按钮换位置；也可以聚焦标题栏后用方向键微调（Shift + 方向键加速）。</p>
            </div>

            <div class="diag">
              <div class="diag-title">拖动自检（拖不动时点这里）</div>
              <p class="hint">点下面的按钮，再按住标题栏拖一下，然后把结果复制给我。</p>
              <div class="actions">
                <button type="button" id="runDragSelfTest">开始自检</button>
                <button type="button" id="copyDragReport">复制自检结果</button>
              </div>
              <div class="diag-pre hidden" id="dragReport"></div>
            </div>
          </section>
        </div>

        <div class="statusbar">
          <span id="status">就绪</span>
          <span id="statusMeta"></span>
        </div>
      </div>
    `;
  }

  function openPanel() {
    $('#panel').classList.remove('hidden');
    updateEditorHint();
    if (state.firstOpen) {
      state.firstOpen = false;
      setTimeout(autoGrab, 400);
      // 编辑器或题面可能加载较慢，稍后再补抓一次
      setTimeout(function () {
        if (!$('#taskText').value.trim()) grabTask(true);
        if (!hasAnyCode()) {
          grabCode(true).catch(function () { /* 忽略 */ });
        }
      }, 1800);
    }
  }

  function closePanel() {
    $('#panel').classList.add('hidden');
  }

  // 触摸左右滑动切换文件。direction: 1 向后、-1 向前
  function bindSwipe(element, onSwipe) {
    if (!element) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;

    element.addEventListener('touchstart', function (event) {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      tracking = true;
    }, { passive: true });

    element.addEventListener('touchend', function (event) {
      if (!tracking || !event.changedTouches.length) return;
      tracking = false;
      const dx = event.changedTouches[0].clientX - startX;
      const dy = event.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      onSwipe(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function initDrag() {
    const panel = $('#panel');
    const handle = $('#dragHandle');
    if (!panel || !handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    function pointOf(event) {
      if (event.touches && event.touches.length) {
        return { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }
      if (event.changedTouches && event.changedTouches.length) {
        return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
      }
      if (typeof event.clientX === 'number') {
        return { x: event.clientX, y: event.clientY };
      }
      return null;
    }

    function beginDrag(event) {
      if (dragging) return;
      const target = event.target;
      if (target && target.closest && target.closest('button')) return;
      // 只响应主键；touch 事件没有 button
      if (typeof event.button === 'number' && event.button !== 0) return;

      const point = pointOf(event);
      if (!point) return;

      const rect = panel.getBoundingClientRect();
      panel.classList.add('dragged');
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';

      dragging = true;
      startX = point.x;
      startY = point.y;
      startLeft = rect.left;
      startTop = rect.top;
      applyDragLock(true);

      if (event.pointerId !== undefined) {
        try {
          handle.setPointerCapture(event.pointerId);
        } catch (e) {
          // 忽略
        }
      }
      if (event.cancelable) event.preventDefault();
    }

    function moveDrag(event) {
      if (!dragging) return;
      const point = pointOf(event);
      if (!point) return;

      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      // 面板比视口还高时，纵向上限会小于下限，这里保证至少能贴顶
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      const maxTop = Math.max(8, window.innerHeight - height - 8);
      const left = clamp(startLeft + point.x - startX, 8, maxLeft);
      const top = clamp(startTop + point.y - startY, 8, maxTop);

      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      if (event.cancelable) event.preventDefault();
    }

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      applyDragLock(false);
      savePanelRect();
    }

    // ---- 入口 1：pointer 事件（现代浏览器首选）----
    handle.addEventListener('pointerdown', beginDrag);
    // ---- 入口 2：mouse 事件兜底（PointerEvent 被页面污染/不支持时）----
    handle.addEventListener('mousedown', beginDrag);
    // ---- 入口 3：触摸兜底 ----
    handle.addEventListener('touchstart', beginDrag, { passive: false });

    // 移动监听挂在 window 捕获阶段：指针离开标题栏/离开窗口也不会丢
    ['pointermove', 'mousemove', 'touchmove'].forEach(function (type) {
      window.addEventListener(type, function (event) {
        if (!dragging) return;
        if (type === 'mousemove' && event.buttons === 0) {
          endDrag();
          return;
        }
        moveDrag(event);
      }, { capture: true, passive: false });
    });

    ['pointerup', 'pointercancel', 'mouseup', 'touchend', 'touchcancel'].forEach(function (type) {
      window.addEventListener(type, endDrag, true);
    });
    window.addEventListener('blur', endDrag);

    // 双击标题栏复位到默认位置
    handle.addEventListener('dblclick', function (event) {
      if (event.target.closest('button')) return;
      resetPanelPosition();
    });

    window.addEventListener('resize', function () {
      if (!panel.classList.contains('dragged')) return;
      const rect = panel.getBoundingClientRect();
      const left = clamp(rect.left, 8, Math.max(8, window.innerWidth - rect.width - 8));
      const top = clamp(rect.top, 8, Math.max(8, window.innerHeight - rect.height - 8));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    });

    restorePanelRect();
  }

  function resetPanelPosition() {
    const panel = $('#panel');
    if (!panel) return;
    panel.classList.remove('dragged');
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
    clearPanelRect();
    setStatus('面板位置已复位', '');
  }

  // 把面板挪到指定格子。鼠标拖动失灵时的兜底：不依赖任何鼠标事件。
  function movePanelTo(where) {
    const panel = $('#panel');
    if (!panel) return;
    if (where === 'default') {
      resetPanelPosition();
      return;
    }

    const margin = 20;
    const rect = panel.getBoundingClientRect();
    const width = rect.width || panel.offsetWidth || 0;
    const height = rect.height || panel.offsetHeight || 0;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);

    let left = maxLeft;
    let top = maxTop;
    if (where === 'left') {
      left = margin;
      top = margin;
    } else if (where === 'right') {
      left = maxLeft;
      top = margin;
    } else if (where === 'center') {
      left = Math.max(margin, Math.round((window.innerWidth - width) / 2));
      top = Math.max(margin, Math.round((window.innerHeight - height) / 2));
    }

    panel.classList.add('dragged');
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    savePanelRect();
    setStatus('面板已移到' + ({ left: '左上', right: '右上', center: '居中' }[where] || '指定位置'), '');
  }

  // 标题栏聚焦后用方向键微调，完全不依赖鼠标
  function initKeyboardMove() {
    const panel = $('#panel');
    const handle = $('#dragHandle');
    if (!panel || !handle) return;

    handle.addEventListener('keydown', function (event) {
      const step = event.shiftKey ? 48 : 12;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();

      const rect = panel.getBoundingClientRect();
      if (!panel.classList.contains('dragged')) {
        panel.classList.add('dragged');
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
      }
      const left = clamp(rect.left + move[0], 8, Math.max(8, window.innerWidth - rect.width - 8));
      const top = clamp(rect.top + move[1], 8, Math.max(8, window.innerHeight - rect.height - 8));
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
      savePanelRect();
    });
  }

  // ------------------------------------------------------------
  // 拖动自检：把"拖不动"这件事变成一个可复制的文本报告。
  // 我看不到用户的屏幕，但看得到这份报告，就能定位是哪一环断了。
  // ------------------------------------------------------------
  let dragProbe = null;

  function startDragSelfTest() {
    const box = $('#dragReport');
    const panel = $('#panel');
    const handle = $('#dragHandle');
    if (!handle || !panel) return;

    panel.classList.remove('hidden');
    switchTab('settings');

    const hosts = document.querySelectorAll('#educoder-ai-helper-host');
    const rect = panel.getBoundingClientRect();
    const lines = [
      '脚本版本：v' + SCRIPT_VERSION,
      '宿主实例数：' + hosts.length + (hosts.length > 1 ? '（不止一个，说明装了两份脚本，必须删掉旧的）' : '（正常）'),
      '面板位置：left=' + Math.round(rect.left) + ' top=' + Math.round(rect.top) +
        ' w=' + Math.round(rect.width) + ' h=' + Math.round(rect.height),
      '视口：' + window.innerWidth + '×' + window.innerHeight,
      '纵向可移动距离：' + Math.max(0, window.innerHeight - Math.round(rect.height) - 16) + 'px' +
        (window.innerHeight - Math.round(rect.height) - 16 < 24 ? '（太小，几乎拖不动 —— 先把窗口调高或点上面的位置按钮）' : ''),
      'PointerEvent 支持：' + (typeof window.PointerEvent === 'function' ? '是' : '否'),
      '标题栏可聚焦：' + (handle.getAttribute('tabindex') === '0' ? '是' : '否'),
      '拖动锁样式：' + (document.querySelector('style[data-educoder-helper="drag-lock"]') ? '存在' : '不存在'),
      '',
      '>>> 现在请按住标题栏拖动一下（往下拖 100px 以上）。'
    ];

    box.classList.remove('hidden');
    box.textContent = lines.join('\n');

    dragProbe = { start: null, moves: 0, downSeen: false, lastPoint: null, timer: null };

    function onDown(event) {
      if (!dragProbe) return;
      dragProbe.downSeen = true;
      dragProbe.downType = event.type;
    }

    function onMove(event) {
      if (!dragProbe) return;
      dragProbe.moves += 1;
      const point = (event.touches && event.touches[0]) || event;
      dragProbe.lastPoint = { x: point.clientX, y: point.clientY };
    }

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('touchstart', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('touchmove', onMove, true);

    dragProbe.cleanup = function () {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('touchstart', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('touchmove', onMove, true);
    };

    // 5 秒后出结论
    dragProbe.timer = setTimeout(function () {
      if (!dragProbe) return;
      const probe = dragProbe;
      const now = panel.getBoundingClientRect();
      const report = lines.concat([
        '',
        '--- 拖动结果 ---',
        '收到按下事件：' + (probe.downSeen ? '是（' + (probe.downType || '?') + '）' : '否'),
        '收到移动事件数：' + probe.moves,
        '面板现在位置：left=' + Math.round(now.left) + ' top=' + Math.round(now.top),
        '面板位置变化：' + (rect.left !== Math.round(now.left) || rect.top !== Math.round(now.top) ? '有' : '无'),
        '',
        '判定：' + buildDragVerdict(probe, rect, now)
      ]);
      box.textContent = report.join('\n');
      probe.cleanup();
      dragProbe = null;
    }, 5000);

    setStatus('自检已开始，请按住标题栏拖动一下（5 秒后出结果）', '');
  }

  function buildDragVerdict(probe, before, after) {
    if (!probe.downSeen) {
      return '标题栏上没收到任何按下事件 —— 面板上层可能盖着别的元素（元素检查器里看最上层是什么）。';
    }
    if (probe.moves === 0) {
      return '收到了按下但没有任何移动事件 —— 事件被页面或某个 iframe 吞掉了。试试点「左上/右上」按钮移动。';
    }
    if (before.left === Math.round(after.left) && before.top === Math.round(after.top)) {
      return '有移动事件但面板没动 —— 面板已经顶到边界，或高度几乎占满视口。点「居中」或先把浏览器窗口拉高。';
    }
    return '拖动正常。';
  }

  function copyDragReport() {
    const box = $('#dragReport');
    if (!box || box.classList.contains('hidden')) {
      setStatus('先点「开始自检」并拖动一下，再复制', 'warn');
      return;
    }
    const text = box.textContent || '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          setStatus('自检结果已复制，可以直接发给我', 'ok');
        }, function () {
          setStatus('复制失败，请手动选中下面的文字复制', 'warn');
        });
      } else {
        setStatus('浏览器不允许自动复制，请手动选中下面的文字复制', 'warn');
      }
    } catch (e) {
      setStatus('复制失败，请手动选中下面的文字复制', 'warn');
    }
  }

  // shadow DOM 里的 CSS 管不到宿主页面，这里用内联样式直接锁住页面。
  // 主要目的：拖动经过 iframe 时，iframe 会抢走鼠标事件导致拖动中断。
  let dragLockStyle = null;

  function applyDragLock(lock) {
    try {
      if (lock) {
        if (dragLockStyle) return;
        dragLockStyle = document.createElement('style');
        dragLockStyle.setAttribute('data-educoder-helper', 'drag-lock');
        dragLockStyle.textContent =
          'html, html * { user-select: none !important; }' +
          'html iframe { pointer-events: none !important; }';
        (document.head || document.documentElement).appendChild(dragLockStyle);
      } else if (dragLockStyle) {
        dragLockStyle.remove();
        dragLockStyle = null;
      }
    } catch (e) {
      // 忽略
    }
  }

  // 记住面板位置，刷新页面后不用重新拖
  const PANEL_RECT_KEY = 'educoder_ai_helper_panel_rect_v1';

  function savePanelRect() {
    const panel = $('#panel');
    if (!panel || !panel.classList.contains('dragged')) return;
    const rect = panel.getBoundingClientRect();
    storageSet(PANEL_RECT_KEY, { left: Math.round(rect.left), top: Math.round(rect.top) });
  }

  function clearPanelRect() {
    try {
      if (typeof GM_deleteValue === 'function') {
        GM_deleteValue(PANEL_RECT_KEY);
      } else {
        storageSet(PANEL_RECT_KEY, null);
      }
    } catch (e) {
      // 忽略
    }
  }

  function restorePanelRect() {
    const panel = $('#panel');
    if (!panel) return;
    const saved = storageGet(PANEL_RECT_KEY, null);
    if (!saved || typeof saved !== 'object') return;
    const left = Number(saved.left);
    const top = Number(saved.top);
    if (!isFinite(left) || !isFinite(top)) return;

    panel.classList.add('dragged');
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = clamp(left, 8, Math.max(8, window.innerWidth - panel.offsetWidth - 8)) + 'px';
    panel.style.top = clamp(top, 8, Math.max(8, window.innerHeight - panel.offsetHeight - 8)) + 'px';
  }

  // ------------------------------------------------------------
  // 悬浮球（fab）拖动
  // 难点：它同时要能被"拖动"和"点击打开面板"。
  // 做法：按下后先不判定，移动超过 5px 才进入拖动；松手时若没拖动过就当点击。
  // ------------------------------------------------------------
  const FAB_POS_KEY = 'educoder_ai_helper_fab_pos_v1';
  // 拖动松手时浏览器会在松手位置补发一个 click，必须区分"拖动的尾巴"和"用户的真实点击"。
  // 判定依据：只有 click 坐标与拖动结束坐标几乎重合、且时间极近，才算尾巴。
  // 之前试过时间窗（会吞掉拖完立刻点击）和一次性守卫（浏览器不补 click 时会一直挂着），都有副作用。
  let fabTail = null; // { x, y, at }

  function markFabTail(x, y) {
    fabTail = { x: x, y: y, at: Date.now() };
    // 400ms 后自动失效，避免残留
    setTimeout(function () { fabTail = null; }, 400);
  }

  function isFabTail(event) {
    if (!fabTail) return false;
    if (Date.now() - fabTail.at > 400) return false;
    const dx = Math.abs((event.clientX || 0) - fabTail.x);
    const dy = Math.abs((event.clientY || 0) - fabTail.y);
    const sameSpot = dx <= 6 && dy <= 6;
    if (sameSpot) fabTail = null;
    return sameSpot;
  }

  function fabRectClamp(left, top) {
    const fab = $('#fab');
    if (!fab) return { left: left, top: top };
    const rect = fab.getBoundingClientRect();
    const w = rect.width || 100;
    const h = rect.height || 40;
    return {
      left: clamp(left, 4, Math.max(4, window.innerWidth - w - 4)),
      top: clamp(top, 4, Math.max(4, window.innerHeight - h - 4))
    };
  }

  function placeFab(left, top) {
    const fab = $('#fab');
    if (!fab) return;
    const pos = fabRectClamp(left, top);
    fab.classList.add('moved');
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    fab.style.left = Math.round(pos.left) + 'px';
    fab.style.top = Math.round(pos.top) + 'px';
  }

  function saveFabPos() {
    const fab = $('#fab');
    if (!fab || !fab.classList.contains('moved')) return;
    const rect = fab.getBoundingClientRect();
    storageSet(FAB_POS_KEY, { left: Math.round(rect.left), top: Math.round(rect.top) });
  }

  function restoreFabPos() {
    const fab = $('#fab');
    if (!fab) return;
    const saved = storageGet(FAB_POS_KEY, null);
    if (!saved || typeof saved !== 'object') return;
    const left = Number(saved.left);
    const top = Number(saved.top);
    if (!isFinite(left) || !isFinite(top)) return;
    placeFab(left, top);
  }

  function resetFabPos() {
    const fab = $('#fab');
    if (!fab) return;
    fab.classList.remove('moved');
    fab.style.left = '';
    fab.style.top = '';
    fab.style.right = '';
    fab.style.bottom = '';
    try {
      if (typeof GM_deleteValue === 'function') {
        GM_deleteValue(FAB_POS_KEY);
      } else {
        storageSet(FAB_POS_KEY, null);
      }
    } catch (e) {
      // 忽略
    }
  }

  function initFabDrag() {
    const fab = $('#fab');
    if (!fab) return;

    const THRESHOLD = 5; // 超过 5px 才算拖动，低于则视为点击
    let pressing = false;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    function pointOf(event) {
      if (event.touches && event.touches.length) {
        return { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }
      if (event.changedTouches && event.changedTouches.length) {
        return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
      }
      if (typeof event.clientX === 'number') {
        return { x: event.clientX, y: event.clientY };
      }
      return null;
    }

    function begin(event) {
      if (pressing) return;
      if (typeof event.button === 'number' && event.button !== 0) return;

      const point = pointOf(event);
      if (!point) return;

      const rect = fab.getBoundingClientRect();
      pressing = true;
      dragging = false;
      startX = point.x;
      startY = point.y;
      startLeft = rect.left;
      startTop = rect.top;

      // 先固化成 left/top，避免拖动过程中 right/bottom 参与计算
      fab.classList.add('moved');
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      fab.style.left = rect.left + 'px';
      fab.style.top = rect.top + 'px';

      if (event.pointerId !== undefined) {
        try {
          fab.setPointerCapture(event.pointerId);
        } catch (e) {
          // 忽略
        }
      }
    }

    function move(event) {
      if (!pressing) return;
      const point = pointOf(event);
      if (!point) return;

      const dx = point.x - startX;
      const dy = point.y - startY;

      if (!dragging && Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;

      if (!dragging) {
        dragging = true;
        fab.classList.add('dragging');
        applyDragLock(true);
      }

      placeFab(startLeft + dx, startTop + dy);
      if (event.cancelable) event.preventDefault();
    }

    function end() {
      if (!pressing) return;
      pressing = false;

      const wasDragging = dragging;
      dragging = false;
      fab.classList.remove('dragging');

      if (wasDragging) {
        applyDragLock(false);
        saveFabPos();
        // 记住松手位置，用来识别紧随其后的那一下 click 是不是拖动的尾巴
        const doneRect = fab.getBoundingClientRect();
        markFabTail(doneRect.left + doneRect.width / 2, doneRect.top + doneRect.height / 2);
      } else {
        // 没拖动：退回到原本的 right/bottom 定位，保持视觉一致
        if (!storageGet(FAB_POS_KEY, null)) {
          fab.classList.remove('moved');
          fab.style.left = '';
          fab.style.top = '';
          fab.style.right = '';
          fab.style.bottom = '';
        }
      }
    }

    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (type) {
      fab.addEventListener(type, begin, type === 'touchstart' ? { passive: true } : undefined);
    });

    ['pointermove', 'mousemove', 'touchmove'].forEach(function (type) {
      window.addEventListener(type, function (event) {
        if (!pressing) return;
        if (type === 'mousemove' && event.buttons === 0) {
          end();
          return;
        }
        move(event);
      }, { capture: true, passive: false });
    });

    ['pointerup', 'pointercancel', 'mouseup', 'touchend', 'touchcancel'].forEach(function (type) {
      window.addEventListener(type, function () {
        if (!pressing) return;
        end();
      }, true);
    });

    window.addEventListener('blur', function () {
      if (pressing) end();
    });

    // 双击小球复位到右下角
    fab.addEventListener('dblclick', function (event) {
      event.preventDefault();
      event.stopPropagation();
      resetFabPos();
      setStatus('悬浮球位置已复位', '');
    });

    // 窗口尺寸变化时，把小球拉回可视范围
    window.addEventListener('resize', function () {
      if (!fab.classList.contains('moved')) return;
      const rect = fab.getBoundingClientRect();
      placeFab(rect.left, rect.top);
    });

    restoreFabPos();
  }

  function bindEvents() {
    $('#fab').addEventListener('click', function (event) {
      // 只有坐标和松手点重合的 click 才是拖动的尾巴；用户换个位置点（或紧接着点）都照常生效
      if (isFabTail(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if ($('#panel').classList.contains('hidden')) {
        openPanel();
      } else {
        closePanel();
      }
    });

    shadow.addEventListener('click', function (event) {
      const actionButton = event.target.closest('[data-action]');
      if (actionButton) {
        const action = actionButton.dataset.action;
        if (action === 'close') closePanel();
        if (action === 'minimize') {
          $('#panel').classList.toggle('minimized');
        }
        if (action === 'settings') {
          $('#panel').classList.remove('minimized');
          openPanel();
          switchTab('settings');
        }
        return;
      }

      const sliderButton = event.target.closest('[data-slider-action]');
      if (sliderButton) {
        const sliderAction = sliderButton.dataset.sliderAction;
        if (sliderAction === 'ans-prev') showAnswerFileAt(state.activeAnswerFile - 1, -1);
        if (sliderAction === 'ans-next') showAnswerFileAt(state.activeAnswerFile + 1, 1);
        return;
      }

      const answerTab = event.target.closest('.slider-tab[data-ans-index]');
      if (answerTab) {
        const tabIndex = Number(answerTab.dataset.ansIndex);
        showAnswerFileAt(tabIndex, tabIndex > state.activeAnswerFile ? 1 : -1);
        return;
      }

      const insertSingle = event.target.closest('.insert-single-code');
      if (insertSingle) {
        insertAnswerCode(Number(insertSingle.dataset.index));
        return;
      }

      const copyCodeButton = event.target.closest('.copy-code');
      if (copyCodeButton) {
        const index = Number(copyCodeButton.dataset.index);
        const code = state.codeBlocks[index] || '';
        copyText(code)
          .then(function () {
            setStatus('代码已复制', 'ok');
          })
          .catch(function (error) {
            setStatus('复制失败：' + error.message, 'error');
          });
      }
    });

    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchTab(tab.dataset.tab);
      });
    });

    $('#grabTask').addEventListener('click', function () {
      grabTask(false);
    });

    $('#grabCode').addEventListener('click', function () {
      // 锁由 grabCode 自己持有，这里只负责按钮的禁用状态
      const button = $('#grabCode');
      const original = button ? button.textContent : '';
      if (button) {
        button.disabled = true;
        button.textContent = '抓取中…';
      }
      Promise.resolve(grabCode(false, false)).finally(function () {
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
      });
    });

    $('#regrabCode').addEventListener('click', function () {
      const button = $('#regrabCode');
      const original = button ? button.textContent : '';
      if (button) {
        button.disabled = true;
        button.textContent = '抓取中…';
      }
      Promise.resolve(grabCode(false, true)).finally(function () {
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
      });
    });

    $('#addFile').addEventListener('click', function () {
      addFileCard('', '', 'manual');
    });

    $('#appendCode').addEventListener('click', appendCurrentCode);

    // ---- 模板代码滑框 ----
    $('#filePrev').addEventListener('click', function () {
      showFileAt(state.activeFile - 1, -1);
    });

    $('#fileNext').addEventListener('click', function () {
      showFileAt(state.activeFile + 1, 1);
    });

    $('#fileRemove').addEventListener('click', removeCurrentFile);

    $('#fileTabs').addEventListener('click', function (event) {
      const tab = event.target.closest('.slider-tab');
      if (!tab) return;
      const index = Number(tab.dataset.fileIndex);
      showFileAt(index, index > state.activeFile ? 1 : -1);
    });

    $('#fileName').addEventListener('input', function () {
      const file = currentFile();
      file.name = this.value;
      file.origin = 'manual';
      const tab = $('#fileTabs .slider-tab[data-file-index="' + state.activeFile + '"]');
      if (tab) {
        tab.textContent = shortFileName(file.name, state.activeFile);
        tab.title = file.name || ('文件 ' + (state.activeFile + 1));
      }
    });

    $('#fileCode').addEventListener('input', function () {
      const file = currentFile();
      file.code = this.value;
      file.origin = 'manual';
      // 填了代码就去掉「待填」虚线样式
      const tab = $('#fileTabs .slider-tab[data-file-index="' + state.activeFile + '"]');
      if (tab) tab.classList.toggle('pending', isPendingFile(file));
    });

    // 左右方向键切换；光标在输入框里时不拦截
    $('#fileSlider').addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const tag = event.target.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (state.files.length < 2) return;
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      event.preventDefault();
      showFileAt(state.activeFile + direction, direction);
    });

    bindSwipe($('#fileViewport'), function (direction) {
      showFileAt(state.activeFile + direction, direction);
    });

    $('#clearAll').addEventListener('click', function () {
      if (!confirmAction('清空题目、代码、样例和答案？')) return;
      ['taskText', 'language', 'sampleIn', 'sampleOut', 'extraReq', 'judgeError', 'judgeExpected', 'judgeActual'].forEach(function (id) {
        const element = $('#' + id);
        if (element) element.value = '';
      });
      state.files = [];
      state.fileSeq = 0;
      state.activeFile = 0;
      state.pageFileNames = [];
      renderFiles();
      state.answerRaw = '';
      state.answerCode = '';
      state.codeBlocks = [];
      state.answerFiles = [];
      state.activeAnswerFile = 0;
      const answer = $('#answer');
      answer.innerHTML = '生成结果会显示在这里。';
      answer.classList.add('empty');
      $('#copyAll').disabled = true;
      $('#insertCode').disabled = true;
      setStatus('已清空', '');
    });

    $('#generate').addEventListener('click', function () {
      // 注意不能直接传事件对象，否则会被当成 mode
      generateAnswer('fresh');
    });

    // SKILL 第 7 步：测评失败后按报错迭代
    $('#fixByFeedback').addEventListener('click', function () {
      generateAnswer('fix');
    });

    $('#cancel').addEventListener('click', function () {
      if (state.request && typeof state.request.abort === 'function') {
        try {
          state.request.abort();
        } catch (e) {
          // 忽略
        }
        setStatus('正在停止…', 'warn');
      }
    });

    $('#copyAll').addEventListener('click', function () {
      copyText(state.answerRaw)
        .then(function () {
          setStatus('答案已复制', 'ok');
        })
        .catch(function (error) {
          setStatus('复制失败：' + error.message, 'error');
        });
    });

    $('#insertCode').addEventListener('click', function () {
      insertAnswerCode();
    });

    $('#saveSettings').addEventListener('click', function () {
      if (saveSettings(false)) updateDiagnosticsPreview();
    });

    $('#testApi').addEventListener('click', testApi);

    $('#copyDiagnostics').addEventListener('click', function () {
      copyText(buildDiagnosticText())
        .then(function () {
          setStatus('诊断信息已复制（不含完整 Key）', 'ok');
        })
        .catch(function (error) {
          setStatus('复制失败：' + error.message, 'error');
        });
    });

    $('#clearSettings').addEventListener('click', function () {
      if (!confirmAction('清除本地保存的 API 配置并恢复默认值？需要重新填写 API Key。')) return;
      try {
        storageSet(STORAGE_KEY, {});
      } catch (e) {
        // 忽略存储失败
      }
      state.settings = Object.assign({}, DEFAULTS);
      state.lastDiagnostics = null;
      fillSettingsForm();
      updateDiagnosticsPreview();
      setDiagMessage('已恢复默认设置。请重新选服务商、填 Key，再看上方「本次请求将发往」。', false);
      setStatus('本地配置已清除', 'ok');
    });

    ['baseUrl', 'apiKey', 'model'].forEach(function (id) {
      const element = $('#' + id);
      if (element) element.addEventListener('input', updateDiagnosticsPreview);
    });

    // 面板位置预设与拖动自检
    [['posLeft', 'left'], ['posRight', 'right'], ['posCenter', 'center'], ['posReset', 'default']]
      .forEach(function (pair) {
        const element = $('#' + pair[0]);
        if (element) element.addEventListener('click', function () { movePanelTo(pair[1]); });
      });

    const selfTestButton = $('#runDragSelfTest');
    if (selfTestButton) selfTestButton.addEventListener('click', startDragSelfTest);
    const copyReportButton = $('#copyDragReport');
    if (copyReportButton) copyReportButton.addEventListener('click', copyDragReport);
    initKeyboardMove();

    $('#toggleKey').addEventListener('click', function () {
      const input = $('#apiKey');
      input.type = input.type === 'password' ? 'text' : 'password';
      this.textContent = input.type === 'password' ? '显示' : '隐藏';
    });

    $('#preset').addEventListener('change', function () {
      const preset = PRESETS[this.value];
      if (!preset) return;
      if (this.value !== 'custom') {
        $('#baseUrl').value = preset.baseUrl;
        $('#model').value = preset.model;
        setStatusMeta(preset.model);
        setStatus('已切换到 ' + preset.label + '，填写 API Key 后测试', '');
      }

      // 切到推理型模型时顺手把预算抬起来：预设里的模型名（如 qwen3-*、*-r1）
      // 一旦是推理型，沿用 4096/8192 就很容易"只想不写"，返回空正文。
      const budgetField = $('#maxTokens');
      const thinkingField = $('#disableThinking');
      if (budgetField && isReasoningModel($('#model').value)) {
        const current = parseInt(budgetField.value, 10) || 0;
        if (current < 16384) budgetField.value = '16384';
      }
      if (thinkingField) thinkingField.checked = true;

      updateDiagnosticsPreview();
    });
  }

  function init() {
    // 只在任务页注入，避免站内其他页面出现悬浮按钮
    if (!/\/tasks\//.test(location.pathname)) return;

    buildUI();
    bindEvents();
    initDrag();
    initFabDrag();
    const versionTag = $('#versionTag');
    if (versionTag) versionTag.textContent = 'v' + SCRIPT_VERSION;
    fillSettingsForm();
    updateDiagnosticsPreview();
    renderFiles();
    updateEditorHint();

    setInterval(updateEditorHint, 3000);

    // 调试钩子：验证页/排查时可以调用，不影响正常使用
    try {
      unsafeWindow.__educoderHelperDebug = {
        findEditors: findEditors,
        readEditorFully: readEditorFully,
        readMonacoViewLines: readMonacoViewLines,
        findScrollableAncestor: findScrollableAncestor,
        harvestByScrolling: harvestByScrolling,
        extractSamplesFromTaskText: extractSamplesFromTaskText,
        harvestMonacoByScroll: harvestMonacoByScroll,
        mergeOverlappingText: mergeOverlappingText,
        detectPageFileTabs: detectPageFileTabs,
        detectPageFileNames: detectPageFileNames,
        // 空内容诊断相关（v1.8.1）
        apiRequest: apiRequest,
        apiRequestWithRetry: apiRequestWithRetry,
        isReasoningModel: isReasoningModel,
        describeEmptyContent: describeEmptyContent,
        salvageEmptyContent: salvageEmptyContent,
        extractMessageContent: extractMessageContent,
        readSettingsForm: readSettingsForm,
        // 模板契约对齐 + 样例验算（v1.8.2）
        templateContract: templateContract,
        alignAnswerToTemplate: alignAnswerToTemplate,
        extractAnswerFiles: extractAnswerFiles,
        parseAnswerBlocks: parseAnswerBlocks,
        parseVerificationTrace: parseVerificationTrace,
        diffFirstMismatch: diffFirstMismatch,
        evaluateSampleCheck: evaluateSampleCheck,
        filterAnswerProse: filterAnswerProse,
        renderAnswer: renderAnswer,
        buildUserPrompt: buildUserPrompt,
        getSettings: function () {
          return Object.assign({}, state.settings);
        },
        getLastDiagnostics: function () {
          return state.lastDiagnostics ? Object.assign({}, state.lastDiagnostics) : null;
        },
        getState: function () {
          return {
            files: state.files.map(function (file) {
              return {
                name: file.name,
                origin: file.origin,
                lines: (file.code || '').split('\n').length,
                len: (file.code || '').length
              };
            }),
            activeFile: state.activeFile
          };
        },
        version: SCRIPT_VERSION
      };
    } catch (e) {
      // 忽略
    }

    // 头歌是单页应用，切换到另一道题时重置输入，避免串题
    let lastPath = location.pathname;
    setInterval(function () {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;

      state.firstOpen = true;
      state.answerRaw = '';
      state.answerCode = '';
      state.codeBlocks = [];
      state.answerFiles = [];
      state.activeAnswerFile = 0;
      state.generationId++;

      if (state.request && typeof state.request.abort === 'function') {
        try {
          state.request.abort();
        } catch (e) {
          // 忽略
        }
      }
      state.request = null;
      state.busy = false;
      stopTimer();

      const generateButton = $('#generate');
      const cancelButton = $('#cancel');
      if (generateButton) generateButton.disabled = false;
      if (cancelButton) cancelButton.classList.add('hidden');

      ['taskText', 'language', 'sampleIn', 'sampleOut', 'extraReq', 'judgeError', 'judgeExpected', 'judgeActual'].forEach(function (id) {
        const element = $('#' + id);
        if (element) element.value = '';
      });
      state.files = [];
      state.fileSeq = 0;
      state.activeFile = 0;
      state.pageFileNames = [];
      renderFiles();

      const answer = $('#answer');
      if (answer) {
        answer.innerHTML = '生成结果会显示在这里。';
        answer.classList.add('empty');
      }

      const copyButton = $('#copyAll');
      const insertButton = $('#insertCode');
      if (copyButton) copyButton.disabled = true;
      if (insertButton) insertButton.disabled = true;

      if (!$('#panel').classList.contains('hidden')) {
        setTimeout(autoGrab, 600);
      }
    }, 1000);

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('打开 Helper', openPanel);
      }
    } catch (e) {
      // 忽略
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
