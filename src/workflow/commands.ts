import { escapeTelegramMarkdown, escapeTelegramInlineCode } from "../utils/markdown.js";
import type { WorkflowTextFormat } from "./formatter.js";

interface AdsCommandHelpItem {
  usage: string;
  description: string;
}

const ADS_COMMAND_HELP: AdsCommandHelpItem[] = [
  {
    usage: "/ads.init [--name=<workspace>]",
    description: "初始化工作空间（创建 .ads 配置、规则与模板）",
  },
  {
    usage: "/ads.branch [-d|--delete-context <workflow>] [--delete <workflow>]",
    description: "列出所有工作流，或删除上下文/数据库记录",
  },
  {
    usage: "/ads.checkout <workflow>",
    description: "切换到指定工作流（可传标题、ID 或前缀）",
  },
  {
    usage: "/ads.status",
    description: "查看当前工作流的步骤进度与操作提示",
  },
  {
    usage: "/ads.log [limit] [workflow]",
    description: "查看最近的 workflow commit 日志，可指定条数与工作流",
  },
  {
    usage: "/ads.new <title> [--template_id=<unified|adhoc>]",
    description: "创建新的工作流（默认 unified；adhoc=直通模式，仅创建 task 一步），可附加描述",
  },
  {
    usage: "/ads.commit <step>",
    description: "定稿某个步骤并生成版本记录",
  },
  {
    usage: "/ads.review [--skip=<reason>] [--show] [--spec] [--commit[=<ref>]]",
    description: "触发 Reviewer 检查当前工作流，可指定最新提交或当前 diff，默认仅看代码变更",
  },
  {
    usage: "/ads.rules [category]",
    description: "读取项目规则，或按分类过滤",
  },
  {
    usage: "/ads.workspace",
    description: "展示当前工作空间路径、数据库等信息",
  },
  {
    usage: "/ads.sync",
    description: "将节点内容同步写入文件系统",
  },
  {
    usage: "/ads.tasks [active] [--limit=<n>]",
    description: "查看协作任务状态（active 仅显示未完成任务）",
  },
  {
    usage: "/ads.help",
    description: "显示命令帮助",
  },
];

export function buildAdsHelpMessage(format: WorkflowTextFormat): string {
  const lines: string[] = [];
  lines.push(format === "cli" ? "可用命令:" : "**可用命令**");

  for (const item of ADS_COMMAND_HELP) {
    if (format === "cli") {
      lines.push(`  ${item.usage} - ${item.description}`);
    } else {
      lines.push(
        `- \`${escapeTelegramInlineCode(item.usage)}\` - ${escapeTelegramMarkdown(item.description)}`,
      );
    }
  }

  if (format === "cli") {
    lines.push("  直接输入文字（非 /ads.* 命令）即可发送给 Codex");
    lines.push("  /exit 退出");
  } else {
    lines.push("- 直接输入文字（非 `/ads.*` 命令）即可与 Codex 对话");
    lines.push("- 在 CLI 中输入 `/exit` 退出");
  }

  return lines.join("\n");
}
