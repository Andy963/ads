export function renderLandingPageScript(idleMinutes: number, tokenRequired: boolean): string {
  return `    const sessionViewHost = document.getElementById('session-views');
    const SESSION_PLACEHOLDER = '__initial__';
    const sessionViewTemplate = sessionViewHost?.querySelector('.session-view')?.cloneNode(true);
    let logEl = document.getElementById('log');
    let inputEl = document.getElementById('input');
    let formEl = document.getElementById('form');
    const wsIndicator = document.getElementById('ws-indicator');
    const workspaceInfoEl = document.getElementById('workspace-info');
    const modifiedFilesEl = document.getElementById('modified-files');
    const planListEl = document.getElementById('plan-list');
    const tokenOverlay = document.getElementById('token-overlay');
    const tokenForm = document.getElementById('token-form');
    const tokenInput = document.getElementById('token-input');
    const tokenSubmit = document.getElementById('token-submit');
    let attachBtn = document.getElementById('attach-btn');
    let imageInput = document.getElementById('image-input');
    let attachmentsEl = document.getElementById('attachments');
    let statusLabel = document.getElementById('status-label');
    let stopBtn = document.getElementById('stop-btn');
    let clearBtn = document.getElementById('clear-cache-btn');
    const TOKEN_KEY = 'ADS_WEB_TOKEN';
    const LOG_TOOLBAR_ID = 'console-header';
    const sessionIdEl = document.getElementById('session-id');
    const sessionRenameBtn = document.getElementById('session-rename');
    const sessionNewBtn = document.getElementById('session-new');
    const sessionHistoryBtn = document.getElementById('session-history');
    const sessionTabsEl = document.getElementById('session-tabs');
    const sessionDialog = document.getElementById('session-dialog');
    const sessionListEl = document.getElementById('session-list');
    const sessionDialogClose = document.getElementById('session-dialog-close');
    const aliasOverlay = document.getElementById('alias-overlay');
    const aliasInput = document.getElementById('alias-input');
    const aliasSave = document.getElementById('alias-save');
    const aliasCancel = document.getElementById('alias-cancel');
    const SESSION_KEY = 'ADS_WEB_SESSION';
    const SESSION_HISTORY_KEY = 'ADS_WEB_SESSIONS';
    const SESSION_OPEN_KEY = 'ADS_OPEN_SESSIONS';
    const SESSION_ALIAS_KEY = 'ADS_SESSION_ALIASES';
    const PLAN_CACHE_PREFIX = 'plan-cache::';
    const WORKSPACE_CACHE_PREFIX = 'ws-cache::';
    const idleMinutes = ${idleMinutes};
    const tokenRequired = ${tokenRequired};
    const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
	    const MAX_LOG_MESSAGES = 300;
	    const MAX_SESSION_HISTORY = 15;
	    const MAX_OPEN_SESSIONS = 10;
	    const COMMAND_OUTPUT_MAX_LINES = 3;
	    const COMMAND_OUTPUT_MAX_CHARS = 1200;
	    const HEARTBEAT_INTERVAL_MS = 15000;
	    const HEARTBEAT_TIMEOUT_MS = 45000;
	    const viewport = window.visualViewport;
    function getScopedStorage() {
      try {
        return window.sessionStorage;
      } catch {
        // 存储不可用时降级为 noop（不再使用 localStorage）
        return {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        };
      }
    }
    const scopedStorage = getScopedStorage();
    const messageCache = new Map();
    // 连接表：每个会话维护独立 WS 及其状态
    const connections = new Map();
    let streamState = null;
    let autoScroll = true;
    let activeCommandView = null;
    let activeCommandSignature = null;
    let activeCommandId = null;
    let lastCommandText = '';
    let idleTimer = null;
    let pendingImages = [];
    const typingPlaceholders = new Map();
    let typingPlaceholder = null;
    let isBusy = false;
    let planTouched = false;
    let wsIndicatorSuspended = false;
    let currentSessionId = '';
    let currentViewId = SESSION_PLACEHOLDER;
    const sessionViews = new Map();
    const sessionStates = new Map();
    let openSessions = [];
    let sessionAliases = {};
    let sessionWorkspaces = {};
    let sessionWorkspaceInfos = {};

    function encodeBase64Url(text) {
      try {
        const bytes = new TextEncoder().encode(String(text ?? ''));
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        return base64.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
      } catch {
        return '';
      }
    }

	    function ensureConnection(sessionId) {
	      if (!connections.has(sessionId)) {
	        connections.set(sessionId, {
	          sessionId,
	          ws: null,
	          generation: 0,
	          heartbeatTimer: null,
	          lastPongAt: 0,
	          reconnectTimer: null,
	          allowReconnect: true,
	          pendingSends: [],
	          wsErrorMessage: null,
	          switchNoticeShown: false,
	          suppressSwitchNotice: false,
	        });
	      }
	      return connections.get(sessionId);
	    }

    const initialView = sessionViewHost?.querySelector('.session-view');
    if (initialView) {
      initialView.dataset.session = SESSION_PLACEHOLDER;
      sessionViews.set(SESSION_PLACEHOLDER, initialView);
    }

    function defaultUiState() {
      return {
        pendingImages: [],
        autoScroll: true,
        streamState: null,
        activeCommandView: null,
        activeCommandSignature: null,
        activeCommandId: null,
        lastCommandText: '',
        isBusy: false,
        planTouched: false,
        inputDraft: '',
        sendQueue: [],
      };
    }

    function bindViewElements(container) {
      if (!container) return;
      logEl = container.querySelector('#log');
      formEl = container.querySelector('#form');
      inputEl = container.querySelector('#input');
      attachBtn = container.querySelector('#attach-btn');
      imageInput = container.querySelector('#image-input');
      attachmentsEl = container.querySelector('#attachments');
      statusLabel = container.querySelector('#status-label');
      stopBtn = container.querySelector('#stop-btn');
      clearBtn = container.querySelector('#clear-cache-btn');
    }

    function saveUiState(id) {
      if (!id) return;
      const conn = connections.get(id);
      sessionStates.set(id, {
        pendingImages: [...pendingImages],
        autoScroll,
        streamState,
        activeCommandView,
        activeCommandSignature,
        activeCommandId,
        lastCommandText,
        isBusy,
        planTouched,
        inputDraft: inputEl?.value || '',
        sendQueue: conn?.pendingSends ? [...conn.pendingSends.map((entry) => entry.type || entry.kind || entry)] : [],
      });
    }

    function restoreUiState(id) {
      const state = sessionStates.get(id) || defaultUiState();
      const conn = ensureConnection(id);
      pendingImages = [...(state.pendingImages || [])];
      autoScroll = state.autoScroll ?? true;
      streamState = state.streamState || null;
      activeCommandView = state.activeCommandView || null;
      activeCommandSignature = state.activeCommandSignature || null;
      activeCommandId = state.activeCommandId || null;
      lastCommandText = state.lastCommandText || '';
      isBusy = state.isBusy || false;
      planTouched = state.planTouched || false;
      conn.pendingSends = Array.isArray(state.sendQueue)
        ? state.sendQueue.map((kind) => ({ type: kind, payload: null }))
        : conn.pendingSends || [];
      if (inputEl) {
        inputEl.value = state.inputDraft || '';
        autoResizeInput();
      }
      renderAttachments();
      setBusy(isBusy);
    }

    function withSessionContext(sessionId, fn) {
      if (!sessionId) return fn();
      const activeId = currentSessionId;
      if (sessionId === activeId) {
        return fn();
      }
      const suppressUi = sessionId !== activeId;
      if (suppressUi) wsIndicatorSuspended = true;
      saveUiState(activeId);
      // 记住当前会话的计划，避免其他会话的计划更新覆盖 UI
      const restoreActivePlan = () => {
        if (activeId) {
          restorePlanFromCache(activeId);
        }
      };
      const view = ensureSessionView(sessionId);
      if (!view) return;
      bindViewElements(view);
      currentSessionId = sessionId;
      currentViewId = sessionId;
      typingPlaceholder = typingPlaceholders.get(sessionId) || null;
      restoreUiState(sessionId);
      const result = fn();
      saveUiState(sessionId);
      const activeView = ensureSessionView(activeId);
      if (activeView) {
        bindViewElements(activeView);
        currentSessionId = activeId;
        currentViewId = activeId;
        typingPlaceholder = typingPlaceholders.get(activeId) || null;
        restoreUiState(activeId);
        restoreActivePlan();
      }
      if (suppressUi) wsIndicatorSuspended = false;
      return result;
    }

    function handleLogScroll() {
      if (!logEl) return;
      autoScroll = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
      const state = sessionStates.get(currentSessionId);
      if (state) {
        state.autoScroll = autoScroll;
      }
    }

    function handleInputKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (formEl?.requestSubmit) {
          formEl.requestSubmit();
        } else if (formEl) {
          formEl.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }
      resetIdleTimer();
    }

    function handleDragOver(e) {
      e.preventDefault();
    }

    function handleDrop(e) {
      e.preventDefault();
      addImagesFromFiles(e.dataTransfer?.files || []);
    }

    function handlePaste(e) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addImagesFromFiles(imageFiles);
      }
    }

    function persistDraft() {
      const state = sessionStates.get(currentSessionId) || defaultUiState();
      state.inputDraft = inputEl?.value || '';
      sessionStates.set(currentSessionId, state);
    }

    function handleStop() {
      const conn = ensureConnection(currentSessionId);
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN || !isBusy) return;
      conn.ws.send(JSON.stringify({ type: 'interrupt' }));
      appendStatus('⛔ 已请求停止，输出可能不完整');
      setBusy(false);
    }

    function handleSubmit(e) {
      e.preventDefault();
      const text = inputEl?.value?.trim() || '';
      const hasImages = pendingImages.length > 0;
      const isCommand = text.startsWith('/');
      const cmdId = isCommand ? Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : null;
      startNewTurn(!isCommand);
      const type = isCommand ? 'command' : 'prompt';
      const payload = isCommand
        ? text
        : {
            text,
            images: hasImages ? pendingImages : undefined,
          };
      if (!text && !hasImages) return;
      const conn = ensureConnection(currentSessionId);
      if (!conn.ws || conn.ws.readyState === WebSocket.CLOSING || conn.ws.readyState === WebSocket.CLOSED) {
        connect(currentSessionId);
      }
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
        appendStatus('当前会话未连接，已尝试重连');
        conn.pendingSends.push({ type, payload });
        return;
      }
      autoScroll = true;
      conn.ws.send(JSON.stringify({ type, payload }));
      conn.pendingSends.push({ type, payload });
      setBusy(true);
      if (isCommand) {
        lastCommandText = text;
        renderCommandView({ id: cmdId, commandText: text, status: 'in_progress' });
      } else {
        lastCommandText = '';
        activeCommandView = null;
        activeCommandSignature = null;
        activeCommandId = null;
        appendMessage('user', text || '(图片)');
        appendTypingPlaceholder();
        streamState = null;
      }
      if (inputEl) {
        inputEl.value = '';
        inputEl.style.height = '44px';
      }
      clearAttachments();
      inputEl?.focus();
      resetIdleTimer();
      recalcLogHeight();
    }

    function handleClearLog() {
      clearLogMessages();
      const conn = connections.get(currentSessionId);
      if (conn?.ws && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(JSON.stringify({ type: 'clear_history' }));
        } catch {
          /* ignore */
        }
      }
    }

    function wireSessionView(container) {
      if (!container || container.dataset.wired) return;
      container.dataset.wired = '1';
      const logNode = container.querySelector('#log');
      const inputNode = container.querySelector('#input');
      const formNode = container.querySelector('#form');
      const attachNode = container.querySelector('#attach-btn');
      const imageNode = container.querySelector('#image-input');
      const stopNode = container.querySelector('#stop-btn');
      const clearNode = container.querySelector('#clear-cache-btn');

      logNode?.addEventListener('scroll', handleLogScroll);
      inputNode?.addEventListener('keydown', handleInputKeydown);
      inputNode?.addEventListener('input', () => {
        autoResizeInput();
        persistDraft();
      });
      inputNode?.addEventListener('focus', recalcLogHeight);
      inputNode?.addEventListener('blur', recalcLogHeight);
      formNode?.addEventListener('dragover', handleDragOver);
      formNode?.addEventListener('drop', handleDrop);
      inputNode?.addEventListener('paste', handlePaste);
      formNode?.addEventListener('submit', handleSubmit);
      attachNode?.addEventListener('click', () => imageNode?.click());
      imageNode?.addEventListener('change', () => addImagesFromFiles(imageNode.files));
      stopNode?.addEventListener('click', handleStop);
      if (stopNode) stopNode.disabled = true;
      clearNode?.addEventListener('click', handleClearLog);
    }

    function ensureSessionView(id) {
      if (!id) return null;
      if (sessionViews.has(id)) {
        return sessionViews.get(id);
      }
      if (sessionViews.has(SESSION_PLACEHOLDER)) {
        const placeholderView = sessionViews.get(SESSION_PLACEHOLDER);
        sessionViews.delete(SESSION_PLACEHOLDER);
        if (placeholderView) {
          placeholderView.dataset.session = id;
          sessionViews.set(id, placeholderView);
          return placeholderView;
        }
      }
      if (!sessionViewTemplate) return null;
      const clone = sessionViewTemplate.cloneNode(true);
      clone.dataset.session = id;
      const cloneLog = clone.querySelector('#log');
      if (cloneLog) {
        Array.from(cloneLog.children).forEach((child) => {
          if (!isLogToolbar(child)) {
            child.remove();
          }
        });
      }
      const cloneInput = clone.querySelector('#input');
      if (cloneInput) {
        cloneInput.value = '';
      }
      const cloneAttachments = clone.querySelector('#attachments');
      if (cloneAttachments) {
        cloneAttachments.innerHTML = '';
      }
      wireSessionView(clone);
      sessionViews.set(id, clone);
      return clone;
    }

    function sessionHasContent(container) {
      const logNode = container?.querySelector('#log');
      if (!logNode) return false;
      const validChildren = Array.from(logNode.children).filter((child) => !isLogToolbar(child));
      return validChildren.length > 0;
    }

    function restoreSessionView(sessionId) {
      const view = ensureSessionView(sessionId);
      if (!view || !sessionViewHost) return false;
      saveUiState(currentSessionId);
      sessionViewHost.innerHTML = '';
      sessionViewHost.appendChild(view);
      currentViewId = sessionId;
      bindViewElements(view);
      restoreUiState(sessionId);
      typingPlaceholder = typingPlaceholders.get(sessionId) || null;
      autoResizeInput();
      recalcLogHeight();
      autoScrollIfNeeded();
      return sessionHasContent(view);
    }

    function stashSessionView() {
      if (!currentSessionId) return;
      saveUiState(currentSessionId);
      const view = sessionViews.get(currentSessionId);
      if (view && sessionViewHost?.contains(view)) {
        sessionViewHost.removeChild(view);
      }
    }

    if (initialView) {
      wireSessionView(initialView);
      bindViewElements(initialView);
      restoreUiState(SESSION_PLACEHOLDER);
    }

    function setBusy(busy) {
      isBusy = !!busy;
      if (stopBtn) {
        const conn = ensureConnection(currentSessionId);
        const canUse = isBusy && conn.ws && conn.ws.readyState === WebSocket.OPEN;
        stopBtn.disabled = !canUse;
      }
    }
    function applyVh() {
      const vh = viewport ? viewport.height : window.innerHeight;
      document.documentElement.style.setProperty('--vh', vh + 'px');
      recalcLogHeight();
    }
    applyVh();
    sessionAliases = loadSessionAliases();
    sessionWorkspaces = loadSessionWorkspaces();
    renderPlanStatus('暂无计划');
    renderSessionList();
    openSessions = loadOpenSessions();
    renderSessionTabs();
    window.addEventListener('resize', applyVh);
    if (viewport) {
      viewport.addEventListener('resize', applyVh);
      viewport.addEventListener('scroll', () => window.scrollTo(0, 0));
    }

    function recalcLogHeight() {
      if (!logEl) return;
      const headerEl = document.querySelector('header');
      const mainEl = document.querySelector('main');
      const headerH = headerEl ? headerEl.getBoundingClientRect().height : 0;
      const formH = formEl ? formEl.getBoundingClientRect().height : 0;
      const mainStyle = mainEl ? window.getComputedStyle(mainEl) : null;
      const paddingY =
        (mainStyle ? Number.parseFloat(mainStyle.paddingTop || '0') : 0) +
        (mainStyle ? Number.parseFloat(mainStyle.paddingBottom || '0') : 0);
      const vh = viewport ? viewport.height : window.innerHeight;
      const gap = 12;
      const available = vh - headerH - formH - gap - paddingY;
      logEl.style.height = Math.max(100, available) + 'px';
      logEl.style.maxHeight = Math.max(100, available) + 'px';
      logEl.scrollTop = logEl.scrollHeight;
    }
    setTimeout(recalcLogHeight, 100);

    function isLogToolbar(node) {
      return node?.id === LOG_TOOLBAR_ID;
    }

    function clearLogMessages() {
      if (!logEl) return;
      Array.from(logEl.children).forEach((child) => {
        if (!isLogToolbar(child)) {
          child.remove();
        }
      });
      // 清空当前会话的内存缓存
      saveCache([], currentSessionId);
      savePlanCache([], currentSessionId);
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/[&<>"']/g, (ch) => {
        switch (ch) {
          case '&': return '&amp;';
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '"': return '&quot;';
          case "'": return '&#39;';
          default: return ch;
        }
      });
    }

    function renderMarkdown(md) {
      if (!md) return '';
      const segments = [];
      const normalized = md.replace(/\\r\\n/g, '\\n');
      const BT = String.fromCharCode(96);
      const fence = new RegExp(BT + BT + BT + "(\\\\w+)?\\\\n?([\\\\s\\\\S]*?)" + BT + BT + BT, "g");
      let last = 0;
      let match;
      while ((match = fence.exec(normalized)) !== null) {
        if (match.index > last) {
          segments.push({ type: 'text', content: normalized.slice(last, match.index) });
        }
        segments.push({ type: 'code', lang: match[1], content: match[2] });
        last = fence.lastIndex;
      }
      if (last < normalized.length) {
        segments.push({ type: 'text', content: normalized.slice(last) });
      }

      const inlineCode = new RegExp(BT + "([^" + BT + "]+)" + BT, "g");

      // 验证 URL 是否安全（防止 javascript: 等协议注入）
      function isSafeUrl(url) {
        if (!url) return false;
        const trimmed = url.trim().toLowerCase();
        if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:') || trimmed.startsWith('vbscript:')) {
          return false;
        }
        return true;
      }

      const renderInline = (text) =>
        text
          .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
          .replace(inlineCode, '<code>$1</code>')
          .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, (match, linkText, url) => {
            if (!isSafeUrl(url)) {
              return escapeHtml(linkText);
            }
            return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(linkText) + '</a>';
          });

      const renderParagraph = (block) => {
        const trimmed = block.trim();
        if (!trimmed) return '';
        const lines = trimmed.split('\\n');
        const isList = lines.every((l) => /^[-*]\\s+/.test(l));
        if (isList) {
          const items = lines
            .map((l) => l.replace(/^[-*]\\s+/, ''))
            .map((txt) => renderInline(escapeHtml(txt)));
          return '<ul>' + items.map((i) => '<li>' + i + '</li>').join('') + '</ul>';
        }
        const heading = trimmed.match(/^(#{1,3})\\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          return '<h' + level + '>' + renderInline(escapeHtml(heading[2])) + '</h' + level + '>';
        }
        return '<p>' + renderInline(escapeHtml(trimmed)) + '</p>';
      };

      const renderTextBlock = (text) => {
        return text
          .split(/\\n\\s*\\n/)
          .map((block) => renderParagraph(block))
          .join('');
      };

      return segments
        .map((seg) => {
          if (seg.type === 'code') {
            const code = escapeHtml(seg.content.replace(/\\n+$/, ''));
            const langClass = seg.lang ? ' class="language-' + escapeHtml(seg.lang) + '"' : '';
            return '<pre class="code-block"><code' + langClass + '>' + code + '</code></pre>';
          }
          return renderTextBlock(seg.content);
        })
        .join('');
    }

    function createCodeBlockElement(content, language) {
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      const code = document.createElement('code');
      if (language) {
        code.classList.add('language-' + language);
      }
      code.textContent = content || '';
      pre.appendChild(code);
      return pre;
    }

    function autoScrollIfNeeded() {
      if (!autoScroll) return;
      logEl.scrollTop = logEl.scrollHeight;
    }

    function pruneLog() {
      if (!logEl) return;
      const entries = Array.from(logEl.children).filter((child) => !isLogToolbar(child));
      while (entries.length > MAX_LOG_MESSAGES) {
        const first = entries.shift();
        if (!first) break;
        if (first.isConnected) {
          first.remove();
        }
      }
      const currentTyping = typingPlaceholders.get(currentSessionId);
      if (currentTyping?.wrapper && !currentTyping.wrapper.isConnected) {
        typingPlaceholders.delete(currentSessionId);
        typingPlaceholder = null;
      }
      if (activeCommandView && !activeCommandView.wrapper?.isConnected) {
        activeCommandView = null;
        activeCommandSignature = null;
        activeCommandId = null;
      }
    }

	    function setLocked(locked) {
	      document.body.classList.toggle('locked', !!locked);
	    }

	    function stopHeartbeat(conn) {
	      if (!conn?.heartbeatTimer) return;
	      try {
	        clearInterval(conn.heartbeatTimer);
	      } catch {
	        /* ignore */
	      }
	      conn.heartbeatTimer = null;
	    }

	    function startHeartbeat(sessionId, conn, socketId) {
	      stopHeartbeat(conn);
	      conn.lastPongAt = Date.now();
	      conn.heartbeatTimer = setInterval(() => {
	        if (socketId !== conn.generation) return;
	        if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
	        const now = Date.now();
	        if (conn.lastPongAt && now - conn.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
	          try {
	            conn.ws.close(4410, 'heartbeat timeout');
	          } catch {
	            /* ignore */
	          }
	          return;
	        }
	        try {
	          conn.ws.send(JSON.stringify({ type: 'ping' }));
	        } catch {
	          try {
	            conn.ws.close(4410, 'heartbeat send failed');
	          } catch {
	            /* ignore */
	          }
	        }
	      }, HEARTBEAT_INTERVAL_MS);
	    }

	    function scheduleReconnect(sessionId) {
	      const conn = ensureConnection(sessionId);
        if (!conn.allowReconnect) return;
        if (!tokenOverlay.classList.contains('hidden')) return;
        if (conn.reconnectTimer) return;
        conn.reconnectTimer = setTimeout(() => {
          conn.reconnectTimer = null;
          connect(sessionId);
        }, 1500);
      }

    logEl.addEventListener('scroll', () => {
      const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
      autoScroll = nearBottom;
    });

    function appendMessage(role, text, options = {}) {
      const wrapper = document.createElement('div');
      wrapper.className = 'msg ' + role + (options.status ? ' status' : '');
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const showCopy = role === 'user' || role === 'ai';
      const content = document.createElement('div');
      if (options.markdown) {
        content.innerHTML = renderMarkdown(text);
      } else if (options.html) {
        content.innerHTML = text;
      } else {
        content.textContent = text;
      }
      bubble.appendChild(content);
      if (showCopy) {
        const footer = document.createElement('div');
        footer.className = 'bubble-footer';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'copy-btn';
        copyBtn.title = '复制';
        copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" /></svg>';
        const checkIcon = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>';
        const copyIcon = copyBtn.innerHTML;
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(text).then(() => {
            copyBtn.innerHTML = checkIcon;
            copyBtn.classList.add('copied');
            setTimeout(() => {
              copyBtn.innerHTML = copyIcon;
              copyBtn.classList.remove('copied');
            }, 1500);
          }).catch(() => {});
        });
        footer.appendChild(copyBtn);
        bubble.appendChild(footer);
      }
      wrapper.appendChild(bubble);
      logEl.appendChild(wrapper);
      pruneLog();
      autoScrollIfNeeded();
      if (!options.skipCache) {
        recordCache(role, text, options.kind || (options.status ? 'status' : undefined));
      }
      return { wrapper, bubble };
    }

    function appendStatus(text) {
      return appendMessage('status', text, { status: true });
    }

    function clearTypingPlaceholder(sessionId = currentSessionId) {
      const currentTyping = typingPlaceholders.get(sessionId) || typingPlaceholder;
      if (currentTyping?.wrapper?.isConnected) {
        currentTyping.wrapper.remove();
      }
      typingPlaceholders.delete(sessionId);
      if (sessionId === currentSessionId) {
        typingPlaceholder = null;
      }
    }

    function appendTypingPlaceholder() {
      clearTypingPlaceholder();
      const wrapper = document.createElement('div');
      wrapper.className = 'msg ai';
      const bubble = document.createElement('div');
      bubble.className = 'bubble typing-bubble';
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'typing-dot';
        bubble.appendChild(dot);
      }
      wrapper.appendChild(bubble);
      logEl.appendChild(wrapper);
      pruneLog();
      autoScrollIfNeeded();
      typingPlaceholder = { wrapper, bubble };
      typingPlaceholders.set(currentSessionId, typingPlaceholder);
      return typingPlaceholder;
    }

    function startNewTurn(clearPlan) {
      // 新回合不再清理命令气泡，保留上一条命令输出
      lastCommandText = '';
      if (clearPlan) {
        planTouched = false;
        // 不清空现有 plan，保留上一轮的计划直到收到新计划
        // 避免每次发消息都闪烁
      }
    }

    function resetCommandView(removeWrapper) {
      if (removeWrapper && activeCommandView?.wrapper?.isConnected) {
        activeCommandView.wrapper.remove();
      }
      activeCommandView = null;
      activeCommandSignature = null;
      activeCommandId = null;
    }

    function buildCommandHeading(status, exitCode) {
      const exitText = exitCode === undefined || exitCode === null ? '' : ' (exit ' + exitCode + ')';
      if (status === 'failed') {
        return '命令失败' + exitText;
      }
      if (status === 'completed') {
        return '命令完成' + exitText;
      }
      return '命令执行中';
    }

    function renderCommandView(options = {}) {
      const cmdId = options.id || null;
      // 同一次对话内的多条命令复用同一个气泡（覆盖显示）
      // 新对话开始时在 form submit 处已重置指针，会创建新气泡
      if (cmdId) {
        activeCommandId = cmdId;
      }
      const commandText = options.commandText || options.detail || '';
      const status = options.status || 'in_progress';
      const exitCode = options.exitCode;
      const heading = options.title || buildCommandHeading(status, exitCode);
      const output = typeof options.output === 'string' ? options.output : '';
      const { snippet, truncated } = summarizeCommandOutput(output);
      const signature = [commandText, status, snippet, heading].join('||');
      if (signature === activeCommandSignature && activeCommandView?.wrapper?.isConnected) {
        return;
      }
      activeCommandSignature = signature;
      clearTypingPlaceholder();
      streamState = null;
      const message = activeCommandView?.wrapper?.isConnected ? activeCommandView : appendMessage('status', '', { status: true });
      activeCommandView = message;
      const bubble = message.bubble;
      bubble.innerHTML = '';

      if (commandText) {
        const cmdLabel = document.createElement('div');
        cmdLabel.textContent = '命令';
        cmdLabel.style.color = 'var(--muted)';
        cmdLabel.style.fontSize = '12px';
        cmdLabel.style.marginTop = '6px';
        bubble.appendChild(cmdLabel);

        const cmdBlock = createCodeBlockElement(commandText, 'bash');
        bubble.appendChild(cmdBlock);
      }

      const outBlock = createCodeBlockElement(snippet || '(无输出)', 'bash');
      outBlock.style.marginTop = '6px';
      bubble.appendChild(outBlock);

      const headingEl = document.createElement('div');
      headingEl.textContent = heading;
      headingEl.style.fontWeight = '600';
      headingEl.style.marginTop = '8px';
      bubble.appendChild(headingEl);
      autoScrollIfNeeded();
      if (status === 'in_progress') {
        setBusy(true);
      } else {
        setBusy(false);
      }
    }

    function setWsState(state, sessionId) {
      if (wsIndicatorSuspended) return;
      if (sessionId && sessionId !== currentSessionId) {
        return;
      }
      if (wsIndicator) {
        wsIndicator.classList.remove('connected', 'connecting');
        if (state === 'connected') {
          wsIndicator.classList.add('connected');
        } else if (state === 'connecting') {
          wsIndicator.classList.add('connecting');
        }
      }
      const label =
        state === 'connected'
          ? 'WebSocket connected'
          : state === 'connecting'
          ? 'WebSocket connecting'
          : 'WebSocket disconnected';
      if (wsIndicator) {
        wsIndicator.setAttribute('title', label);
        wsIndicator.setAttribute('aria-label', label);
      }
      if (statusLabel) {
        statusLabel.textContent =
          state === 'connected' ? '已连接' : state === 'connecting' ? '连接中…' : '已断开';
      }
      const enableInput = state === 'connected';
      if (inputEl) inputEl.disabled = !enableInput;
      if (attachBtn) attachBtn.disabled = !enableInput;
      if (!enableInput) {
        setBusy(false);
      } else {
        setBusy(isBusy);
      }
    }

    function getTokenKey() {
      const token = sessionStorage.getItem(TOKEN_KEY) || '';
      return token || 'default';
    }

    function resolveSessionIdForCache(sessionId) {
      if (sessionId) return sessionId;
      if (currentSessionId) return currentSessionId;
      const stored = loadSession();
      return stored || 'default';
    }

    function cacheKey(sessionId) {
      return 'chat-cache::' + getTokenKey() + '::' + resolveSessionIdForCache(sessionId);
    }

    function loadCache(sessionId) {
      const key = cacheKey(sessionId);
      const memo = messageCache.get(key);
      if (Array.isArray(memo)) return [...memo];
      try {
        const raw = scopedStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function saveCache(items, sessionId) {
      const key = cacheKey(sessionId);
      const trimmed = items.slice(-MAX_LOG_MESSAGES);
      messageCache.set(key, trimmed);
      try {
        scopedStorage.setItem(key, JSON.stringify(trimmed));
      } catch {
        /* ignore */
      }
    }

    function recordCache(role, text, kind) {
      const items = loadCache();
      items.push({ r: role, t: text, k: kind });
      if (items.length > MAX_LOG_MESSAGES) {
        items.shift();
      }
      saveCache(items);
    }

    function planCacheKey(sessionId) {
      return PLAN_CACHE_PREFIX + getTokenKey() + '::' + resolveSessionIdForCache(sessionId);
    }

    function loadPlanCache(sessionId) {
      try {
        const raw = scopedStorage.getItem(planCacheKey(sessionId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function savePlanCache(items, sessionId) {
      try {
        const key = planCacheKey(sessionId);
        if (!items || items.length === 0) {
          scopedStorage.removeItem(key);
          return;
        }
        scopedStorage.setItem(key, JSON.stringify(items));
      } catch {
        /* ignore */
      }
    }

    function restorePlanFromCache(sessionId) {
      const planItems = loadPlanCache(sessionId);
      if (planItems && planItems.length > 0) {
        renderPlan(planItems);
        return;
      }
      planTouched = false;
      renderPlanStatus('暂无计划');
    }

    function aliasStorageKey(tokenKey = getTokenKey()) {
      return SESSION_ALIAS_KEY + '::' + tokenKey;
    }

    function workspaceStorageKey(tokenKey = getTokenKey()) {
      return WORKSPACE_CACHE_PREFIX + tokenKey;
    }

    function loadSessionAliases() {
      const merged = {};
      const loadOne = (key) => {
        try {
          const raw = scopedStorage.getItem(key);
          if (!raw) return;
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed)) {
              if (typeof v === 'string' && k) {
                merged[k] = v;
              }
            }
          }
        } catch {
          /* ignore */
        }
      };
      loadOne(aliasStorageKey()); // token scoped
      loadOne(aliasStorageKey('global')); // fallback to last-saved aliases without token约束
      return merged;
    }

    function loadSessionWorkspaces() {
      const merged = {};
      const loadOne = (key) => {
        try {
          const raw = scopedStorage.getItem(key);
          if (!raw) return;
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed)) {
              if (typeof v === 'string' && k) {
                merged[k] = v;
              }
            }
          }
        } catch {
          /* ignore */
        }
      };
      loadOne(workspaceStorageKey());
      loadOne(workspaceStorageKey('global'));
      return merged;
    }

    function saveSessionAliases(map = sessionAliases) {
      try {
        const payload = JSON.stringify(map);
        scopedStorage.setItem(aliasStorageKey(), payload);
        scopedStorage.setItem(aliasStorageKey('global'), payload);
      } catch {
        /* ignore */
      }
    }

    function saveSessionWorkspaces(map = sessionWorkspaces) {
      try {
        const payload = JSON.stringify(map);
        scopedStorage.setItem(workspaceStorageKey(), payload);
        scopedStorage.setItem(workspaceStorageKey('global'), payload);
      } catch {
        /* ignore */
      }
    }

    function getSessionAlias(id) {
      if (!id) return '';
      return sessionAliases[id] || '';
    }

    function setSessionAlias(id, name) {
      if (!id) return;
      const trimmed = (name || '').trim();
      if (trimmed) {
        sessionAliases[id] = trimmed;
      } else {
        delete sessionAliases[id];
      }
      saveSessionAliases();
      renderSessionTabs();
      renderSessionList();
      updateSessionLabel(currentSessionId);
    }

    function getWorkspaceForSession(id) {
      if (id && sessionWorkspaces[id]) {
        return sessionWorkspaces[id];
      }
      return sessionWorkspaces.__last || '';
    }

    function setWorkspaceForSession(id, path) {
      if (!path) return;
      if (id) {
        sessionWorkspaces[id] = path;
      }
      sessionWorkspaces.__last = path; // 记录 token 下的最近工作目录，防止 sessionId 变化导致丢失
      saveSessionWorkspaces();
    }

    function maybeRestoreWorkspace(sessionId, serverPath, conn) {
      const cached = getWorkspaceForSession(sessionId);
      if (!cached || cached === serverPath) return;
      const payload = { type: 'command', payload: '/cd ' + cached };
      const targetConn = conn || ensureConnection(sessionId);
      targetConn.pendingSends = targetConn.pendingSends || [];
      // 如果已连接，立即发送；否则排队
      if (targetConn.ws && targetConn.ws.readyState === WebSocket.OPEN) {
        try {
          targetConn.ws.send(JSON.stringify(payload));
        } catch {
          targetConn.pendingSends.push(payload);
        }
      } else {
        targetConn.pendingSends.push(payload);
      }
    }

    function resolveSessionLabel(id) {
      if (!id) return '--';
      const alias = getSessionAlias(id);
      return alias || id;
    }

    function resolveSessionTitle(id) {
      if (!id) return '--';
      const alias = getSessionAlias(id);
      if (alias && alias !== id) {
        return alias + ' (' + id + ')';
      }
      return id;
    }

    function loadSessionHistory() {
      try {
        const raw = scopedStorage.getItem(SESSION_HISTORY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function saveSessionHistory(list) {
      try {
        scopedStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(list.slice(0, MAX_SESSION_HISTORY)));
      } catch {
        /* ignore */
      }
    }

    function loadOpenSessions() {
      try {
        const raw = scopedStorage.getItem(SESSION_OPEN_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id.trim()) : [];
      } catch {
        return [];
      }
    }

    function saveOpenSessions(list) {
      try {
        scopedStorage.setItem(SESSION_OPEN_KEY, JSON.stringify(list.slice(0, MAX_OPEN_SESSIONS)));
      } catch {
        /* ignore */
      }
    }

    function rememberSession(id) {
      if (!id) return;
      const list = loadSessionHistory().filter((entry) => entry?.id !== id);
      list.unshift({ id, ts: Date.now() });
      saveSessionHistory(list);
      renderSessionList();
    }

    function ensureOpenSession(id) {
      if (!id) return;
      const exists = openSessions.includes(id);
      if (!exists) {
        openSessions.push(id); // 新会话追加到末尾，保持 tab 顺序稳定
        if (openSessions.length > MAX_OPEN_SESSIONS) {
          // 如果超过上限，移除最旧的会话（队列前端）
          openSessions = openSessions.slice(-MAX_OPEN_SESSIONS);
        }
      }
      saveOpenSessions(openSessions);
      renderSessionTabs();
    }

    function removeOpenSession(id) {
      openSessions = openSessions.filter((entry) => entry && entry !== id);
      if (openSessions.length === 0 && currentSessionId) {
        openSessions = [currentSessionId];
      }
      saveOpenSessions(openSessions);
      renderSessionTabs();
    }

    function renderSessionList() {
      if (!sessionListEl) return;
      const list = loadSessionHistory();
      sessionListEl.innerHTML = '';
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'muted';
        empty.textContent = '暂无会话记录';
        sessionListEl.appendChild(empty);
        return;
      }
      list.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'session-item';
        const idEl = document.createElement('span');
        idEl.className = 'id';
        const alias = getSessionAlias(item.id);
        idEl.textContent = alias || item.id;
        idEl.title = resolveSessionTitle(item.id);
        const meta = document.createElement('span');
        meta.className = 'meta';
        const ts = item.ts ? new Date(item.ts) : null;
        const tsText = ts ? ts.toLocaleString() : '';
        meta.textContent = alias ? [item.id, tsText].filter(Boolean).join(' · ') : tsText;
        row.appendChild(idEl);
        row.appendChild(meta);
        row.addEventListener('click', () => {
          if (sessionDialog) {
            sessionDialog.classList.add('hidden');
          }
          switchSession(item.id);
        });
        sessionListEl.appendChild(row);
      });
    }

    function renderSessionTabs() {
      if (!sessionTabsEl) return;
      sessionTabsEl.innerHTML = '';
      if (!openSessions.length) {
        const empty = document.createElement('div');
        empty.className = 'muted';
        empty.textContent = '暂无会话';
        sessionTabsEl.appendChild(empty);
        return;
      }
      openSessions.forEach((id) => {
        const tab = document.createElement('div');
        tab.className = 'session-tab' + (id === currentSessionId ? ' active' : '');
        tab.title = resolveSessionTitle(id);
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = resolveSessionLabel(id);
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeSessionTab(id);
        });
        tab.appendChild(label);
        tab.appendChild(closeBtn);
        tab.addEventListener('click', () => {
          if (id === currentSessionId) return;
          switchSession(id);
        });
        sessionTabsEl.appendChild(tab);
      });
    }

	    function renderHistory(items) {
	      if (!Array.isArray(items) || items.length === 0) {
	        return;
	      }

	      const normalizeKey = (role, text, kind) => {
	        const normalizedRole = role || 'status';
	        const normalizedKind = normalizedRole === 'status' ? 'status' : (kind || '');
	        return normalizedRole + '|' + normalizedKind + '|' + (text || '');
	      };

	      const cached = loadCache();
	      const hasCache = Array.isArray(cached) && cached.length > 0;
	      if (!hasCache) {
	        clearLogMessages();
	      }

	      const cachedKeys = new Set(
	        (cached || []).map((entry) => normalizeKey(entry?.r, entry?.t, entry?.k)),
	      );

	      items.forEach((item) => {
	        const role = item.role || item.r || 'status';
	        const text = item.text || item.t || '';
	        const kind = item.kind || item.k;
	        if (kind === 'plan') {
	          return;
	        }
	        const key = normalizeKey(role, text, kind);
	        if (cachedKeys.has(key)) {
	          return;
	        }
	        const isStatus = role === 'status' || kind === 'status' || kind === 'error';
	        appendMessage(role === 'status' ? 'status' : role, text, { markdown: false, status: isStatus, kind });
	        cachedKeys.add(key);
	      });
	      autoScrollIfNeeded();
	    }

    function restoreFromCache(sessionId) {
      const cached = loadCache(sessionId);
      if (!cached || cached.length === 0) return;
      clearLogMessages();
      cached.forEach((item) => {
        const role = item.r || 'status';
        const text = item.t || '';
        const kind = item.k;
        const isStatus = role === 'status' || kind === 'status';
        appendMessage(role, text, { markdown: false, status: isStatus, skipCache: true });
      });
      pruneLog();
      autoScrollIfNeeded();
    }

    function resetIdleTimer() {
      if (idleMinutes <= 0) {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        const reason = '空闲超过 ' + idleMinutes + ' 分钟，已锁定';
        sessionStorage.removeItem(TOKEN_KEY);
        connections.forEach((conn) => {
          if (conn?.ws && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.close(4400, "idle timeout");
          }
        });
        tokenOverlay.classList.remove('hidden');
        tokenInput.value = '';
        setLocked(true);
        appendMessage('ai', reason, { status: true });
        setWsState('disconnected');
      }, idleMinutes * 60 * 1000);
    }

    function updateSessionLabel(id) {
      currentSessionId = id || '';
      if (sessionIdEl) {
        sessionIdEl.textContent = resolveSessionLabel(currentSessionId);
        sessionIdEl.title = resolveSessionTitle(currentSessionId);
      }
      const cachedInfo = currentSessionId ? sessionWorkspaceInfos[currentSessionId] : null;
      if (cachedInfo) {
        renderWorkspaceInfo(cachedInfo);
      } else {
        const cachedPath = currentSessionId ? getWorkspaceForSession(currentSessionId) : '';
        renderWorkspaceInfo(cachedPath ? { path: cachedPath } : null);
      }
      rememberSession(currentSessionId);
      ensureOpenSession(currentSessionId);
    }

    function saveSession(id) {
      try {
        sessionStorage.setItem(SESSION_KEY, id);
      } catch {
        /* ignore */
      }
    }

    function loadSession() {
      try {
        return sessionStorage.getItem(SESSION_KEY) || '';
      } catch {
        return '';
      }
    }

    function clearSession() {
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {
        /* ignore */
      }
    }

    function newSessionId() {
      return Math.random().toString(36).slice(2, 8);
    }

    function switchSession(targetId, skipStash) {
      if (!targetId || targetId === currentSessionId) return;
      if (!skipStash) {
        stashSessionView();
      }
      saveSession(targetId);
      updateSessionLabel(targetId);
      restorePlanFromCache(targetId);
      const restored = restoreSessionView(targetId);
      if (!restored) {
        restoreFromCache(targetId);
        if (inputEl) {
          inputEl.value = '';
          autoResizeInput();
        }
      }
      setBusy(isBusy);
      connect(targetId);
    }

    function closeSessionTab(id) {
      const wasActive = id === currentSessionId;
      sessionViews.delete(id);
      sessionStates.delete(id);
      removeOpenSession(id);
      if (wasActive) {
        const fallback = openSessions[0] || newSessionId();
        switchSession(fallback, true);
      } else {
        renderSessionTabs();
      }
    }

    function handleWsMessageForSession(sessionId, conn, ev) {
      const activeSessionId = currentSessionId;
      const isActiveSession = !activeSessionId || sessionId === activeSessionId;
      withSessionContext(sessionId, () => {
	        try {
	          const msg = JSON.parse(ev.data);
	          if (msg.type === 'pong') {
	            conn.lastPongAt = Date.now();
	            if (isBusy) {
	              resetIdleTimer();
	            }
	            return;
	          }
	          if (msg.type === 'result') {
	            handleResult(msg, conn);
	          } else if (msg.type === 'delta') {
	            handleDelta(msg.delta || '');
	          } else if (msg.type === 'explored') {
            handleExploredEntry(msg);
            resetIdleTimer();
          } else if (msg.type === 'command') {
            // Agent 执行的命令通过 Explored 显示，不再单独渲染 commandView
            // 避免重复显示和 ANSI 乱码
            return;
          } else if (msg.type === 'history') {
            renderHistory(msg.items || []);
            resetIdleTimer();
            return;
          } else if (msg.type === 'plan') {
            renderPlan(msg.items || []);
            resetIdleTimer();
            return;
          } else if (msg.type === 'welcome') {
            setWsState('connected', sessionId);
            resetIdleTimer();
            if (isActiveSession && msg.sessionId) {
              updateSessionLabel(msg.sessionId);
              saveSession(msg.sessionId);
            }
            if (msg.workspace) {
              sessionWorkspaceInfos[sessionId] = msg.workspace;
              if (msg.workspace.path) {
                setWorkspaceForSession(sessionId, msg.workspace.path);
                maybeRestoreWorkspace(sessionId, msg.workspace.path, conn);
              }
              if (isActiveSession) {
                renderWorkspaceInfo(msg.workspace);
              }
            }
          } else if (msg.type === 'workspace') {
            if (msg.data?.path) {
              setWorkspaceForSession(sessionId, msg.data.path);
            }
            if (msg.data) {
              sessionWorkspaceInfos[sessionId] = msg.data;
            }
            if (isActiveSession) {
              renderWorkspaceInfo(msg.data);
            }
            resetIdleTimer();
          } else if (msg.type === 'error') {
            clearTypingPlaceholder();
            streamState = null;
            const queued = conn.pendingSends.shift() || { type: 'prompt' };
            const failedKind = queued.type || queued;
            if (failedKind === 'command') {
              renderCommandView({
                commandText: lastCommandText || '',
                status: 'failed',
                output: msg.message || '',
                title: '命令失败',
              });
              appendMessage('ai', msg.message || '错误', { status: true });
            } else {
              appendMessage('ai', msg.message || '错误', { status: true });
            }
            setBusy(false);
            return;
          } else {
            appendMessage('ai', ev.data, { status: true });
          }
        } catch {
          appendMessage('ai', ev.data, { status: true });
        }
      });
    }

    function connect(sessionIdOverride) {
      const activeId = currentSessionId;
      const sessionIdToUse = sessionIdOverride || activeId || loadSession() || newSessionId();
      const conn = ensureConnection(sessionIdToUse);
      const shouldPersistSession = !activeId || sessionIdToUse === activeId;
      if (shouldPersistSession) {
        saveSession(sessionIdToUse);
      }
      if (!activeId) {
        updateSessionLabel(sessionIdToUse);
      }
      if (sessionIdToUse === activeId || !activeId) {
        restoreSessionView(sessionIdToUse);
        restorePlanFromCache(sessionIdToUse);
      } else {
        ensureSessionView(sessionIdToUse);
      }
      const token = sessionStorage.getItem(TOKEN_KEY) || '';
      console.debug('[ADS-WS] connect start:', { sessionIdToUse, tokenRequired, hasToken: !!token, tokenLen: token.length });
      if (tokenRequired && !token) {
        console.warn('[ADS-WS] token required but not found in sessionStorage');
        tokenOverlay.classList.remove('hidden');
        setTimeout(() => tokenInput?.focus?.(), 0);
        setLocked(true);
        return null;
      }
	      tokenOverlay.classList.add('hidden');
	      setLocked(false);
	      if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) {
	        console.debug('[ADS-WS] WS already exists, reusing:', { state: conn.ws.readyState });
	        if (conn.ws.readyState === WebSocket.OPEN && !conn.heartbeatTimer) {
	          startHeartbeat(sessionIdToUse, conn, conn.generation);
	        }
	        return conn.ws;
	      }
	      stopHeartbeat(conn);
	      const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname;
	      conn.generation += 1;
	      const socketId = conn.generation;
	      conn.pendingSends = conn.pendingSends || [];
      withSessionContext(sessionIdToUse, () => {
        streamState = null;
        clearTypingPlaceholder();
        resetCommandView(false);
        setWsState('connecting', sessionIdToUse);
      });
      const tokenProto = token ? 'ads-token.' + encodeBase64Url(token) : '';
      const protocols = ['ads-v1', tokenProto, 'ads-session.' + sessionIdToUse].filter(Boolean);
        console.debug('[ADS-WS] creating WebSocket:', {
          url,
          protocolCount: protocols.length,
          protocols: protocols.map((p) => (p.startsWith('ads-token') ? 'ads-token.*' : p)),
        });
	      conn.ws = new WebSocket(url, protocols);
	      conn.ws.onopen = () => {
	        console.debug('[ADS-WS] onopen event fired', { socketId, generation: conn.generation, sessionId: sessionIdToUse });
	        if (socketId !== conn.generation) {
	          console.warn('[ADS-WS] onopen: generation mismatch, ignoring', { socketId, generation: conn.generation });
	          return;
	        }
	        if (conn.reconnectTimer) {
	          clearTimeout(conn.reconnectTimer);
          conn.reconnectTimer = null;
        }
        if (conn.wsErrorMessage?.wrapper?.isConnected) {
          conn.wsErrorMessage.wrapper.remove();
          conn.wsErrorMessage = null;
        }
	        conn.switchNoticeShown = false;
	        setWsState('connected', sessionIdToUse);
	        startHeartbeat(sessionIdToUse, conn, socketId);
	        resetIdleTimer();
	        setLocked(false);
	        console.log('[ADS-WS] connected successfully, flushing pending sends:', { count: conn.pendingSends.length });
	        // flush pending sends (skip entries with null/undefined payload to avoid server errors)
	        const pending = [...conn.pendingSends];
        conn.pendingSends = [];
        pending.forEach(({ type, payload }) => {
          if (payload == null) return; // skip invalid payloads from state restoration
          try {
            conn.ws?.send(JSON.stringify({ type, payload }));
          } catch {
            /* ignore */
          }
        });
      };
      conn.ws.onmessage = (ev) => {
        if (socketId !== conn.generation) return;
        handleWsMessageForSession(sessionIdToUse, conn, ev);
      };
        conn.ws.onclose = (ev) => {
          console.warn('[ADS-WS] onclose event:', {
            socketId,
            generation: conn.generation,
            code: ev.code,
            reason: ev.reason,
            wasClean: ev.wasClean,
          });
	        if (socketId !== conn.generation) {
	          console.warn('[ADS-WS] onclose: generation mismatch, ignoring');
	          return;
	        }
	        stopHeartbeat(conn);
	        withSessionContext(sessionIdToUse, () => {
	          const wasBusy = isBusy;
	          setWsState('disconnected', sessionIdToUse);
	          setBusy(false);
          clearTypingPlaceholder(sessionIdToUse);
          streamState = null;
          if (ev.code !== 4401 && ev.code !== 4409) {
            const code = ev.code || 1006;
            const reason = ev.reason ? ', ' + ev.reason : '';
            const note = wasBusy ? '（执行中断）' : '';
            const text = '连接已断开' + note + '（code=' + code + reason + '），正在尝试重连…';
            if (!conn.wsErrorMessage || !conn.wsErrorMessage.wrapper?.isConnected) {
              conn.wsErrorMessage = appendMessage('ai', text, { status: true, skipCache: !wasBusy });
            }
          }
        });
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        if (ev.code === 4401) {
          console.error('[ADS-WS] auth failed (4401), clearing token');
          sessionStorage.removeItem(TOKEN_KEY);
          tokenOverlay.classList.remove('hidden');
          tokenInput.value = '';
          setLocked(true);
          withSessionContext(sessionIdToUse, () => {
            appendMessage('ai', '口令无效或已过期，请重新输入', { status: true });
          });
          clearSession();
          conn.allowReconnect = false;
        } else if (ev.code === 4409) {
          console.warn('[ADS-WS] max clients reached (4409)');
          if (!conn.suppressSwitchNotice && !conn.switchNoticeShown) {
            withSessionContext(sessionIdToUse, () => {
              appendMessage('ai', '已有新连接，当前会话被替换或已达上限', { status: true, skipCache: true });
            });
            conn.switchNoticeShown = true;
          }
          conn.suppressSwitchNotice = false;
          conn.allowReconnect = false;
        } else {
          conn.allowReconnect = true;
        }
        if (sessionIdToUse === currentSessionId) {
          renderWorkspaceInfo(null);
        }
        scheduleReconnect(sessionIdToUse);
      };
	      conn.ws.onerror = (err) => {
	        console.error('[ADS-WS] onerror event:', { socketId, generation: conn.generation, err });
	        if (socketId !== conn.generation) {
	          console.warn('[ADS-WS] onerror: generation mismatch, ignoring');
	          return;
	        }
	        stopHeartbeat(conn);
	        withSessionContext(sessionIdToUse, () => {
	          setWsState('disconnected', sessionIdToUse);
	          setBusy(false);
	          clearTypingPlaceholder(sessionIdToUse);
          streamState = null;
          const message =
            err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : 'WebSocket error';
          if (!conn.wsErrorMessage || !conn.wsErrorMessage.wrapper?.isConnected) {
            conn.wsErrorMessage = appendMessage('ai', 'WS error: ' + message, { status: true, skipCache: true });
          }
        });
        scheduleReconnect(sessionIdToUse);
      };
      return conn.ws;
    }

    // 自动调整输入框高度，最多6行
    function autoResizeInput() {
      if (!inputEl) return;
      inputEl.style.height = 'auto';
      const lineHeight = 24; // 约等于 font-size * line-height
      const minHeight = 44;
      const maxHeight = lineHeight * 6 + 24; // 6行 + padding
      const scrollHeight = inputEl.scrollHeight;
      const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
      inputEl.style.height = newHeight + 'px';
      recalcLogHeight();
    }

    function ensureStream() {
      if (!streamState) {
        clearTypingPlaceholder();
        streamState = {
          buffer: '',
          message: appendMessage('ai', '', { markdown: false, skipCache: true }),
        };
      }
      return streamState;
    }

    function handleDelta(delta) {
      const stream = ensureStream();
      stream.buffer += delta;
      stream.message.bubble.textContent = stream.buffer;
      autoScrollIfNeeded();
      resetIdleTimer();
    }

    function summarizeCommandOutput(rawOutput) {
      const text = (typeof rawOutput === 'string' ? rawOutput : '').trim();
      if (!text) {
        return { snippet: '(无输出)', truncated: false, full: '' };
      }
      const lines = text.split(/\\r?\\n/);
      const kept = lines.slice(0, COMMAND_OUTPUT_MAX_LINES);
      let truncated = lines.length > COMMAND_OUTPUT_MAX_LINES;
      let snippet = kept.join('\\n');
      if (snippet.length > COMMAND_OUTPUT_MAX_CHARS) {
        snippet = snippet.slice(0, COMMAND_OUTPUT_MAX_CHARS);
        truncated = true;
      }
      if (truncated) {
        snippet = snippet.trimEnd() + '\\n…';
      }
      return { snippet, truncated, full: text };
    }

    function appendCommandResult(ok, output, commandText, exitCode) {
      const normalizedCommand = typeof commandText === 'string' ? commandText : '';
      renderCommandView({
        id: activeCommandId,
        commandText: normalizedCommand || lastCommandText,
        status: ok ? 'completed' : 'failed',
        output,
        exitCode,
        title: ok ? '命令完成' : '命令失败',
      });
    }

    function finalizeStream(output) {
      clearTypingPlaceholder();
      if (streamState) {
        const finalText = output || streamState.buffer;
        streamState.message.bubble.innerHTML = renderMarkdown(finalText);
        recordCache('ai', finalText);
        streamState = null;
        autoScrollIfNeeded();
        return;
      }
      appendMessage('ai', output || '(无输出)', { markdown: true });
    }

    let exploredContainer = null;
    let exploredEntries = [];

    function handleExploredEntry(msg) {
      const entry = msg.entry;
      if (!entry || (!entry.category && !entry.summary)) return;
      
      exploredEntries.push(entry);
      
      if (msg.header || !exploredContainer) {
        // 有实际活动了，清除 typing placeholder
        clearTypingPlaceholder();
        // Create new explored container
        exploredContainer = document.createElement('div');
        exploredContainer.className = 'explored-container';
        const header = document.createElement('div');
        header.className = 'explored-header';
        header.textContent = 'Explored';
        exploredContainer.appendChild(header);
        logEl.appendChild(exploredContainer);
      }
      
      const line = document.createElement('div');
      line.className = 'explored-entry';
      const prefix = document.createElement('span');
      prefix.className = 'explored-prefix';
      prefix.textContent = '  ├ ';
      const category = document.createElement('span');
      category.className = 'explored-category';
      category.textContent = entry.category || '';
      const summary = document.createElement('span');
      summary.className = 'explored-summary';
      summary.textContent = ' ' + (entry.summary || '');
      line.appendChild(prefix);
      line.appendChild(category);
      line.appendChild(summary);
      exploredContainer.appendChild(line);
      autoScrollIfNeeded();
    }

    function clearExploredState() {
      exploredContainer = null;
      exploredEntries = [];
    }

    function renderExplored(entries) {
      if (!Array.isArray(entries) || entries.length === 0) return '';
      const filtered = entries.filter(entry => entry && (entry.category || entry.summary));
      if (filtered.length === 0) return '';
      const lines = ['Explored'];
      filtered.forEach((entry, idx) => {
        const category = entry.category || '';
        const summary = entry.summary || '';
        const prefix = idx === filtered.length - 1 ? '  └ ' : '  ├ ';
        lines.push(prefix + category + (summary ? ' ' + summary : ''));
      });
      const text = lines.join('\\n');
      return '<pre class="code-block"><code>' + escapeHtml(text) + '</code></pre>';
    }

    function handleResult(msg, conn) {
      const queued = conn?.pendingSends?.shift() || { type: 'prompt' };
      const kind = queued.type || queued;
      clearTypingPlaceholder();
      if (kind === 'command') {
        appendCommandResult(Boolean(msg.ok), msg.output || '', msg.command, msg.exit_code);
        resetIdleTimer();
        setBusy(false);
        return;
      }
      finalizeStream(msg.output || '');
      clearExploredState();
      // 保留现有 plan，只有当没有缓存且本轮没有新 plan 时才显示提示
      if (!planTouched) {
        const cachedPlan = loadPlanCache(currentSessionId);
        if (!cachedPlan || cachedPlan.length === 0) {
          renderPlanStatus('本轮未生成计划');
        }
      }
      resetIdleTimer();
      setBusy(false);
    }

    function renderWorkspaceInfo(info) {
      if (!workspaceInfoEl) return;
      workspaceInfoEl.innerHTML = '';
      if (modifiedFilesEl) modifiedFilesEl.innerHTML = '';
      if (!info) return;
      if (info.path) {
        setWorkspaceForSession(currentSessionId, info.path);
      }
      if (info.path) {
        const span = document.createElement('span');
        span.className = 'path';
        span.textContent = info.path;
        workspaceInfoEl.appendChild(span);
      }
      if (modifiedFilesEl && Array.isArray(info.modified)) {
        if (info.modified.length === 0) {
          const span = document.createElement('span');
          span.textContent = '（无变更）';
          span.style.color = 'var(--muted)';
          modifiedFilesEl.appendChild(span);
        } else {
          info.modified.slice(0, 50).forEach((file) => {
            const span = document.createElement('span');
            span.textContent = file;
            modifiedFilesEl.appendChild(span);
          });
          if (info.modified.length > 50) {
            const span = document.createElement('span');
            span.textContent = '... 共 ' + info.modified.length + ' 个';
            span.style.color = 'var(--muted)';
            modifiedFilesEl.appendChild(span);
          }
        }
      }
    }

    function renderPlanStatus(text) {
      if (!planListEl) return;
      planListEl.innerHTML = '';
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = text;
      planListEl.appendChild(span);
    }

    function renderPlan(items) {
      if (!planListEl) return;
      planTouched = true;
      savePlanCache(items || [], currentSessionId);
      planListEl.innerHTML = '';
      if (!items || items.length === 0) {
        renderPlanStatus('暂无计划');
        return;
      }
      items.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'plan-item' + (item.completed ? ' done' : '');
        const marker = document.createElement('span');
        marker.className = 'plan-marker';
        marker.textContent = item.completed ? '✓' : String(idx + 1);
        const text = document.createElement('span');
        text.className = 'plan-text';
        text.textContent = item.text || '(未命名)';
        row.appendChild(marker);
        row.appendChild(text);
        planListEl.appendChild(row);
      });
    }

    function renderAttachments() {
      if (!attachmentsEl) return;
      attachmentsEl.innerHTML = '';
      pendingImages.forEach((img, idx) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        const label = document.createElement('span');
        const sizeKb = Math.round((img.size || 0) / 1024);
        label.textContent = (img.name || '图片') + (sizeKb ? ' (' + sizeKb + 'KB)' : '');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
          pendingImages.splice(idx, 1);
          renderAttachments();
        });
        chip.appendChild(label);
        chip.appendChild(remove);
        attachmentsEl.appendChild(chip);
      });
    }

    function addImagesFromFiles(files) {
      if (!files?.length) return;
      Array.from(files).forEach((file) => {
        if (!file.type.startsWith('image/')) {
          appendStatus('仅支持图片文件: ' + file.name);
          return;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          appendStatus(file.name + ' 超过 2MB 限制');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result !== 'string') return;
          const base64 = result.includes(',') ? result.split(',').pop() || '' : result;
          pendingImages.push({ name: file.name, mime: file.type, size: file.size, data: base64 });
          renderAttachments();
        };
        reader.readAsDataURL(file);
      });
    }

    function clearAttachments() {
      pendingImages = [];
      if (imageInput) {
        imageInput.value = '';
      }
      renderAttachments();
    }

    function submitToken() {
      const token = tokenInput.value.trim();
      if (!token) return;
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionAliases = loadSessionAliases();
      renderSessionTabs();
      renderSessionList();
      updateSessionLabel(currentSessionId);
      tokenOverlay.classList.add('hidden');
      restoreFromCache();
      restorePlanFromCache();
      connect();
    }

    tokenForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      submitToken();
    });

    tokenSubmit?.addEventListener('click', (e) => {
      e.preventDefault?.();
      submitToken();
    });

    connect();

    if (sessionNewBtn) {
      sessionNewBtn.addEventListener('click', () => {
        const nextId = newSessionId();
        switchSession(nextId);
      });
    }

    if (sessionRenameBtn) {
      sessionRenameBtn.addEventListener('click', () => {
        if (!currentSessionId) return;
        const existing = getSessionAlias(currentSessionId);
        if (aliasInput) {
          aliasInput.value = existing || '';
          setTimeout(() => aliasInput?.focus(), 0);
        }
        if (aliasOverlay) {
          aliasOverlay.classList.remove('hidden');
        }
      });
    }

    if (sessionHistoryBtn) {
      sessionHistoryBtn.addEventListener('click', () => {
        renderSessionList();
        if (sessionDialog) {
          sessionDialog.classList.remove('hidden');
        }
      });
    }

    if (sessionDialogClose) {
      sessionDialogClose.addEventListener('click', () => {
        sessionDialog?.classList.add('hidden');
      });
    }

    function closeAliasOverlay() {
      aliasOverlay?.classList.add('hidden');
    }

    function submitAlias() {
      if (!currentSessionId) {
        closeAliasOverlay();
        return;
      }
      const name = aliasInput?.value || '';
      setSessionAlias(currentSessionId, name);
      closeAliasOverlay();
    }

    aliasSave?.addEventListener('click', submitAlias);
    aliasCancel?.addEventListener('click', closeAliasOverlay);
    aliasInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAlias();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeAliasOverlay();
      }
    });
`;
}
