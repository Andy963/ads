import type { ThreadItem, ThreadEvent } from '@openai/codex-sdk';

export interface FormattedEvent {
  text: string;
  isDangerous?: boolean;
  dangerReason?: string;
}

/**
 * 格式化 Codex 事件为 Telegram 消息
 */
export function formatThreadEvent(event: ThreadEvent): FormattedEvent | null {
  switch (event.type) {
    case 'turn.started':
      return { text: '🤔 开始处理...' };
    
    case 'turn.completed':
      return null; // 不显示，让最终响应处理
    
    case 'turn.failed':
      return { text: `❌ 执行失败: ${event.error.message}` };
    
    case 'item.started':
      return formatItemStarted(event.item);
    
    case 'item.updated':
      return formatItemUpdated(event.item);
    
    case 'item.completed':
      return formatItemCompleted(event.item);
    
    case 'error':
      return { text: `⚠️ 错误: ${event.message}` };
    
    default:
      return null;
  }
}

function formatItemStarted(item: ThreadItem): FormattedEvent | null {
  switch (item.type) {
    case 'command_execution':
      return formatCommandExecution(item, 'started');
    
    case 'file_change':
      return formatFileChange(item, 'started');
    
    case 'mcp_tool_call':
      return { text: `🔧 调用工具: ${item.tool} (${item.server})` };
    
    case 'web_search':
      return { text: `🔍 搜索: ${item.query}` };
    
    case 'todo_list':
      return formatTodoList(item);
    
    case 'reasoning':
      return { text: `💭 分析中...` };
    
    case 'agent_message':
      return null; // 由流式文本处理
    
    default:
      return null;
  }
}

function formatItemUpdated(item: ThreadItem): FormattedEvent | null {
  switch (item.type) {
    case 'command_execution':
      if (item.status === 'in_progress' && item.aggregated_output) {
        // 命令有输出时显示
        const output = item.aggregated_output.slice(0, 200);
        return { text: `📟 输出: ${output}${item.aggregated_output.length > 200 ? '...' : ''}` };
      }
      return null;
    
    case 'todo_list':
      return formatTodoList(item);
    
    default:
      return null;
  }
}

function formatItemCompleted(item: ThreadItem): FormattedEvent | null {
  switch (item.type) {
    case 'command_execution':
      return formatCommandExecution(item, 'completed');
    
    case 'file_change':
      return formatFileChange(item, 'completed');
    
    case 'mcp_tool_call':
      if (item.status === 'failed') {
        return { text: `❌ 工具调用失败: ${item.error?.message || '未知错误'}` };
      }
      return { text: `✅ 工具 ${item.tool} 完成` };
    
    case 'web_search':
      return { text: `✅ 搜索完成` };
    
    default:
      return null;
  }
}

function formatCommandExecution(item: any, stage: 'started' | 'completed'): FormattedEvent | null {
  const command = item.command || '';
  const dangerous = checkDangerousCommand(command);
  
  if (stage === 'started') {
    return {
      text: `${dangerous.isDangerous ? '⚠️' : '▶️'} 执行: \`${truncate(command, 100)}\``,
      isDangerous: dangerous.isDangerous,
      dangerReason: dangerous.reason,
    };
  }
  
  // completed
  if (item.status === 'failed') {
    return {
      text: `❌ 命令失败 (退出码: ${item.exit_code})`,
    };
  }
  
  // 成功时不发送“命令完成”提示，输出由其他逻辑单独呈现
  return null;
}

function formatFileChange(item: any, stage: 'started' | 'completed'): FormattedEvent {
  const changes = item.changes || [];
  const dangerous = checkDangerousFileChanges(changes);
  
  if (stage === 'started') {
    const summary = changes.slice(0, 3).map((c: any) => 
      `${getChangeIcon(c.kind)} ${c.path}`
    ).join('\n');
    
    const more = changes.length > 3 ? `\n...还有 ${changes.length - 3} 个文件` : '';
    
    return {
      text: `📝 文件变更:\n${summary}${more}`,
      isDangerous: dangerous.isDangerous,
      dangerReason: dangerous.reason,
    };
  }
  
  // completed
  if (item.status === 'failed') {
    return { text: `❌ 文件变更失败` };
  }
  
  return { text: `✅ 已应用 ${changes.length} 个文件变更` };
}

function formatTodoList(item: any): FormattedEvent | null {
  const items = item.items || [];
  const completed = items.filter((i: any) => i.completed).length;
  const total = items.length;
  
  if (total === 0) return null;
  
  const preview = items.slice(0, 3).map((i: any) => 
    `${i.completed ? '✅' : '⬜️'} ${i.text}`
  ).join('\n');
  
  return {
    text: `📋 任务进度 (${completed}/${total}):\n${preview}${total > 3 ? '\n...' : ''}`,
  };
}

function getChangeIcon(kind: string): string {
  switch (kind) {
    case 'add': return '➕';
    case 'delete': return '🗑️';
    case 'update': return '✏️';
    default: return '📄';
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

/**
 * 检测危险命令
 */
export function checkDangerousCommand(command: string): { isDangerous: boolean; reason?: string } {
  const cmd = command.toLowerCase().trim();
  
  // 删除操作
  if (cmd.includes('rm -rf') || cmd.includes('rm -fr')) {
    if (cmd.includes('rm -rf /') || cmd.includes('rm -rf ~') || cmd.includes('rm -rf .') || 
        cmd.includes('node_modules') || cmd.includes('dist') || cmd.includes('.git')) {
      return { isDangerous: true, reason: '⚠️ 危险：删除大量文件' };
    }
    return { isDangerous: true, reason: '⚠️ 警告：递归删除文件' };
  }
  
  if (cmd.match(/\brm\b.*-r/)) {
    return { isDangerous: true, reason: '⚠️ 警告：递归删除' };
  }
  
  // 格式化操作
  if (cmd.includes('mkfs') || cmd.includes('dd if=') || cmd.includes('fdisk')) {
    return { isDangerous: true, reason: '⚠️ 危险：磁盘操作' };
  }
  
  // 系统修改
  if (cmd.includes('chmod 777') || cmd.includes('chown -R')) {
    return { isDangerous: true, reason: '⚠️ 警告：修改文件权限' };
  }
  
  // 危险脚本
  if (cmd.includes('curl') && cmd.includes('| sh')) {
    return { isDangerous: true, reason: '⚠️ 危险：执行远程脚本' };
  }
  
  if (cmd.includes('wget') && cmd.includes('| bash')) {
    return { isDangerous: true, reason: '⚠️ 危险：执行远程脚本' };
  }
  
  return { isDangerous: false };
}

/**
 * 检测危险文件变更
 */
export function checkDangerousFileChanges(changes: any[]): { isDangerous: boolean; reason?: string } {
  // 检查是否删除重要文件
  const deletions = changes.filter(c => c.kind === 'delete');
  
  for (const del of deletions) {
    const path = del.path.toLowerCase();
    
    // 删除配置文件
    if (path.includes('package.json') || path.includes('tsconfig.json') || 
        path.includes('.git/') || path === '.gitignore') {
      return { isDangerous: true, reason: '⚠️ 危险：删除重要配置文件' };
    }
    
    // 删除整个目录
    if (path.includes('src/') && deletions.length > 10) {
      return { isDangerous: true, reason: '⚠️ 危险：删除多个源文件' };
    }
  }
  
  // 大量文件变更
  if (changes.length > 50) {
    return { isDangerous: true, reason: '⚠️ 警告：变更文件数量过多' };
  }
  
  return { isDangerous: false };
}
