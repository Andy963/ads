"""
Slash commands MCP tools
"""

import json
from pathlib import Path
from typing import Optional, Dict

from ...commands import CommandLoader, CommandExecutor
from ...workspace.detector import WorkspaceDetector


async def list_commands(workspace_path: Optional[str] = None) -> str:
    """
    列出所有可用的 slash commands。

    Args:
        workspace_path: 工作空间路径（可选，默认自动检测）

    Returns:
        JSON 格式的命令列表
    """
    try:
        if not workspace_path:
            workspace_path = str(WorkspaceDetector.detect())

        workspace = Path(workspace_path)
        commands = CommandLoader.list_commands(workspace)

        return json.dumps({
            "workspace": str(workspace),
            "commands": commands,
            "count": len(commands)
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "error": str(e)
        }, ensure_ascii=False)


async def get_command(
    command_name: str,
    workspace_path: Optional[str] = None
) -> str:
    """
    获取命令详情。

    Args:
        command_name: 命令名称
        workspace_path: 工作空间路径（可选）

    Returns:
        JSON 格式的命令详情
    """
    try:
        if not workspace_path:
            workspace_path = str(WorkspaceDetector.detect())

        workspace = Path(workspace_path)
        command = CommandLoader.get_command(workspace, command_name)

        if not command:
            return json.dumps({
                "error": f"命令不存在: {command_name}"
            }, ensure_ascii=False)

        return json.dumps({
            "name": command.name,
            "title": command.title,
            "description": command.description,
            "variables": command.variables,
            "content": command.content,
            "file_path": str(command.file_path)
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "error": str(e)
        }, ensure_ascii=False)


async def execute_command(
    command_name: str,
    variables: Optional[str] = None,
    workspace_path: Optional[str] = None
) -> str:
    """
    执行 slash command，进行变量替换。

    Args:
        command_name: 命令名称
        variables: JSON 格式的变量字典（可选）
        workspace_path: 工作空间路径（可选）

    Returns:
        展开后的命令内容
    """
    try:
        if not workspace_path:
            workspace_path = str(WorkspaceDetector.detect())

        workspace = Path(workspace_path)

        # 解析变量
        var_dict = {}
        if variables:
            try:
                var_dict = json.loads(variables)
            except json.JSONDecodeError as e:
                return json.dumps({
                    "error": f"变量格式错误: {str(e)}"
                }, ensure_ascii=False)

        # 执行命令
        expanded_content = CommandExecutor.execute(
            workspace,
            command_name,
            var_dict
        )

        return json.dumps({
            "success": True,
            "command": command_name,
            "expanded_content": expanded_content
        }, ensure_ascii=False, indent=2)

    except ValueError as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False)


async def validate_command(
    command_name: str,
    variables: Optional[str] = None,
    workspace_path: Optional[str] = None
) -> str:
    """
    验证命令和变量。

    Args:
        command_name: 命令名称
        variables: JSON 格式的变量字典（可选）
        workspace_path: 工作空间路径（可选）

    Returns:
        验证结果
    """
    try:
        if not workspace_path:
            workspace_path = str(WorkspaceDetector.detect())

        workspace = Path(workspace_path)

        # 解析变量
        var_dict = {}
        if variables:
            try:
                var_dict = json.loads(variables)
            except json.JSONDecodeError:
                var_dict = {}

        # 验证
        result = CommandExecutor.validate_command(
            workspace,
            command_name,
            var_dict
        )

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "valid": False,
            "error": str(e)
        }, ensure_ascii=False)
