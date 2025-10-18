"""
Lightweight CLI entrypoints for ADS slash commands.

These commands mirror the MCP slash command behaviour so that users (or
agents such as Codex CLI) can invoke them directly from the shell, e.g.:

    ads.new "开发组件" --type standard
    ads.status
    ads.add requirement --file notes.md
    ads.commit requirement -m "需求已确认"

Each command delegates to the existing MCP tool implementations to keep the
business logic in one place.
"""

from __future__ import annotations

import asyncio
import os
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional

import typer

from ..mcp.tools import context as context_tools
from ..mcp.tools import workflow as workflow_tools
from ..mcp.tools import commands as command_tools

# Common CLI app used by the console-script wrappers and the main `ads` command.
app = typer.Typer(
    name="ads-slash",
    no_args_is_help=True,
    add_completion=False,
)


def _run_async(coro):
    """Execute an async MCP tool function and return its result string."""
    return asyncio.run(coro)


def _resolve_workspace(workspace: Optional[Path]) -> Optional[str]:
    return str(workspace) if workspace else None


def _normalize_command_refs(text: str) -> str:
    """Replace slash-style references with CLI command names."""
    if not text:
        return text

    replacements = {
        "/ads.new": "ads.new",
        "/ads.status": "ads.status",
        "/ads.add": "ads.add",
        "/ads.commit": "ads.commit",
        "/ads.checkout": "ads.checkout",
        "/ads.branch": "ads.branch",
        "/ads.log": "ads.log",
        "/ads.get": "ads.get",
        "/ads.commands": "ads.commands",
        "/ads.run": "ads.run",
    }
    for src, dest in replacements.items():
        text = text.replace(src, dest)
    return text


def _echo_text(payload: str) -> None:
    """Echo plain-text payload after normalising command references."""
    if not payload:
        return
    typer.echo(_normalize_command_refs(payload.strip()))


def _echo_result(payload: str, *, json_output: bool = False) -> None:
    """
    Render MCP tool responses.

    Many tools return JSON strings that include a human friendly `message`.
    When `json_output` is True we forward the full JSON; otherwise we try to
    surface the message field and fall back to the raw text.
    """
    if payload is None:
        return

    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        _echo_text(payload)
        return

    if json_output:
        typer.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return

    message = data.get("message")
    if message:
        _echo_text(message)

    remaining = {k: v for k, v in data.items() if k != "message"}
    if remaining:
        if message:
            typer.echo("")
        typer.echo(json.dumps(remaining, ensure_ascii=False, indent=2))
    elif not message:
        typer.echo(json.dumps(data, ensure_ascii=False, indent=2))


def _default_template() -> str:
    """Resolve default workflow template for ads.new."""
    return os.getenv("ADS_DEFAULT_TEMPLATE", "standard")


@app.command("new")
def new_command(
    first: str = typer.Argument(
        ...,
        metavar="TITLE|TYPE",
        help="工作流标题，或与第二个参数组合使用指定模板类型",
    ),
    second: Optional[str] = typer.Argument(
        None,
        metavar="[TITLE]",
        help="当提供两个位置参数时，这是工作流标题",
    ),
    template_option: Optional[str] = typer.Option(
        None,
        "--type",
        "-t",
        help="工作流模板 ID（如 standard、feature、bugfix，默认读取 ADS_DEFAULT_TEMPLATE 或 standard）",
        envvar="ADS_DEFAULT_TEMPLATE",
        show_default=False,
    ),
    description: Optional[str] = typer.Option(
        None,
        "--description",
        "-d",
        help="可选的初始描述，将写入第一个节点草稿",
    ),
    workspace: Optional[Path] = typer.Option(
        None,
        "--workspace",
        "-w",
        help="指定工作空间路径（默认自动检测）",
    ),
    json_output: bool = typer.Option(
        False,
        "--json",
        help="输出底层工具的完整 JSON 结果，便于调试或自动化",
    ),
) -> None:
    """
    创建新的工作流，等价于 `/ads.new`.

    兼容两种调用方式：
        ads.new "功能标题"                 # 默认模板（ADS_DEFAULT_TEMPLATE 或 standard）
        ads.new bugfix "登录重复提交"     # 指定模板 + 标题
    """
    if second is None:
        # 只有一个位置参数：视为标题
        title = first
        template_id = template_option or _default_template()
    else:
        # 显式提供模板 + 标题
        template_id = template_option or first
        title = second

    result = _run_async(
        workflow_tools.create_workflow_from_template(
            template_id=template_id,
            title=title,
            description=description or "",
            workspace_path=_resolve_workspace(workspace),
        )
    )
    _echo_result(result, json_output=json_output)


