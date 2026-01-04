import { LANDING_PAGE_CSS } from "./landingPage/styles.js";
import { renderLandingPageScript } from "./landingPage/script.js";

export interface LandingPageOptions {
  idleMinutes: number;
  tokenRequired: boolean;
}

export function renderLandingPage(options: LandingPageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="color-scheme" content="light dark" />
  <title>ADS Web Console</title>
  <style>
${LANDING_PAGE_CSS}  </style>
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
      <form id="token-form" class="row" autocomplete="off">
        <input id="token-input" type="password" placeholder="ADS_WEB_TOKEN" autocomplete="off" />
        <button id="token-submit" type="submit">连接</button>
      </form>
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
${renderLandingPageScript(options.idleMinutes, options.tokenRequired)}  </script>
</body>
</html>`;
}
