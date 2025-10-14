"""
节点定稿功能的辅助函数

提供节点验证和版本管理功能。
文件系统操作请使用 file_manager.py 中的 WorkflowFileManager。
"""
import logging
from datetime import datetime
from typing import Optional, Tuple

from .models import Node, NodeVersion, Edge
from .exceptions import NodeNotFoundException, InvalidOperationException

logger = logging.getLogger(__name__)


# ==========  节点验证和版本管理 ==========

def validate_node_for_finalization(db, node_id: str) -> Node:
    """验证节点是否可以定稿

    Args:
        db: 数据库会话
        node_id: 节点ID

    Returns:
        Node: 验证通过的节点对象

    Raises:
        NodeNotFoundException: 节点不存在
        InvalidOperationException: 没有草稿可以定稿
    """
    node = db.query(Node).filter(Node.id == node_id).first()
    if not node:
        raise NodeNotFoundException("Node not found")

    if not node.is_draft:
        raise InvalidOperationException("没有草稿可以定稿")

    return node


def create_node_version(db, node: Node, change_description: Optional[str] = None) -> Tuple[NodeVersion, int]:
    """创建节点版本快照

    Args:
        db: 数据库会话
        node: 节点对象
        change_description: 变更描述

    Returns:
        tuple: (version对象, 版本号)
    """
    # 版本号递增
    new_version = (node.current_version or 0) + 1

    # 创建版本快照
    version = NodeVersion(
        node_id=node.id,
        version=new_version,
        content=node.draft_content,
        source_type=node.draft_source_type,
        conversation_id=node.draft_conversation_id,
        message_id=node.draft_message_id,
        based_on_version=node.draft_based_on_version,
        change_description=change_description
    )
    db.add(version)

    return version, new_version


def update_node_content(node: Node, new_version: int):
    """更新节点内容为草稿内容

    Args:
        node: 节点对象
        new_version: 新版本号
    """
    node.content = node.draft_content
    node.current_version = new_version
    node.updated_at = datetime.now()


def clear_draft(node: Node):
    """清空节点草稿区

    Args:
        node: 节点对象
    """
    node.draft_content = None
    node.draft_source_type = None
    node.draft_conversation_id = None
    node.draft_message_id = None
    node.draft_based_on_version = None
    node.draft_ai_original_content = None
    node.is_draft = False
    node.draft_updated_at = None


# ========== 工作流根节点查找（已废弃，请使用 file_manager.py） ==========
# 注意：以下功能已在 file_manager.py 中实现，保留此处仅为向后兼容

def find_aggregate_ancestor(db, node_id: str, max_depth: int = 10) -> Optional[Node]:
    """
    递归向上查找aggregate祖先节点

    ⚠️ 已废弃：请使用 WorkflowFileManager._get_workflow_root_id()
    """
    from .crud import GraphCRUD

    visited = set()
    current_id = node_id

    for _ in range(max_depth):
        if current_id in visited:
            break
        visited.add(current_id)

        parent_edge = db.query(Edge).filter(Edge.target == current_id).first()
        if not parent_edge:
            break

        parent_node = db.query(Node).filter(Node.id == parent_edge.source).first()
        if not parent_node:
            break

        if parent_node.type == 'aggregate':
            return parent_node

        current_id = parent_node.id

    return None


def find_root_node(db, node_id: str, max_depth: int = 10) -> Optional[Node]:
    """
    递归查找工作流根节点(没有父节点的节点)

    ⚠️ 已废弃：请使用 WorkflowFileManager._get_workflow_root_id()
    """
    visited = set()
    current_id = node_id

    for _ in range(max_depth):
        if current_id in visited:
            break
        visited.add(current_id)

        parent_edge = db.query(Edge).filter(Edge.target == current_id).first()
        if not parent_edge:
            return db.query(Node).filter(Node.id == current_id).first()

        current_id = parent_edge.source

    return None


def determine_workflow_root(db, node: Node) -> Node:
    """
    确定节点所属工作流的根节点

    ⚠️ 已废弃：请使用 WorkflowFileManager._get_workflow_root_id()
    """
    if node.type == 'aggregate':
        return node

    aggregate = find_aggregate_ancestor(db, node.id)
    if aggregate:
        return aggregate

    root_node = find_root_node(db, node.id)
    if root_node:
        logger.info(f"未找到aggregate祖先,使用工作流根节点: {root_node.id}({root_node.label})")
        return root_node

    logger.warning(f"节点 {node.id}({node.label}) 未找到工作流根节点,使用当前节点自身")
    return node
