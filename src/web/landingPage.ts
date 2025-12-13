export interface LandingPageOptions {
  idleMinutes: number;
}

export function renderLandingPage(options: LandingPageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>ADS Web Console</title>
  <style>
    :root {
      --vh: 100vh;
      --header-h: 64px;
      --bg: #f5f7fb;
      --panel: #ffffff;
      --border: #d6d9e0;
      --text: #0f172a;
      --muted: #4b5563;
      --accent: #2563eb;
      --user: #f7f7f9;
      --ai: #eef1f5;
      --status: #f3f4f6;
      --code: #0f172a;
    }
    * { box-sizing: border-box; }
    html { height: 100%; width: 100%; overflow: hidden; }
    body { font-family: "Inter", "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; display: flex; flex-direction: column; }
    header { padding: 10px 14px; background: var(--panel); border-bottom: 1px solid var(--border); box-shadow: 0 1px 3px rgba(15,23,42,0.06); display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
    .header-row { display: flex; align-items: center; gap: 10px; justify-content: flex-start; width: 100%; }
    .header-left { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .ws-indicator { width: 12px; height: 12px; border-radius: 999px; background: #ef4444; border: 1px solid #e5e7eb; box-shadow: 0 0 0 2px #fff; }
    .ws-indicator.connecting { background: #f59e0b; box-shadow: 0 0 0 2px #fef3c7; animation: pulse 1s infinite alternate; }
    .ws-indicator.connected { background: #22c55e; box-shadow: 0 0 0 2px #dcfce7; animation: pulse 1s infinite alternate-reverse; }
    @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.15); } }
    header h1 { margin: 0; font-size: 16px; }
    .tab-bar { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
    .tabs-scroll { display: flex; gap: 6px; overflow-x: auto; padding: 0 2px; background: transparent; border: none; scrollbar-width: thin; flex: 1; min-width: 0; }
    .session-tab { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; border-radius: 8px; border: 1px solid #e5e7eb; background: #fff; font-size: 12px; line-height: 1.2; cursor: pointer; white-space: nowrap; }
    .session-tab.active { border-color: #c7d2fe; background: #eef2ff; color: #1e1b4b; box-shadow: 0 1px 2px rgba(31,41,55,0.08); }
    .session-tab .label { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    .session-tab .close { border: none; background: transparent; cursor: pointer; color: #9ca3af; font-size: 11px; }
    .session-tab .close:hover { color: #ef4444; }
    .tab-icons { display: inline-flex; gap: 6px; flex-shrink: 0; }
    .tab-icons button { width: 30px; height: 28px; border-radius: 8px; border: 1px solid #d6d9e0; background: #fff; cursor: pointer; }
    .tab-icons button:hover { border-color: #c7d2fe; background: #eef2ff; }
    .session-panel { display: flex; flex-direction: column; gap: 6px; }
    .session-current { font-size: 13px; color: var(--text); word-break: break-all; display: flex; align-items: center; gap: 6px; }
    .session-pill { display: inline-flex; align-items: center; justify-content: center; padding: 4px 8px; border-radius: 999px; background: #eef2ff; color: #312e81; font-weight: 700; min-width: 56px; max-width: 100%; }
    .session-rename { border: 1px solid #d6d9e0; background: #fff; color: #4b5563; border-radius: 8px; padding: 4px 6px; font-size: 12px; cursor: pointer; }
    .session-rename:hover { border-color: #c7d2fe; color: #312e81; }
    main { max-width: 1200px; width: 100%; margin: 0 auto; padding: 10px 12px 8px; display: flex; gap: 10px; flex: 1; min-height: 0; overflow: hidden; }
    #sidebar { width: 240px; min-width: 220px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 12px; box-shadow: 0 4px 12px rgba(15,23,42,0.04); display: flex; flex-direction: column; gap: 10px; }
    .sidebar-title { font-size: 13px; font-weight: 600; margin: 0; color: var(--muted); }
    .workspace-list { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); }
    .workspace-list .path { color: var(--text); word-break: break-all; }
    .files-list { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text); max-height: 260px; overflow-y: auto; }
    #console { flex: 1; display: flex; flex-direction: column; gap: 12px; min-height: 0; min-width: 0; overflow: hidden; }
    #log { position: relative; overflow-y: auto; overflow-x: hidden; padding: 14px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 6px 22px rgba(15,23,42,0.04); display: flex; flex-direction: column; gap: 12px; scrollbar-gutter: stable; }
    .msg { display: flex; flex-direction: column; gap: 6px; max-width: 100%; align-items: flex-start; }
    .msg.user { align-items: flex-start; }
    .msg.ai { align-items: flex-start; }
    .msg.status { align-items: flex-start; }
    .bubble { border-radius: 12px; padding: 12px 14px; line-height: 1.6; font-size: 14px; color: var(--text); max-width: 100%; word-break: break-word; overflow-wrap: anywhere; }
    .user .bubble { background: var(--user); }
    .ai .bubble { background: var(--ai); }
    .status .bubble { background: var(--status); color: var(--muted); font-size: 13px; }
    .meta { font-size: 12px; color: var(--muted); display: none; }
    .code-block { background: #f7f7f9; color: #111827; padding: 12px; border-radius: 10px; overflow-x: auto; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; border: 1px solid #e5e7eb; }
    .code-block code { background: transparent !important; display: block; font: inherit; white-space: pre-wrap; padding: 0 !important; color: inherit; }
    .bubble > code { background: rgba(15,23,42,0.07); padding: 2px 5px; border-radius: 6px; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 13px; }
    .bubble h1, .bubble h2, .bubble h3 { margin: 0 0 6px; line-height: 1.3; }
    .bubble p { margin: 0 0 8px; }
    .bubble ul { margin: 0 0 8px 18px; padding: 0; }
    .bubble a { color: var(--accent); text-decoration: none; }
    .bubble a:hover { text-decoration: underline; }
    .cmd-details summary { cursor: pointer; color: var(--accent); }
    #form { flex-shrink: 0; padding: 0; background: transparent; border: none; box-shadow: none; display: flex; flex-direction: column; gap: 8px; width: 100%; box-sizing: border-box; }
    #input-wrapper { position: relative; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 2px 8px rgba(15,23,42,0.06); }
    #attach-btn { position: absolute; left: 8px; bottom: 12px; width: 20px; height: 20px; padding: 0; background: transparent; border: none; color: #9ca3af; cursor: pointer; font-size: 18px; font-weight: 400; line-height: 20px; text-align: center; transition: color 0.15s; }
    #attach-btn:hover { color: #6b7280; }
    #attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #stop-btn { position: absolute; right: 10px; bottom: 12px; width: 24px; height: 24px; padding: 0; background: transparent; border: none; color: #ef4444; cursor: pointer; font-size: 18px; line-height: 20px; text-align: center; transition: color 0.15s, opacity 0.15s; }
    #stop-btn:hover { color: #dc2626; }
    #stop-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    #input { width: 100%; padding: 12px 46px 12px 32px; background: transparent; border: none; border-radius: 12px; font-size: 15px; min-height: 46px; max-height: 180px; resize: none; line-height: 1.5; overflow-x: hidden; overflow-y: auto; white-space: pre-wrap; word-break: break-word; outline: none; }
    #input:focus { outline: none; }
    #input-wrapper:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
    #attachments { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px; }
    #attachments:empty { display: none; }
    #console-header { position: sticky; top: 0; display: flex; justify-content: flex-end; gap: 8px; padding: 4px 0 6px; margin: 0 -2px 4px; background: linear-gradient(var(--panel), rgba(255,255,255,0.9)); z-index: 2; }
    #clear-cache-btn { background: rgba(255,255,255,0.9); border: 1px solid #e5e7eb; color: #6b7280; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 999px; box-shadow: 0 2px 6px rgba(15,23,42,0.06); transition: color 0.15s, border-color 0.15s, box-shadow 0.15s; }
    #clear-cache-btn:hover { color: #ef4444; border-color: #fca5a5; box-shadow: 0 4px 10px rgba(248,113,113,0.18); }
    #clear-cache-btn:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px; background: #eef2ff; color: #1e1b4b; border-radius: 8px; font-size: 12px; }
    .chip button { border: none; background: transparent; cursor: pointer; color: #6b7280; }
    .typing-bubble { display: flex; gap: 6px; align-items: center; }
    .typing-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; animation: typing 1s infinite; opacity: 0.6; }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing { 0% { transform: translateY(0); opacity: 0.6; } 50% { transform: translateY(-2px); opacity: 1; } 100% { transform: translateY(0); opacity: 0.6; } }
    .plan-list { display: flex; flex-direction: column; gap: 6px; }
    .plan-item { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border: 1px solid var(--border); border-radius: 10px; background: #f9fafb; font-size: 13px; line-height: 1.5; }
    .plan-item.done { background: #ecfdf3; border-color: #bbf7d0; color: #166534; }
    .plan-marker { width: 18px; height: 18px; border-radius: 50%; background: #e0e7ff; color: #1d4ed8; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 2px; }
    .plan-item.done .plan-marker { background: #22c55e; color: #fff; }
    .plan-text { flex: 1; word-break: break-word; }
    .muted { color: var(--muted); }
    #session-views { display: flex; flex-direction: column; gap: 12px; width: 100%; }
    .session-view { display: flex; flex-direction: column; gap: 12px; width: 100%; }
    .session-panel { display: flex; flex-direction: column; gap: 8px; }
    .session-current { font-size: 13px; color: var(--text); word-break: break-all; }
    .session-actions { display: flex; gap: 8px; }
    .session-actions button { flex: 1; border: 1px solid var(--border); background: #eef2ff; color: #312e81; border-radius: 8px; padding: 6px 8px; cursor: pointer; font-size: 12px; }
    .session-actions button:hover { border-color: #c7d2fe; }
    .session-dialog { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 16px; }
    .session-dialog.hidden { display: none; }
    .session-dialog .card { background: #fff; border: 1px solid #d6d9e0; border-radius: 12px; padding: 16px; width: 100%; max-width: 420px; box-shadow: 0 12px 30px rgba(15,23,42,0.12); display: flex; flex-direction: column; gap: 12px; }
    .session-list { max-height: 240px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .session-item { padding: 8px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
    .session-item:hover { border-color: #c7d2fe; background: #f8fafc; }
    .session-item .id { font-weight: 700; }
    .session-item .meta { font-size: 12px; color: var(--muted); }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.35); backdrop-filter: blur(18px); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
    .overlay.hidden { display: none; }
    .overlay .card { background: #fff; border: 1px solid #d6d9e0; border-radius: 12px; padding: 20px; width: 100%; max-width: 340px; box-shadow: 0 12px 30px rgba(15,23,42,0.12); display: flex; flex-direction: column; gap: 12px; }
    .overlay h2 { margin: 0; font-size: 18px; }
    .overlay p { margin: 0; color: #4b5563; font-size: 13px; }
    .overlay .row { display: flex; gap: 8px; align-items: center; }
    .overlay input { flex: 1; min-width: 0; padding: 10px 12px; font-size: 16px; border: 1px solid #d6d9e0; border-radius: 8px; }
    .overlay button { padding: 10px 14px; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 16px; white-space: nowrap; }
    body.locked header, body.locked main { filter: blur(18px); pointer-events: none; user-select: none; }
    @media (max-width: 640px) {
      main { padding: 8px; gap: 8px; flex: 1; min-height: 0; overflow: hidden; }
      #sidebar { display: none; }
      #console { width: 100%; min-width: 0; flex: 1; min-height: 0; }
      #log { flex: 0 0 auto; min-height: 100px; }
      #input { min-height: 40px; font-size: 16px; }
      header { padding: 10px 12px; flex-shrink: 0; }
      header h1 { font-size: 16px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <div class="header-left">
        <span id="ws-indicator" class="ws-indicator" title="WebSocket disconnected" aria-label="WebSocket disconnected"></span>
        <h1>ADS</h1>
      </div>
      <div class="tab-bar">
        <div id="session-tabs" class="tabs-scroll"></div>
        <div class="tab-icons">
          <button id="session-new" type="button" title="新建会话">＋</button>
          <button id="session-history" type="button" title="会话历史">⟳</button>
        </div>
      </div>
    </div>
  </header>
  <main>
    <aside id="sidebar">
      <h3 class="sidebar-title">Session</h3>
      <div class="session-panel">
        <div class="session-current">
          <span class="muted">当前：</span>
          <span id="session-id" class="session-pill" title="--">--</span>
          <button id="session-rename" class="session-rename" type="button" title="重命名当前会话">✎</button>
        </div>
      </div>
      <h3 class="sidebar-title">Workspace</h3>
      <div id="workspace-info" class="workspace-list"></div>
      <h3 class="sidebar-title">Modified Files</h3>
      <div id="modified-files" class="files-list"></div>
      <h3 class="sidebar-title">Plan</h3>
      <div id="plan-list" class="files-list plan-list"></div>
    </aside>
    <section id="console">
      <div id="session-views">
        <div class="session-view active" data-session="__initial__">
          <div id="log">
            <div id="console-header">
              <button id="clear-cache-btn" type="button" title="清空本地聊天缓存">清空历史</button>
            </div>
          </div>
          <form id="form">
            <div id="attachments"></div>
            <div id="input-wrapper">
              <textarea id="input" autocomplete="off" placeholder="输入文本或 /ads 命令，Enter 发送，Shift+Enter 换行"></textarea>
              <button id="attach-btn" type="button" title="添加图片">+</button>
              <button id="stop-btn" type="button" title="停止当前回复">■</button>
            </div>
            <input id="image-input" type="file" accept="image/*" multiple hidden />
            <span id="status-label" style="display:none;">已断开</span>
          </form>
        </div>
      </div>
    </section>
  </main>
  <div id="token-overlay" class="overlay">
    <div class="card">
      <h2>输入访问口令</h2>
      <p>未提供口令，无法连接</p>
      <div class="row">
        <input id="token-input" type="password" placeholder="ADS_WEB_TOKEN" autofocus />
        <button id="token-submit" type="button">连接</button>
      </div>
    </div>
  </div>
  <div id="session-dialog" class="session-dialog hidden">
    <div class="card">
      <h3 style="margin:0;">选择会话</h3>
      <div id="session-list" class="session-list"></div>
      <div class="session-actions">
        <button id="session-dialog-close" type="button">关闭</button>
      </div>
    </div>
  </div>
  <div id="alias-overlay" class="overlay hidden">
    <div class="card">
      <h2 style="margin:0;">设置会话名称</h2>
      <p style="margin:0;color:#4b5563;font-size:13px;">留空恢复默认</p>
      <div class="row">
        <input id="alias-input" type="text" placeholder="新名称" />
      </div>
      <div class="row" style="justify-content:flex-end;">
        <button id="alias-cancel" type="button" style="background:#e5e7eb;color:#111827;">取消</button>
        <button id="alias-save" type="button">保存</button>
      </div>
    </div>
  </div>
  <script>
    const sessionViewHost = document.getElementById('session-views');
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
    const idleMinutes = ${options.idleMinutes};
    const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
    const MAX_LOG_MESSAGES = 300;
    const MAX_SESSION_HISTORY = 15;
    const MAX_OPEN_SESSIONS = 10;
    const COMMAND_OUTPUT_MAX_LINES = 3;
    const COMMAND_OUTPUT_MAX_CHARS = 1200;
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

    function ensureConnection(sessionId) {
      if (!connections.has(sessionId)) {
        connections.set(sessionId, {
          sessionId,
          ws: null,
          generation: 0,
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
      return str.replace(/[&<>\"']/g, (ch) => {
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
      if (options.markdown) {
        bubble.innerHTML = renderMarkdown(text);
      } else if (options.html) {
        bubble.innerHTML = text;
      } else {
        bubble.textContent = text;
      }
      wrapper.appendChild(bubble);
      logEl.appendChild(wrapper);
      pruneLog();
      autoScrollIfNeeded();
      if (!options.skipCache) {
        recordCache(role, text, options.status ? 'status' : undefined);
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
        renderPlanStatus('生成计划中...');
        savePlanCache([], currentSessionId);
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
      const payload = { type: 'command', payload: '/ads.cd ' + cached };
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
      clearLogMessages();
      items.forEach((item) => {
        const role = item.role || item.r || 'status';
        const text = item.text || item.t || '';
        const kind = item.kind || item.k;
        const isStatus = role === 'status' || kind === 'status' || kind === 'plan' || kind === 'error';
        appendMessage(role === 'status' ? 'status' : role, text, { markdown: false, status: isStatus, skipCache: true });
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
      withSessionContext(sessionId, () => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'result') {
            handleResult(msg, conn);
          } else if (msg.type === 'delta') {
            handleDelta(msg.delta || '');
          } else if (msg.type === 'command') {
            const cmd = msg.command || {};
            renderCommandView({
              id: cmd.id,
              commandText: cmd.command || msg.detail || '',
              detail: msg.detail,
              status: cmd.status || 'in_progress',
              output: cmd.aggregated_output || '',
              exitCode: cmd.exit_code,
            });
            return;
          } else if (msg.type === 'history') {
            renderHistory(msg.items || []);
            return;
          } else if (msg.type === 'plan') {
            renderPlan(msg.items || []);
            return;
          } else if (msg.type === 'welcome') {
            setWsState('connected', sessionId);
            if (msg.sessionId) {
              updateSessionLabel(msg.sessionId);
              saveSession(msg.sessionId);
            }
            if (msg.workspace) {
              if (msg.workspace.path) {
                setWorkspaceForSession(sessionId, msg.workspace.path);
                maybeRestoreWorkspace(sessionId, msg.workspace.path, conn);
              }
              renderWorkspaceInfo(msg.workspace);
            }
          } else if (msg.type === 'workspace') {
            if (msg.data?.path) {
              setWorkspaceForSession(sessionId, msg.data.path);
            }
            renderWorkspaceInfo(msg.data);
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
      saveSession(sessionIdToUse);
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
      if (!token) {
        tokenOverlay.classList.remove('hidden');
        tokenInput.focus();
        setLocked(true);
        return null;
      }
      tokenOverlay.classList.add('hidden');
      setLocked(false);
      if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) {
        return conn.ws;
      }
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
      conn.ws = new WebSocket(url, ['ads-token', token, 'ads-session', sessionIdToUse]);
      conn.ws.onopen = () => {
        if (socketId !== conn.generation) return;
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
        resetIdleTimer();
        setLocked(false);
        // flush pending sends
        const pending = [...conn.pendingSends];
        conn.pendingSends = [];
        pending.forEach(({ type, payload }) => {
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
        if (socketId !== conn.generation) return;
        withSessionContext(sessionIdToUse, () => {
          setWsState('disconnected', sessionIdToUse);
          setBusy(false);
          clearTypingPlaceholder(sessionIdToUse);
          streamState = null;
        });
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        if (ev.code === 4401) {
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
        renderWorkspaceInfo(null);
        scheduleReconnect(sessionIdToUse);
      };
      conn.ws.onerror = (err) => {
        if (socketId !== conn.generation) return;
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
      if (!planTouched) {
        renderPlanStatus('本轮未生成计划');
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

    tokenSubmit.addEventListener('click', () => {
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
    });

    tokenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tokenSubmit.click();
      }
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
  </script>
</body>
</html>`;
}
