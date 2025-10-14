"""Aggregate节点查找辅助函数"""
from typing import Optional
from sqlalchemy.orm import Session
from .models import Node, Edge
import logging

logger = logging.getLogger(__name__)


def find_aggregate_ancestor(node_id: str, db: Session) -> Optional[Node]:
    """递归查找aggregate父节点

    Args:
        node_id: 当前节点ID
        db: 数据库session

    Returns:
        Optional[Node]: aggregate节点,未找到则返回None
    """
    parent_edges = db.query(Edge).filter(Edge.target == node_id).all()

    for edge in parent_edges:
        parent_node = db.query(Node).filter(Node.id == edge.source).first()

        # Early return if node not found
        if not parent_node:
            continue

        # Check if parent is aggregate
        if parent_node.type == 'aggregate':
            return parent_node

        # Recursively search ancestors
        ancestor = find_aggregate_ancestor(parent_node.id, db)
        if ancestor:
            return ancestor

    return None


def get_aggregate_for_node(node: Node, db: Session) -> Node:
    """获取节点对应的aggregate

    如果节点本身是aggregate则返回自身,否则查找父aggregate

    Args:
        node: 当前节点
        db: 数据库session

    Returns:
        Node: aggregate节点

    Raises:
        ValueError: 如果找不到aggregate节点
    """
    # Early return if node is already aggregate
    if node.type == 'aggregate':
        return node

    # Search for aggregate ancestor
    aggregate = find_aggregate_ancestor(node.id, db)

    if not aggregate:
        raise ValueError(f"无法找到节点 {node.id} 关联的aggregate节点")

    return aggregate
