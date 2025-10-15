"""
Graph-related MCP tools (read and write operations).
"""

import json
import os
from pathlib import Path
from typing import Optional
from datetime import datetime

from ...graph.crud import GraphCRUD
# WorkspaceService 已移到 server
from ...storage.database import get_db

# 导入 ads 核心模型
from ...graph.models import Node, NodeVersion, Edge
# WorkspaceConfig 已移到 server
from ...graph.file_manager import WorkflowFileManager
from ...graph.edge_types import get_default_edge_type


async def get_workspace_info(workspace_path: Optional[str] = None) -> str:
    """
    获取工作空间信息和统计数据。
    """
    try:
        from ...workspace.detector import WorkspaceDetector
        
        if not workspace_path:
            workspace_path = str(WorkspaceDetector.detect())
        
        # 检查工作空间是否初始化
        if not WorkspaceDetector.is_initialized(Path(workspace_path)):
            return json.dumps({
                "error": "工作空间未初始化",
                "workspace_path": workspace_path,
                "hint": "请先运行 'ads init' 初始化工作空间"
            }, ensure_ascii=False, indent=2)

        # 统计节点
        nodes = GraphCRUD.get_all_nodes()
        node_stats = {}
        status_stats = {"draft": 0, "finalized": 0}

        for node in nodes:
            # 按类型统计
            node_type = node.type
            node_stats[node_type] = node_stats.get(node_type, 0) + 1

            # 按状态统计
            if node.is_draft:
                status_stats["draft"] += 1
            else:
                status_stats["finalized"] += 1

        # 统计边
        edges = GraphCRUD.get_all_edges()
        edge_stats = {}
        for edge in edges:
            edge_type = edge.edge_type
            edge_stats[edge_type] = edge_stats.get(edge_type, 0) + 1

        # 获取工作空间信息
        workspace_info = WorkspaceDetector.get_workspace_info(Path(workspace_path))

        result = {
            "workspace": {
                "path": workspace_path,
                "name": workspace_info.get("name", Path(workspace_path).name),
                "is_initialized": workspace_info.get("is_initialized", False),
                "db_path": workspace_info.get("db_path"),
                "rules_dir": workspace_info.get("rules_dir"),
                "specs_dir": workspace_info.get("specs_dir")
            },
            "statistics": {
                "nodes": {
                    "total": len(nodes),
                    "by_type": node_stats,
                    "by_status": status_stats
                },
                "edges": {
                    "total": len(edges),
                    "by_type": edge_stats
                }
            }
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


async def list_nodes(
    workspace_path: Optional[str] = None,
    node_type: Optional[str] = None,
    status: Optional[str] = None,
    limit: Optional[int] = None
) -> str:
    """
    列出节点。

    Args:
        workspace_path: 工作空间路径（可选）
        node_type: 节点类型过滤（可选）
        status: 状态过滤 draft/finalized（可选）
        limit: 返回数量限制（可选）
    """
    try:
        nodes = GraphCRUD.get_all_nodes()

        # 过滤节点类型
        if node_type:
            nodes = [n for n in nodes if n.type == node_type]

        # 过滤状态
        if status:
            is_draft = (status == "draft")
            nodes = [n for n in nodes if n.is_draft == is_draft]

        # 限制数量
        if limit:
            nodes = nodes[:limit]

        result = {
            "nodes": [
                {
                    "id": node.id,
                    "type": node.type,
                    "label": node.label,
                    "status": "draft" if node.is_draft else "finalized",
                    "created_at": node.created_at.isoformat() if node.created_at else None,
                    "updated_at": node.updated_at.isoformat() if node.updated_at else None
                }
                for node in nodes
            ],
            "total": len(nodes)
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


async def get_node(node_id: str) -> str:
    """
    获取节点详情。
    """
    try:
        node = GraphCRUD.get_node_by_id(node_id)

        if not node:
            return json.dumps(
                {"error": f"节点不存在: {node_id}"},
                ensure_ascii=False
            )

        result = {
            "node": {
                "id": node.id,
                "type": node.type,
                "label": node.label,
                "content": node.content,
                "status": "draft" if node.is_draft else "finalized",
                "current_version": node.current_version,
                "created_at": node.created_at.isoformat() if node.created_at else None,
                "updated_at": node.updated_at.isoformat() if node.updated_at else None,
                "position": node.position
            }
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


async def get_node_context(node_id: str) -> str:
    """
    获取节点完整上下文（包含所有父节点内容）。
    """
    try:
        context = GraphCRUD.get_node_context(node_id)

        if not context:
            return json.dumps(
                {"error": f"节点不存在: {node_id}"},
                ensure_ascii=False
            )

        node = context["node"]
        parents = context["parents"]

        # 构建上下文字符串
        context_text = "# 任务上下文\n\n"

        # 添加父节点链（从远到近）
        if parents:
            context_text += "## 父节点链\n\n"
            for i, parent in enumerate(reversed(parents), 1):
                context_text += f"### {i}. {parent.label} ({parent.type})\n\n"
                context_text += f"{parent.content}\n\n"
                context_text += "---\n\n"

        # 添加当前节点
        context_text += "## 当前节点\n\n"
        context_text += f"**ID**: {node.id}\n"
        context_text += f"**类型**: {node.type}\n"
        context_text += f"**标题**: {node.label}\n"
        context_text += f"**状态**: {'草稿' if node.is_draft else '已定稿'}\n\n"
        context_text += "### 内容\n\n"
        context_text += f"{node.content}\n"

        result = {
            "context_text": context_text,
            "node": {
                "id": node.id,
                "type": node.type,
                "label": node.label,
                "content": node.content,
                "status": "draft" if node.is_draft else "finalized"
            },
            "parents": [
                {
                    "id": p.id,
                    "type": p.type,
                    "label": p.label,
                    "content": p.content
                }
                for p in reversed(parents)
            ]
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


async def create_node(
    workspace_path: str,
    node_type: str,
    title: str,
    content: str,
    parent_id: Optional[str] = None,
    status: str = "draft"
) -> str:
    """
    创建新节点。
    """
    try:
        from ...graph.workflow_config import generate_node_id
        import uuid

        # 生成节点ID
        node_id = generate_node_id(node_type)

        # 创建节点
        node = GraphCRUD.create_node(
            id=node_id,
            type=node_type,
            label=title,
            content=content,
            metadata={}
        )

        # 如果指定了父节点，创建边
        if parent_id:
            edge_id = f"edge_{uuid.uuid4().hex[:8]}"
            GraphCRUD.create_edge(
                id=edge_id,
                source=parent_id,
                target=node_id,
                edge_type="next"
            )

        # 保存到文件系统
        try:
            file_path = WorkflowFileManager.save_node_to_file(node, workspace_path)
            file_saved = str(file_path)
        except Exception as e:
            file_saved = f"文件保存失败: {str(e)}"

        result = {
            "success": True,
            "node": {
                "id": node.id,
                "type": node.type,
                "label": node.label,
                "content": node.content,
                "status": "draft" if node.is_draft else "finalized"
            },
            "file": file_saved
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False)


async def update_node(
    node_id: str,
    content: Optional[str] = None,
    status: Optional[str] = None
) -> str:
    """
    更新节点。
    """
    try:
        updates = {}

        if content is not None:
            updates["content"] = content

        if status is not None:
            updates["is_draft"] = (status == "draft")

        node = GraphCRUD.update_node(node_id, updates)

        if not node:
            return json.dumps({
                "success": False,
                "error": f"节点不存在: {node_id}"
            }, ensure_ascii=False)

        # 保存到文件系统
        try:
            file_path = WorkflowFileManager.save_node_to_file(node)
            file_saved = str(file_path)
        except Exception as e:
            file_saved = f"文件保存失败: {str(e)}"

        result = {
            "success": True,
            "node": {
                "id": node.id,
                "type": node.type,
                "label": node.label,
                "content": node.content,
                "status": "draft" if node.is_draft else "finalized"
            },
            "file": file_saved
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False)


async def create_edge(
    source_id: str,
    target_id: str,
    edge_type: str
) -> str:
    """
    创建边。
    """
    try:
        import uuid

        edge_id = f"edge_{uuid.uuid4().hex[:8]}"

        edge = GraphCRUD.create_edge(
            id=edge_id,
            source=source_id,
            target=target_id,
            edge_type=edge_type
        )

        result = {
            "success": True,
            "edge": {
                "id": edge.id,
                "source": edge.source,
                "target": edge.target,
                "type": edge.edge_type
            }
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False)


async def finalize_node(node_id: str) -> str:
    """
    将节点标记为已定稿。
    """
    try:
        node = GraphCRUD.update_node(node_id, {"is_draft": False})

        if not node:
            return json.dumps({
                "success": False,
                "error": f"节点不存在: {node_id}"
            }, ensure_ascii=False)

        # 保存到文件系统
        try:
            file_path = WorkflowFileManager.save_node_to_file(node)
            file_saved = str(file_path)
        except Exception as e:
            file_saved = f"文件保存失败: {str(e)}"

        result = {
            "success": True,
            "node": {
                "id": node.id,
                "type": node.type,
                "label": node.label,
                "status": "finalized"
            },
            "file": file_saved
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False)


async def sync_all_nodes_to_files(workspace_path: Optional[str] = None) -> str:
    """
    将所有节点同步到文件系统。

    生成：
    - docs/specs/{workflow_id}/{node_type}.md (每个节点)
    - docs/specs/{workflow_id}/README.md (每个工作流的索引)
    """
    try:
        stats = WorkflowFileManager.sync_all_nodes(workspace_path)

        result = {
            "success": True,
            "statistics": {
                "synced": stats["synced"],
                "errors": stats["errors"],
                "workflows": stats.get("workflows", 0)
            },
            "files": stats.get("files", []),
            "indices": stats.get("indices", []),
            "message": f"成功同步 {stats['synced']} 个节点到 {stats.get('workflows', 0)} 个工作流"
        }

        if stats["errors"] > 0:
            result["message"] += f"，{stats['errors']} 个节点同步失败"

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False)