@app.command("status")
def status_command(
    workspace: Optional[Path] = typer.Option(
        None,
        "--workspace",
        "-w",
        help="指定工作空间路径（默认自动检测）",
    ),
) -> None:
    """显示当前工作流状态，等价于 `/ads.status`."""
    result = _run_async(
        context_tools.get_workflow_status(_resolve_workspace(workspace))
    )
    _echo_text(result)


@app.command("add")
def add_command(
    step: str = typer.Argument(..., help="工作流步骤名称，如 requirement、design"),
    content_args: Optional[List[str]] = typer.Argument(
        None,
        nargs=-1,
        help="要写入的内容，可包含空格；留空时可通过 STDIN 管道输入",
    ),
    file: Optional[Path] = typer.Option(
        None,
        "--file",
        "-f",
        help="从文件读取完整草稿内容",
    ),
    workspace: Optional[Path] = typer.Option(
        None,
        "--workspace",
        "-w",
        help="指定工作空间路径（默认自动检测）",
    ),
    json_output: bool = typer.Option(
        False,
        "--json",
        help="输出底层工具的完整 JSON 结果，便于调试或自动化",
    ),
) -> None:
    """更新当前工作流步骤草稿，等价于 `/ads.add`."""
    if file:
        content = file.read_text(encoding="utf-8")
    elif content_args:
        content = " ".join(content_args)
    else:
        content = sys.stdin.read()

    if not content.strip():
        raise typer.BadParameter("内容不能为空，可通过参数或标准输入提供。")

    result = _run_async(
        context_tools.update_step_draft(
            step_name=step,
            content=content,
            workspace_path=_resolve_workspace(workspace),
        )
    )
    _echo_result(result, json_output=json_output)


@app.command("commit")
def commit_command(
    step: str = typer.Argument(..., help="要定稿的步骤名称"),
    message: Optional[str] = typer.Option(
        None,
        "--message",
        "-m",
        help="可选的变更说明，用于版本记录",
    ),
    workspace: Optional[Path] = typer.Option(
        None,
        "--workspace",
        "-w",
        help="指定工作空间路径（默认自动检测）",
    ),
) -> None:
    """定稿指定步骤，触发自动流转，等价于 `/ads.commit`."""
    result = _run_async(
        context_tools.finalize_step(
            step_name=step,
            change_description=message,
            workspace_path=_resolve_workspace(workspace),
        )
    )
    _echo_text(result)


@app.command("checkout")
def checkout_command(
    workflow_identifier: str = typer.Argument(
        ...,
        help="工作流 ID、标题或模板关键词",
    ),
    workspace: Optional[Path] = typer.Option(
        None,
        "--workspace",
        "-w",
        help="指定工作空间路径（默认自动检测）",
    ),
) -> None:
    """切换活动工作流，等价于 `/ads.checkout`."""
    result = _run_async(
        context_tools.switch_workflow(
            workflow_identifier=workflow_identifier,
            workspace_path=_resolve_workspace(workspace),
        )
    )
    _echo_text(result)


@app.command("branch")
def branch_command(
    workspace: Optional[Path] = typer.Option(
        None,
        "--workspace",
        "-w",
        help="指定工作空间路径（默认自动检测）",
    ),
    limit: int = typer.Option(
        5,
        "--limit",
        "-l",
        help="列表显示的工作流数量（默认 5）",
    ),
    delete: Optional[str] = typer.Option(
        None,
        "--delete",
        "-d",
        help="删除指定工作流（安全删除，仅完成的工作流）",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        "-D",
        help="与 --delete 配合使用，强制删除工作流",
    ),
) -> None:
    """
    列出或删除工作流，等价于 `/ads.branch`.

    默认列出最近的工作流；使用 `--delete` / `--force` 可以删除工作流。
    """
    if delete:
        result = _run_async(
            context_tools.delete_workflow(
                workflow_id=delete,
                workspace_path=_resolve_workspace(workspace),
                force=force,
            )
        )
    else:
        result = _run_async(
            context_tools.list_workflows(
                workspace_path=_resolve_workspace(workspace),
                limit=limit,
        )
    )
    _echo_text(result)


@app.command("log")
def log_command(
    workspace: Optional[Path] = typer.Option(
        None,
        "--workspace",
        "-w",
        help="指定工作空间路径（默认自动检测）",
    ),
    limit: int = typer.Option(
        5,
        "--limit",
        "-l",
        help="列出最近的工作流数量（默认 5）",
    ),
) -> None:
    """显示工作流活动日志，等价于 `/ads.log`."""
    result = _run_async(
        context_tools.list_workflows(
            workspace_path=_resolve_workspace(workspace),
            limit=limit,
        )
    )
    _echo_text(result)


