"""
Workspace-related MCP tools.
"""

import json
from typing import Optional

from ...workspace.detector import WorkspaceDetector


async def init_workspace(name: Optional[str] = None) -> str:
    """
    初始化当前目录为 AD 工作空间。

    创建：
    - .ads/workspace.json
    - .ads/rules/
    - docs/specs/

    Args:
        name: 工作空间名称（可选，默认使用目录名）

    Returns:
        JSON 格式的初始化结果
    """
    try:
        workspace = WorkspaceDetector.initialize(name=name)

        result = {
            "success": True,
            "workspace": {
                "path": str(workspace),
                "name": name or workspace.name
            },
            "created": {
                "config": str(workspace / ".ads" / "workspace.json"),
                "rules_dir": str(workspace / ".ads" / "rules"),
                "specs_dir": str(workspace / "docs" / "specs"),
                "db": str(workspace / ".ads" / "ads.db")
            },
            "message": f"工作空间已初始化: {workspace}"
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False)


async def get_current_workspace() -> str:
    """
    获取当前工作空间信息。

    Returns:
        JSON 格式的工作空间信息
    """
    try:
        info = WorkspaceDetector.get_workspace_info()

        return json.dumps(info, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "error": str(e)
        }, ensure_ascii=False)
