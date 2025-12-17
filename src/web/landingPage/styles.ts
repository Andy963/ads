export const LANDING_PAGE_CSS = `    :root {
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
    .msg.user { align-items: flex-start; min-width: min(100%, 280px); }
    .msg.ai { align-items: flex-start; min-width: min(100%, 280px); }
    .msg.status { align-items: flex-start; }
    .bubble { border-radius: 12px; padding: 12px 14px; line-height: 1.6; font-size: 14px; color: var(--text); max-width: 100%; word-break: break-word; overflow-wrap: anywhere; }
    .msg.user .bubble, .msg.ai .bubble { width: 100%; }
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
    .bubble-footer { display: flex; justify-content: flex-start; margin-top: 6px; }
    .copy-btn { background: transparent; border: none; padding: 4px; color: #9ca3af; cursor: pointer; transition: all 0.15s; line-height: 1; }
    .copy-btn:hover { color: #2563eb; }
    .copy-btn.copied { color: #22c55e; }
    .copy-btn svg { width: 14px; height: 14px; display: block; }
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
`;
