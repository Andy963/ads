import inspect
from contextlib import contextmanager
from typing import List, Optional

from sqlalchemy.orm import Session

from .models import Node, Edge
from ..storage import database
from ..storage.database import get_db


class GraphCRUD:
    """图谱 CRUD 操作，支持可注入的 SQLAlchemy 会话。"""

    @staticmethod
    @contextmanager
    def _session_scope(session: Optional[Session] = None):
        if session is not None:
            yield session, False
            return

        session_factory = getattr(database, "_SessionLocal", None)
        if session_factory is None:
            attr_factory = getattr(database, "SessionLocal", None)
            if attr_factory is not None and not inspect.isfunction(attr_factory):
                session_factory = attr_factory

        if session_factory is not None:
            db = session_factory()
            try:
                yield db, True
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()
            return

        with get_db() as db:
            yield db, True

    @staticmethod
    def create_node(
        id: str,
        type: str,
        label: str,
        content: Optional[str] = "",
        metadata: Optional[dict] = None,
        position: Optional[dict] = None,
        workspace_id: Optional[int] = None,
        is_draft: Optional[bool] = False,
        session: Optional[Session] = None,
    ) -> Node:
        """创建节点，支持外部会话。"""

        metadata = metadata or {}
        position = position or {"x": 0, "y": 0}
        has_content = bool(content and str(content).strip())
        stored_content = content
        draft_value = None

        if is_draft is None:
            is_draft_value = not has_content
        else:
            is_draft_value = is_draft

        if is_draft_value and has_content:
            draft_value = stored_content

        with GraphCRUD._session_scope(session) as (db, managed):
            node = Node(
                id=id,
                type=type,
                label=label,
                content=stored_content,
                draft_content=draft_value,
                is_draft=is_draft_value,
                current_version=1 if has_content and not is_draft_value else 0,
                node_metadata=metadata,
                position=position,
            )
            db.add(node)
            db.flush()
            if managed:
                db.refresh(node)
            return node

    @staticmethod
    def get_all_nodes(
        workspace_id: Optional[int] = None,
        filter_by_workspace: bool = False,
        session: Optional[Session] = None,
    ) -> List[Node]:
        """获取所有节点。"""

        with GraphCRUD._session_scope(session) as (db, _):
            query = db.query(Node)

            if filter_by_workspace:
                if workspace_id is not None:
                    query = query.filter(Node.workspace_id == workspace_id)
                else:
                    query = query.filter(Node.workspace_id == None)  # noqa: E711

            nodes = query.all()
            for node in nodes:
                _ = (
                    node.id,
                    node.type,
                    node.label,
                    node.content,
                    node.node_metadata,
                    node.position,
                    node.created_at,
                    node.updated_at,
                )
            return nodes

    @staticmethod
    def get_node_by_id(node_id: str, session: Optional[Session] = None) -> Optional[Node]:
        """根据 ID 获取节点。"""

        with GraphCRUD._session_scope(session) as (db, _):
            node = db.query(Node).filter(Node.id == node_id).first()
            if node:
                _ = (
                    node.id,
                    node.type,
                    node.label,
                    node.content,
                    node.node_metadata,
                    node.position,
                    node.created_at,
                    node.updated_at,
                    node.current_version,
                    node.draft_content,
                    node.draft_source_type,
                    node.draft_conversation_id,
                    node.draft_message_id,
                    node.draft_based_on_version,
                    node.draft_ai_original_content,
                    node.is_draft,
                    node.draft_updated_at,
                )
            return node

    @staticmethod
    def update_node(
        node_id: str,
        updates: dict,
        session: Optional[Session] = None,
    ) -> Optional[Node]:
        """更新节点。"""

        with GraphCRUD._session_scope(session) as (db, managed):
            node = db.query(Node).filter(Node.id == node_id).first()
            if not node:
                return None

            updates = dict(updates or {})
            if "metadata" in updates:
                updates["node_metadata"] = updates.pop("metadata")

            for key, value in updates.items():
                if hasattr(node, key):
                    setattr(node, key, value)

            db.flush()
            if managed:
                db.refresh(node)
            return node

    @staticmethod
    def delete_node(node_id: str, session: Optional[Session] = None) -> bool:
        """删除节点。"""

        with GraphCRUD._session_scope(session) as (db, _):
            node = db.query(Node).filter(Node.id == node_id).first()
            if not node:
                return False
            db.delete(node)
            db.flush()
            return True

    @staticmethod
    def create_edge(
        id: str,
        source: str,
        target: str,
        label: str = "",
        edge_type: str = "next",
        animated: bool = False,
        source_handle: str = "right",
        target_handle: str = "left",
        workspace_id: Optional[int] = None,
        session: Optional[Session] = None,
    ) -> Edge:
        """创建边。"""

        with GraphCRUD._session_scope(session) as (db, managed):
            edge = Edge(
                id=id,
                source=source,
                target=target,
                source_handle=source_handle,
                target_handle=target_handle,
                label=label,
                edge_type=edge_type,
                animated=animated,
            )
            db.add(edge)
            db.flush()
            if managed:
                db.refresh(edge)
            return edge

    @staticmethod
    def get_all_edges(
        workspace_id: Optional[int] = None,
        filter_by_workspace: bool = False,
        session: Optional[Session] = None,
    ) -> List[Edge]:
        """获取所有边。"""

        with GraphCRUD._session_scope(session) as (db, _):
            query = db.query(Edge)

            if filter_by_workspace:
                if workspace_id is not None:
                    query = query.filter(Edge.workspace_id == workspace_id)
                else:
                    query = query.filter(Edge.workspace_id == None)  # noqa: E711

            edges = query.all()
            for edge in edges:
                _ = (
                    edge.id,
                    edge.source,
                    edge.target,
                    edge.source_handle,
                    edge.target_handle,
                    edge.label,
                    edge.edge_type,
                    edge.animated,
                    edge.created_at,
                    edge.updated_at,
                )
            return edges

    @staticmethod
    def delete_edge(edge_id: str, session: Optional[Session] = None) -> bool:
        """删除边。"""

        with GraphCRUD._session_scope(session) as (db, _):
            edge = db.query(Edge).filter(Edge.id == edge_id).first()
            if not edge:
                return False
            db.delete(edge)
            db.flush()
            return True

    @staticmethod
    def get_edges_from_node(
        node_id: str,
        session: Optional[Session] = None,
    ) -> List[Edge]:
        """获取从指定节点出发的所有边。"""

        with GraphCRUD._session_scope(session) as (db, _):
            edges = db.query(Edge).filter(Edge.source == node_id).all()
            for edge in edges:
                _ = (
                    edge.id,
                    edge.source,
                    edge.target,
                    edge.source_handle,
                    edge.target_handle,
                    edge.label,
                    edge.edge_type,
                    edge.animated,
                    edge.created_at,
                    edge.updated_at,
                )
            return edges

    @staticmethod
    def get_next_node(node_id: str, session: Optional[Session] = None) -> Optional[Node]:
        """获取下一个节点（根据 next 类型的边）。"""

        with GraphCRUD._session_scope(session) as (db, _):
            edge = (
                db.query(Edge)
                .filter(Edge.source == node_id, Edge.edge_type == "next")
                .first()
            )
            if not edge:
                return None
            return GraphCRUD.get_node_by_id(edge.target, session=session)

    @staticmethod
    def get_parent_nodes(
        node_id: str,
        recursive: bool = True,
        session: Optional[Session] = None,
    ) -> List[Node]:
        """递归查找所有父节点。"""

        with GraphCRUD._session_scope(session) as (db, _):
            parents: List[Node] = []
            current_id = node_id
            seen_ids = set()

            while True:
                edge = (
                    db.query(Edge)
                    .filter(Edge.target == current_id, Edge.source != current_id)
                    .first()
                )
                if not edge:
                    break

                parent = db.query(Node).filter(Node.id == edge.source).first()
                if not parent or parent.id in seen_ids:
                    break

                _ = (
                    parent.id,
                    parent.type,
                    parent.label,
                    parent.content,
                    parent.node_metadata,
                    parent.position,
                    parent.created_at,
                    parent.updated_at,
                )

                parents.append(parent)
                seen_ids.add(parent.id)

                if not recursive:
                    break

                current_id = edge.source

            return parents

    @staticmethod
    def get_node_context(
        node_id: str,
        session: Optional[Session] = None,
    ) -> Optional[dict]:
        """获取节点及其上下文信息（包含父节点）。"""

        node = GraphCRUD.get_node_by_id(node_id, session=session)
        if not node:
            return None

        parents = GraphCRUD.get_parent_nodes(node_id, recursive=True, session=session)

        return {
            "node": node,
            "parents": parents,
        }
