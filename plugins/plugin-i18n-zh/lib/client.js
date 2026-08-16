// @dsh-kit/plugin-i18n-zh — browser half.
// 汉化 UI 插件：
//   1. 优先把语言强制切到中文（dsh 大部分插件自带 zh 词典，切换即整体汉化）；
//   2. 再用 MutationObserver 做 DOM 兜底翻译，把仍显示英文的常见标签/按钮/
//      占位符按词典批量替换成中文。
//
// 采用与现有 @dsh-kit/plugin-market 相同的 __ModuleLoader__ 手写 bundle 方言，
// 无需构建步骤。

window.__ModuleLoader__.load({
  id: "@dsh-kit/plugin-i18n-zh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    //#region localization dictionary
    // key: 精确英文原文（区分大小写，优先精确命中），value: 中文
    const DICT = {
      // 会话 / 会话区
      "New Session": "新会话",
      "New session": "新建会话",
      "Start a new session": "新建会话",
      "Search sessions": "搜索会话",
      "No sessions yet": "暂无会话",
      "History": "历史会话",
      "Today": "今天",
      "Yesterday": "昨天",
      "Previous 7 days": "近 7 天",
      "Previous 30 days": "近 30 天",
      // 通用操作
      "Open sidebar": "打开侧边栏",
      "Collapse sidebar": "收起侧边栏",
      "Settings": "设置",
      "General": "通用",
      "Models": "模型",
      "Plugins": "插件",
      "Plugin Inventory": "插件清单",
      "Language": "语言",
      "Cancel": "取消",
      "Save": "保存",
      "Close": "关闭",
      "Copy": "复制",
      "Copied": "已复制",
      "Delete": "删除",
      "Remove": "移除",
      "Edit": "编辑",
      "Search": "搜索",
      "Loading": "加载中",
      "Loading…": "加载中…",
      "More": "更多",
      "Back": "返回",
      "Retry": "重试",
      "Refresh": "刷新",
      "Submit": "提交",
      "Next": "下一步",
      "Previous": "上一步",
      "Apply": "应用",
      "Reset": "重置",
      "Install": "安装",
      "Uninstall": "卸载",
      "Open": "打开",
      "Run": "运行",
      "Stop": "停止",
      "Send": "发送",
      // 输入区 / 命令
      "Type a message": "输入消息…",
      "Ask anything": "问点什么…",
      "Input": "输入",
      "Message": "消息",
      "Send message": "发送消息",
      "Composer": "输入框",
      "Yesterday afternoon": "昨天下午",
      // 模型 / 运行
      "Default model": "默认模型",
      "Model": "模型",
      "Tools": "工具",
      "Tool": "工具",
      "Running": "运行中",
      "Stopped": "已停止",
      "Failed": "失败",
      "Success": "成功",
      "completed": "已完成",
      "error": "错误",
      "Error": "错误",
      "Status": "状态",
      "Active": "已启用",
      "Disabled": "已停用",
      "Enabled": "已启用",
      "unknown": "未知",
      "Warning": "警告",
      "Reasoning": "思考",
      "reasoning": "思考",
      "Result": "结果",
      "Results": "结果",
      // 工作区 / 文件
      "Workspace": "工作区",
      "Workspaces": "工作区",
      "Directory": "目录",
      "Folder": "文件夹",
      "File": "文件",
      "Open Folder": "打开文件夹",
      "Choose a folder": "选择一个文件夹",
      "Current working directory": "当前工作目录",
      "Working directory": "工作目录",
      "Name": "名称",
      "Size": "大小",
      "Modified": "修改时间",
      "Type": "类型",
      // 更新 / 应用
      "Update available": "发现更新",
      "Check for updates": "检查更新",
      "Check Updates": "检查更新",
      "Download": "下载",
      "Downloading": "下载中",
      "Installing": "安装中",
      "Latest version": "最新版本",
      "current version": "当前版本",
      "Up to date": "已是最新",
      "About": "关于",
      "Version": "版本",
      "Profile": "配置",
      "Add": "添加",
      "New": "新建",
      "create": "创建",
      "Confirm": "确认",
      "Yes": "是",
      "No": "否",
      "All": "全部",
      "None": "无",
      // 日志 / 对话
      "Console": "控制台",
      "Conversations": "会话",
      "Conversation": "会话",
      "View": "查看",
      "Copy code": "复制代码",
      "Show all": "显示全部",
      "Hide": "隐藏",
      "Show": "显示",
      "Details": "详情",
    };

    // 常见按钮/短标签的行内兜底（仅在 textContent 严格等于 key 时替换）
    const EXACT_TEXT_KEYS = Object.keys(DICT).sort((a, b) => b.length - a.length);

    // placeholder / aria-label / title 等属性翻译
    const ATTR_MAP = {
      "New Session": "新会话",
      "New session": "新建会话",
      "Open sidebar": "打开侧边栏",
      "Collapse sidebar": "收起侧边栏",
      "Settings": "设置",
      "Search": "搜索",
      "Close": "关闭",
      "Copy": "复制",
      "Send message": "发送消息",
      "Cancel": "取消",
    };
    //#endregion

    //#region helpers
    const SKIP_TAGS = new Set([
      "SCRIPT", "STYLE", "STYLE[data-plugin]", "CODE", "PRE", "TEXTAREA",
      "INPUT", "SELECT", "OPTION", "SVG", "PATH", "CANVAS", "NOSCRIPT",
    ]);

    function nodeShouldSkip(node) {
      if (!node || node.nodeType !== 1) return true;
      if (node.closest && node.closest('[data-dsh-zh-skipped]')) return true;
      if (node.closest && node.closest('textarea, input, pre, code, .dsh-zh-code')) return true;
      return false;
    }

    function translateText(text) {
      if (!text) return text;
      let out = text;
      // 精确整串命中优先
      const trimmed = text.trim();
      if (DICT[trimmed] !== void 0) return text.slice(0, text.length - trimmed.length) + DICT[trimmed] + text.slice(text.length - trimmed.length + trimmed.length);
      // 否则做最长优先的子串替换（仅处理纯文本节点，避免命中代码/路径）
      for (const key of EXACT_TEXT_KEYS) {
        if (key.length < 3) continue;
        const idx = out.indexOf(key);
        if (idx !== -1) out = out.slice(0, idx) + DICT[key] + out.slice(idx + key.length);
      }
      return out;
    }

    function translateAttributes(el) {
      for (const attr of ["placeholder", "aria-label", "title"]) {
        const val = el.getAttribute && el.getAttribute(attr);
        if (val) {
          const t = ATTR_MAP[val.trim()];
          if (t !== void 0 && el.getAttribute) el.setAttribute(attr, t);
        }
      }
    }

    function walkTranslate() {
      const root = document.body;
      if (!root) return;
      // 遍历所有元素节点，处理属性
      const all = root.querySelectorAll("*");
      for (const el of all) {
        if (SKIP_TAGS.has(el.tagName)) continue;
        if (nodeShouldSkip(el)) continue;
        translateAttributes(el);
      }
      // 文本节点：只处理叶子文本（父元素不含其它元素子节点），避免重复替换
      const textNodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentNode;
          if (!parent || !parent.tagName) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (nodeShouldSkip(parent)) return NodeFilter.FILTER_REJECT;
          // 只翻译叶子文本（父节点下没有其它元素节点）
          for (const child of parent.childNodes) {
            if (child.nodeType === 1) return NodeFilter.FILTER_REJECT;
          }
          const t = node.nodeValue;
          if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
          if (!t.trim().match(/[A-Za-z]{2,}/)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (const node of textNodes) {
        const translated = translateText(node.nodeValue);
        if (translated !== node.nodeValue) node.nodeValue = translated;
      }
    }

    function startObserver() {
      if (typeof MutationObserver === "undefined") return;
      const observer = new MutationObserver(() => {
        clearTimeout(startObserver.timer);
        startObserver.timer = setTimeout(walkTranslate, 80);
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      window.__dshI18nZhObserver = observer;
      // 首次全量翻译（延迟到 React 首帧渲染稳定后）
      setTimeout(walkTranslate, 300);
      setTimeout(walkTranslate, 1500);
    }
    //#endregion

    const inject = ["slots", "locale"];

    function apply(ctx) {
      // 1) 切到中文（dsh 的 zh 词典优先，若 locale 已注册 zh 则整体汉化）
      try {
        const locale = ctx.locale || ctx.get("locale");
        if (locale && typeof locale.setLocale === "function") {
          locale.setLocale("zh");
        }
      } catch (e) {
        // 语言切换失败不阻断：DOM 兜底翻译照常进行
      }

      // 2) DOM 兜底翻译
      ctx.effect(() => {
        startObserver();
        return () => {
          try {
            if (window.__dshI18nZhObserver) {
              window.__dshI18nZhObserver.disconnect();
              delete window.__dshI18nZhObserver;
            }
          } catch {}
        };
      }, "plugin-i18n-zh: dom translation");
    }

    exports.NS = "i18n-zh";
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
