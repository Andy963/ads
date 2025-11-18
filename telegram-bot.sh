#!/bin/bash

# Telegram Bot 管理脚本

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_SCRIPT="dist/src/telegram/bot.js"
MCP_SCRIPT="dist/src/mcp/server.js"
ENV_FILE=".env.telegram"
LOG_FILE=".ads/logs/telegram-bot.log"
PID_FILE=".ads/telegram-bot.pid"
MCP_LOG_FILE=".ads/logs/mcp-server.log"
MCP_PID_FILE=".ads/mcp-server.pid"

cd "$BOT_DIR" || exit 1

start_mcp() {
  if [ ! -f "$MCP_SCRIPT" ]; then
    echo "❌ MCP server脚本不存在: $MCP_SCRIPT"
    return 1
  fi

  if [ -f "$MCP_PID_FILE" ]; then
    MCP_PID=$(cat "$MCP_PID_FILE")
    if ps -p "$MCP_PID" > /dev/null 2>&1; then
      echo "ℹ️  MCP server 已在运行 (PID: $MCP_PID)"
      return 0
    fi
  fi

  mkdir -p "$(dirname "$MCP_LOG_FILE")"
  nohup node "$MCP_SCRIPT" > "$MCP_LOG_FILE" 2>&1 &
  MCP_PID=$!
  echo $MCP_PID > "$MCP_PID_FILE"
  sleep 1
  if ps -p "$MCP_PID" > /dev/null 2>&1; then
    echo "✅ MCP server started (PID: $MCP_PID)"
  else
    echo "❌ 无法启动 MCP server"
    tail -n 20 "$MCP_LOG_FILE"
    return 1
  fi
}

stop_mcp() {
  if [ ! -f "$MCP_PID_FILE" ]; then
    return 0
  fi

  MCP_PID=$(cat "$MCP_PID_FILE")
  if ps -p "$MCP_PID" > /dev/null 2>&1; then
    echo "🛑 Stopping MCP server (PID: $MCP_PID)..."
    kill "$MCP_PID"
    sleep 1
    if ps -p "$MCP_PID" > /dev/null 2>&1; then
      echo "⚠️  Force killing MCP server..."
      kill -9 "$MCP_PID"
    fi
  fi
  rm -f "$MCP_PID_FILE"
}

case "$1" in
  start)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if ps -p "$PID" > /dev/null 2>&1; then
        echo "❌ Bot already running (PID: $PID)"
        exit 1
      fi
    fi

    echo "🚀 Starting Telegram Bot..."
    if ! start_mcp; then
      echo "❌ MCP server 启动失败"
      exit 1
    fi
    
    # 验证环境文件安全性
    if [ ! -f "$ENV_FILE" ]; then
      echo "❌ 环境文件不存在: $ENV_FILE"
      exit 1
    fi
    
    # 检查文件权限（强制 600 或 400）
    # 注意：在生产环境中，确保以正确的用户运行此脚本
    PERMS=$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %A "$ENV_FILE" 2>/dev/null)
    if [ "$PERMS" != "600" ] && [ "$PERMS" != "400" ]; then
      echo "❌ 错误: $ENV_FILE 权限不安全 ($PERMS)"
      echo "   其他用户可能读取敏感信息"
      echo "   请执行: chmod 600 $ENV_FILE"
      echo ""
      echo "   提示：在生产环境中，确保："
      echo "   1. 以正确的用户身份运行此脚本"
      echo "   2. 文件权限设为 600 (仅所有者可读写)"
      echo "   3. 文件所有者与运行用户一致"
      exit 1
    fi
    
    # 安全地加载环境变量（只读取 KEY=VALUE 格式，忽略其他）
    while IFS='=' read -r key value; do
      # 跳过注释、空行、无效行
      [[ "$key" =~ ^[[:space:]]*# ]] && continue
      [[ -z "$key" ]] && continue
      [[ ! "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] && continue
      
      # 移除首尾引号和空格
      value="${value#\"}"
      value="${value%\"}"
      value="${value#\'}"
      value="${value%\'}"
      
      export "$key=$value"
    done < "$ENV_FILE"
    
    nohup node "$BOT_SCRIPT" > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    
    if ps -p $(cat "$PID_FILE") > /dev/null 2>&1; then
      echo "✅ Bot started (PID: $(cat "$PID_FILE"))"
      tail -5 "$LOG_FILE"
    else
      echo "❌ Failed to start bot"
      tail -10 "$LOG_FILE"
      exit 1
    fi
    ;;

  stop)
    if [ ! -f "$PID_FILE" ]; then
      echo "❌ PID file not found"
      pkill -f "node $BOT_SCRIPT" && echo "✅ Bot stopped (forced)" || echo "ℹ️  No bot process found"
      stop_mcp
      exit 0
    fi

    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
      echo "🛑 Stopping bot (PID: $PID)..."
      kill "$PID"
      sleep 1
      
      if ps -p "$PID" > /dev/null 2>&1; then
        echo "⚠️  Force killing..."
        kill -9 "$PID"
      fi
      
      rm -f "$PID_FILE"
      echo "✅ Bot stopped"
    else
      echo "ℹ️  Bot not running"
      rm -f "$PID_FILE"
    fi
    stop_mcp
    ;;

  restart)
    $0 stop
    sleep 1
    $0 start
    ;;

  status)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if ps -p "$PID" > /dev/null 2>&1; then
        echo "✅ Bot is running (PID: $PID)"
        ps -p "$PID" -o pid,etime,rss,cmd
      else
        echo "❌ Bot not running (stale PID file)"
        rm -f "$PID_FILE"
      fi
    else
      echo "❌ Bot not running"
    fi
    if [ -f "$MCP_PID_FILE" ]; then
      MCP_PID=$(cat "$MCP_PID_FILE")
      if ps -p "$MCP_PID" > /dev/null 2>&1; then
        echo "✅ MCP server is running (PID: $MCP_PID)"
      else
        echo "❌ MCP server not running (stale PID file)"
        rm -f "$MCP_PID_FILE"
      fi
    else
      echo "❌ MCP server not running"
    fi
    ;;

  log)
    if [ ! -f "$LOG_FILE" ]; then
      echo "❌ Log file not found"
      exit 1
    fi
    
    if [ "$2" = "-f" ]; then
      tail -f "$LOG_FILE"
    else
      tail -n ${2:-50} "$LOG_FILE"
    fi
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|log [-f|n]}"
    echo ""
    echo "MCP server log: $MCP_LOG_FILE"
    echo ""
    echo "Commands:"
    echo "  start   - Start the bot"
    echo "  stop    - Stop the bot"
    echo "  restart - Restart the bot"
    echo "  status  - Show bot status"
    echo "  log     - Show last 50 lines of log (use -f to follow, or specify number)"
    exit 1
    ;;
esac
