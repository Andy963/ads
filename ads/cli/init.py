"""
ADS 初始化命令

类似 spec-kit 的 `specify init`，提供简洁的初始化体验。
"""

import json
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.panel import Panel
from rich.tree import Tree
from rich.prompt import Prompt

# AI integration 已移到 server，ads init 只创建基础结构

app = typer.Typer(help="初始化 ADS 工作空间")
console = Console()


def init_workspace(
    name: Optional[str] = None,
    path: Optional[Path] = None
) -> Path:
    """
    初始化 ADS 工作空间。

    Args:
        name: 工作空间名称
        path: 工作空间路径（默认当前目录）

    Returns:
        工作空间路径
    """
    # 确定路径
    if path is None:
        workspace = Path.cwd()
    else:
        workspace = Path(path).absolute()

    if not workspace.exists():
        workspace.mkdir(parents=True)

    if name is None:
        name = workspace.name

    # 创建目录结构
    ads_dir = workspace / ".ads"
    ads_dir.mkdir(exist_ok=True)

    # 创建子目录
    (ads_dir / "templates" / "workflows").mkdir(parents=True, exist_ok=True)
    (ads_dir / "templates" / "nodes").mkdir(parents=True, exist_ok=True)
    (ads_dir / "commands").mkdir(exist_ok=True)

    (workspace / "docs" / "specs").mkdir(parents=True, exist_ok=True)

    # 复制规则模板到工作空间
    _copy_rules_template(ads_dir)

    # 创建配置文件
    config = {
        "name": name,
        "version": "1.0",
        "created_at": __import__("datetime").datetime.now().isoformat()
    }

    config_file = ads_dir / "config.json"
    with open(config_file, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    # 创建数据库
    db_file = ads_dir / "ads.db"
    db_file.touch()

    # 创建示例模板
    _create_example_templates(ads_dir)

    return workspace


def _copy_rules_template(ads_dir: Path):
    """从 ads 包复制规则模板到工作空间"""
    import shutil
    
    # ads 包中的规则模板路径
    ads_package = Path(__file__).parent.parent
    rules_template = ads_package / "templates" / "rules.md"
    
    # 目标路径
    rules_dest = ads_dir / "rules.md"
    
    if rules_template.exists():
        shutil.copy2(rules_template, rules_dest)
        console.print(f"[green]✓[/green] 规则模板已复制到 .ads/rules.md")
    else:
        console.print("[yellow]⚠[/yellow] 规则模板不存在，跳过")


def _create_example_templates(ads_dir: Path):
    """从 ads 包的 examples 目录复制示例模板到用户项目"""
    
    import shutil
    
    # ads 包中的示例模板路径
    ads_package = Path(__file__).parent.parent
    examples_source = ads_package / "templates" / "examples"
    
    if not examples_source.exists():
        console.print("[yellow]警告: 示例模板目录不存在，使用硬编码模板[/yellow]")
        _create_hardcoded_templates(ads_dir)
        return
    
    # 复制 slash commands 示例
    commands_source = examples_source / "commands"
    if commands_source.exists():
        shutil.copytree(
            commands_source,
            ads_dir / "commands",
            dirs_exist_ok=True
        )
    
    # 复制节点模板示例
    nodes_source = examples_source / "nodes"
    if nodes_source.exists():
        shutil.copytree(
            nodes_source,
            ads_dir / "templates" / "nodes",
            dirs_exist_ok=True
        )
    
    # 复制工作流模板示例
    workflows_source = examples_source / "workflows"
    if workflows_source.exists():
        shutil.copytree(
            workflows_source,
            ads_dir / "templates" / "workflows",
            dirs_exist_ok=True
        )


def _create_hardcoded_templates(ads_dir: Path):
    """备用方案：使用硬编码的示例模板（向后兼容）"""
    from rich.console import Console
    console = Console()
    
    # 示例工作流模板
    workflow_template = """# Custom Bugfix Workflow

name: bugfix_workflow
title: Bug Fix Workflow
description: Standard workflow for fixing bugs

nodes:
  - type: bug_report
    title: Bug Report
  - type: analysis
    title: Root Cause Analysis
  - type: fix
    title: Fix Implementation
  - type: test
    title: Testing

edges:
  - from: bug_report
    to: analysis
  - from: analysis
    to: fix
  - from: fix
    to: test
"""

    workflow_file = ads_dir / "templates" / "workflows" / "example.yaml"
    workflow_file.write_text(workflow_template, encoding='utf-8')

    # 示例节点模板 1: Bug Report
    bug_report_template = """name: bug_report
node_type: bug_report
title: "Bug: {{title}}"
content: |
  ## Description
  {{description}}

  ## Steps to Reproduce
  {{steps}}

  ## Expected Behavior
  {{expected}}

  ## Actual Behavior
  {{actual}}

  ## Environment
  - OS: {{os|Unknown}}
  - Version: {{version|N/A}}

variables:
  - title
  - description
  - steps
  - expected
  - actual
"""

    bug_template_file = ads_dir / "templates" / "nodes" / "bug_report.yaml"
    bug_template_file.write_text(bug_report_template, encoding='utf-8')

    # 示例节点模板 2: Feature (Markdown format)
    feature_template = """# Feature: {{title}}

## Overview
{{description}}

## User Stories
{{stories}}

## Requirements

### Must Have
{{must_have}}

### Nice to Have
{{nice_to_have|None}}

## Technical Design
{{design}}

## Acceptance Criteria
{{acceptance_criteria}}
"""

    feature_file = ads_dir / "templates" / "nodes" / "feature.md"
    feature_file.write_text(feature_template, encoding='utf-8')

    # 示例命令 1: Quick Bug Fix
    quick_bug_template = """# Quick Bug Fix

分析以下 bug 并提供修复方案：

**Bug 描述**: {{description}}

请按以下步骤：
1. 分析根本原因
2. 提出修复方案
3. 生成测试用例

遵循项目规则：.ads/rules/workspace.md
"""

    command_file = ads_dir / "commands" / "quick-bug.md"
    command_file.write_text(quick_bug_template, encoding='utf-8')

    # 示例命令 2: Feature Spec
    feature_spec_template = """# Feature Specification

为以下功能创建详细规范：

**功能名称**: {{feature_name}}

**功能描述**: {{description}}

请包含：
1. 用户故事和使用场景
2. 功能需求（必需和可选）
3. 技术实现方案
4. 数据模型设计
5. API 接口设计
6. 测试计划

遵循项目规则和 DDD 原则。
"""

    feature_file = ads_dir / "commands" / "feature-spec.md"
    feature_file.write_text(feature_spec_template, encoding='utf-8')

    # 示例命令 3: Code Review
    code_review_template = """# Code Review

审查以下代码文件：

**文件路径**: {{file_path}}

请检查：
1. 代码质量和可读性
2. 潜在的 bug 和边界情况
3. 性能问题
4. 安全隐患
5. 是否符合项目规则

提供具体的改进建议。
"""

    review_file = ads_dir / "commands" / "code-review.md"
    review_file.write_text(code_review_template, encoding='utf-8')


@app.command()
def init(
    name: Optional[str] = typer.Argument(None, help="工作空间名称"),
    path: Optional[str] = typer.Option(None, "--path", "-p", help="工作空间路径"),
    force: bool = typer.Option(False, "--force", "-f", help="强制重新初始化")
):
    """
    初始化 ADS 工作空间

    示例：
      ads init                     # 在当前目录初始化
      ads init my-project          # 指定名称
      ads init --path ./my-proj    # 指定路径
    """

    workspace_path = Path(path) if path else Path.cwd()
    ads_dir = workspace_path / ".ads"

    # 检查是否已初始化
    if ads_dir.exists() and not force:
        console.print(
            Panel(
                f"[yellow]工作空间已存在: {workspace_path}[/yellow]\n\n"
                "使用 --force 强制重新初始化",
                title="⚠️  警告",
                border_style="yellow"
            )
        )
        raise typer.Exit(1)

    # 初始化
    console.print(f"\n[cyan]🚀 正在初始化 ADS 工作空间...[/cyan]\n")

    workspace = init_workspace(name=name, path=workspace_path)

    # 显示结果
    tree = Tree(f"[bold green]✓ {workspace}[/bold green]")
    ads_node = tree.add("[cyan].ads/[/cyan]")
    ads_node.add("[dim]config.json[/dim] - 配置文件")
    ads_node.add("[green]rules.md[/green] - 项目规则（可编辑）")

    templates_node = ads_node.add("[dim]templates/[/dim]")
    templates_node.add("workflows/ - 工作流模板")
    templates_node.add("nodes/ - 节点模板")

    ads_node.add("[dim]commands/[/dim] - 自定义命令")
    ads_node.add("[dim]ads.db[/dim] - 数据库")

    # 初始化数据库表结构
    try:
        from ..storage.database import init_db
        init_db()
        ads_node.add("[green]✓ 数据库表已初始化[/green]")
    except Exception as e:
        import warnings
        warnings.warn(f"Failed to initialize database tables: {e}")
        ads_node.add("[yellow]⚠ 数据库表初始化失败[/yellow]")

    docs_node = tree.add("[cyan]docs/[/cyan]")
    docs_node.add("[dim]specs/[/dim] - 生成的规范文档")

    console.print(tree)
    console.print()

    # 提示下一步
    next_steps = (
        "[bold]下一步：[/bold]\n"
        "  1. 配置 MCP (查看 README.md 或 docs/HOW_TO_USE_WITH_CLAUDE_CODE.md)\n"
        "  2. 通过 MCP 在 AI 客户端中使用 ADS 工具\n"
        "  3. 创建工作流: [cyan]ads.new standard/bugfix/feature <标题>[/cyan]"
    )

    # 提示
    console.print(Panel(
        f"[bold green]工作空间初始化完成！[/bold green]\n\n"
        f"• 名称: [cyan]{name or workspace.name}[/cyan]\n"
        f"• 数据库: [cyan].ads/ads.db[/cyan]\n"
        f"• 规则: [cyan].ads/rules.md[/cyan] (可编辑)\n\n"
        + next_steps,
        title="✨ 成功",
        border_style="green"
    ))


if __name__ == "__main__":
    app()