@app.command("get")
def get_command(
    step: str = typer.Argument(..., help="步骤名称，如 requirement、design、fix"),
    workspace: Optional[Path] = typer.Option(
        None,
        "--workspace",
        "-w",
        help="指定工作空间路径（默认自动检测）",
    ),
    json_output: bool = typer.Option(
        False,
        "--json",
        help="输出底层工具的完整 JSON 结果，便于调试或自动化",
    ),
) -> None:
    """显示指定步骤的节点详情，等价于 `/ads.get`."""
    result = _run_async(
        context_tools.get_step_node(
            step_name=step,
            workspace_path=_resolve_workspace(workspace),
        )
    )
    _echo_result(result, json_output=json_output)


@app.command("commands")
def commands_command(
    workspace: Optional[Path] = typer.Option(
        None,
        "--workspace",
        "-w",
        help="指定工作空间路径（默认自动检测）",
    ),
    json_output: bool = typer.Option(
        False,
        "--json",
        help="输出底层工具的完整 JSON 结果",
    ),
) -> None:
    """列出可用的自定义命令，等价于 `/ads.commands`."""
    result = _run_async(
        command_tools.list_commands(
            workspace_path=_resolve_workspace(workspace),
        )
    )
    if json_output:
        _echo_result(result, json_output=True)
        return

    try:
        data = json.loads(result)
    except json.JSONDecodeError:
        _echo_text(result)
        return

    commands = data.get("commands") or []
    workspace_path = data.get("workspace", "")

    typer.echo(f"Workspace: {workspace_path or '(detected)'}")
    if not commands:
        typer.echo("No commands found.")
        return

    typer.echo("\nAvailable commands:")
    for cmd in commands:
        name = cmd.get("name", "unknown")
        title = cmd.get("title") or ""
        description = cmd.get("description") or ""
        hint = title or description
        if hint:
            typer.echo(f"  • {name}: {hint}")
        else:
            typer.echo(f"  • {name}")


def _parse_key_value(option: str) -> Dict[str, str]:
    if "=" not in option:
        raise typer.BadParameter(f"变量需要使用 key=value 格式: {option}")
    key, value = option.split("=", 1)
    key = key.strip()
    if not key:
        raise typer.BadParameter(f"变量名称不能为空: {option}")
    return {key: value}


@app.command("run")
def run_command(
    command_name: str = typer.Argument(..., help="要执行的命令名称，例如 quick-bug"),
    var: Optional[List[str]] = typer.Option(
        None,
        "--var",
        "-v",
        help="以 key=value 形式提供变量，可重复使用多次",
    ),
    vars_json: Optional[str] = typer.Option(
        None,
        "--vars-json",
        help="JSON 格式的变量字典（与 --var 同时提供时，--var 覆盖同名字段）",
    ),
    workspace: Optional[Path] = typer.Option(
        None,
        "--workspace",
        "-w",
        help="指定工作空间路径（默认自动检测）",
    ),
    json_output: bool = typer.Option(
        False,
        "--json",
        help="输出底层工具的完整 JSON 结果，便于调试或自动化",
    ),
) -> None:
    """执行自定义命令模板，等价于 `/ads.run`."""
    variables: Dict[str, str] = {}

    if vars_json:
        try:
            from_json = json.loads(vars_json)
        except json.JSONDecodeError as exc:
            raise typer.BadParameter(f"无效的 JSON: {exc}") from exc
        if not isinstance(from_json, dict):
            raise typer.BadParameter("JSON 变量必须是对象（键值对）")
        variables.update({str(k): str(v) for k, v in from_json.items()})

    if var:
        for item in var:
            variables.update(_parse_key_value(item))

    variables_payload = json.dumps(variables, ensure_ascii=False) if variables else None

    result = _run_async(
        command_tools.execute_command(
            command_name=command_name,
            variables=variables_payload,
            workspace_path=_resolve_workspace(workspace),
        )
    )
    _echo_result(result, json_output=json_output)


def main() -> None:
    """Entry point for `ads slash` (if wired in the future)."""
    app()


def new_main() -> None:
    """Console script wrapper for `ads.new`."""
    typer.run(new_command)


def status_main() -> None:
    """Console script wrapper for `ads.status`."""
    typer.run(status_command)


def add_main() -> None:
    """Console script wrapper for `ads.add`."""
    typer.run(add_command)


def commit_main() -> None:
    """Console script wrapper for `ads.commit`."""
    typer.run(commit_command)


def checkout_main() -> None:
    """Console script wrapper for `ads.checkout`."""
    typer.run(checkout_command)


def branch_main() -> None:
    """Console script wrapper for `ads.branch`."""
    typer.run(branch_command)


def log_main() -> None:
    """Console script wrapper for `ads.log`."""
    typer.run(log_command)


def get_main() -> None:
    """Console script wrapper for `ads.get`."""
    typer.run(get_command)


def commands_main() -> None:
    """Console script wrapper for `ads.commands`."""
    typer.run(commands_command)


def run_main() -> None:
    """Console script wrapper for `ads.run`."""
    typer.run(run_command)
