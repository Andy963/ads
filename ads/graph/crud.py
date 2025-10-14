from typing import List, Optional
from .models import Node, Edge
from ..storage.database import get_db

class GraphCRUD:
    """图谱 CRUD 操作"""

    @staticmethod
    def create_node(id: str, type: str, label: str, content: str = "",
                    metadata: dict = None, position: dict = None, workspace_id: Optional[int] = None) -> Node:
        """
        创建节点（新节点默认为草稿状态）

        新节点状态：
        - is_draft=True（默认）
        - current_version=0（未定稿）
        - content=None（定稿内容为空）
        - draft_content=content参数的值（草稿内容）

        Args:
            workspace_id: 工作空间ID（可选，暂未使用，保留用于未来扩展）
        """
        with get_db() as db:
            node = Node(
                id=id,
                type=type,
                label=label,
                content=None,  # 新建节点的定稿内容为空
                draft_content=content if content else None,  # 内容保存到草稿区
                is_draft=True,  # 新建节点默认为草稿
                current_version=0,  # 未定稿
                node_metadata=metadata or {},
                position=position or {"x": 0, "y": 0}
                # 注意：workspace_id 参数保留用于未来扩展，当前 Node 模型不支持
            )
            db.add(node)
            db.flush()
            # 强制加载所有属性
            _ = (node.id, node.type, node.label, node.content, node.draft_content,
                 node.is_draft, node.current_version,
                 node.node_metadata, node.position, node.created_at, node.updated_at)
            return node
    
    @staticmethod
    def get_all_nodes(workspace_id: Optional[int] = None, filter_by_workspace: bool = False) -> List[Node]:
        """
        获取所有节点

        Args:
            workspace_id: 工作空间ID（可选）
            filter_by_workspace: 是否按 workspace_id 过滤
                - True: 如果提供 workspace_id，只返回该工作空间的节点；否则返回 workspace_id=None 的节点
                - False (默认): 返回所有节点，忽略 workspace_id
        """
        with get_db() as db:
            query = db.query(Node)

            # 只有在明确要求过滤时才应用 workspace_id 过滤
            if filter_by_workspace:
                if workspace_id is not None:
                    query = query.filter(Node.workspace_id == workspace_id)
                else:
                    query = query.filter(Node.workspace_id == None)

            nodes = query.all()
            for node in nodes:
                _ = (node.id, node.type, node.label, node.content,
                     node.node_metadata, node.position, node.created_at, node.updated_at)
            return nodes
    
    @staticmethod
    def get_node_by_id(node_id: str) -> Optional[Node]:
        """根据 ID 获取节点"""
        with get_db() as db:
            node = db.query(Node).filter(Node.id == node_id).first()
            if node:
                # 访问所有字段确保在session关闭前加载到内存（避免lazy loading问题）
                _ = (node.id, node.type, node.label, node.content,
                     node.node_metadata, node.position, node.created_at, node.updated_at,
                     node.current_version, node.draft_content, node.draft_source_type,
                     node.draft_conversation_id, node.draft_message_id, node.draft_based_on_version,
                     node.draft_ai_original_content, node.is_draft, node.draft_updated_at)
            return node
    
    @staticmethod
    def update_node(node_id: str, updates: dict) -> Optional[Node]:
        """更新节点"""
        with get_db() as db:
            node = db.query(Node).filter(Node.id == node_id).first()
            if not node:
                return None
            
            # 处理 metadata 字段映射
            if 'metadata' in updates:
                updates['node_metadata'] = updates.pop('metadata')
            
            for key, value in updates.items():
                if hasattr(node, key):
                    setattr(node, key, value)
            
            db.flush()
            _ = (node.id, node.type, node.label, node.content,
                 node.node_metadata, node.position, node.created_at, node.updated_at)
            return node
    
    @staticmethod
    def delete_node(node_id: str) -> bool:
        """删除节点"""
        with get_db() as db:
            node = db.query(Node).filter(Node.id == node_id).first()
            if not node:
                return False
            db.delete(node)
            return True
    
    @staticmethod
    def create_edge(id: str, source: str, target: str, label: str = "",
                    edge_type: str = "next", animated: bool = False,
                    source_handle: str = 'right', target_handle: str = 'left',
                    workspace_id: Optional[int] = None) -> Edge:
        """
        创建边

        Args:
            workspace_id: 工作空间ID（可选）。如果不提供，边将不关联到任何工作空间
        """
        with get_db() as db:
            edge = Edge(
                id=id, source=source, target=target,
                source_handle=source_handle, target_handle=target_handle,
                label=label, edge_type=edge_type, animated=animated
            )
            db.add(edge)
            db.flush()
            _ = (edge.id, edge.source, edge.target, edge.source_handle, edge.target_handle,
                 edge.label, edge.edge_type, edge.animated, edge.created_at, edge.updated_at)
            return edge
    
    @staticmethod
    def get_all_edges(workspace_id: Optional[int] = None, filter_by_workspace: bool = False) -> List[Edge]:
        """
        获取所有边

        Args:
            workspace_id: 工作空间ID（可选）
            filter_by_workspace: 是否按 workspace_id 过滤
                - True: 如果提供 workspace_id，只返回该工作空间的边；否则返回 workspace_id=None 的边
                - False (默认): 返回所有边，忽略 workspace_id
        """
        with get_db() as db:
            query = db.query(Edge)

            # 只有在明确要求过滤时才应用 workspace_id 过滤
            if filter_by_workspace:
                if workspace_id is not None:
                    query = query.filter(Edge.workspace_id == workspace_id)
                else:
                    query = query.filter(Edge.workspace_id == None)

            edges = query.all()
            for edge in edges:
                _ = (edge.id, edge.source, edge.target, edge.source_handle, edge.target_handle,
                     edge.label, edge.edge_type, edge.animated, edge.created_at, edge.updated_at)
            return edges
    
    @staticmethod
    def delete_edge(edge_id: str) -> bool:
        """删除边"""
        with get_db() as db:
            edge = db.query(Edge).filter(Edge.id == edge_id).first()
            if not edge:
                return False
            db.delete(edge)
            return True
    
    @staticmethod
    def get_next_node(node_id: str) -> Optional[Node]:
        """获取下一个节点（根据 next 类型的边）"""
        with get_db() as db:
            edge = db.query(Edge).filter(
                Edge.source == node_id,
                Edge.edge_type == "next"
            ).first()

            if not edge:
                return None

            return GraphCRUD.get_node_by_id(edge.target)

    @staticmethod
    def get_parent_nodes(node_id: str, recursive: bool = True) -> List[Node]:
        """
        递归查找所有父节点

        Args:
            node_id: 节点 ID
            recursive: 是否递归查找所有父节点（向上追溯）

        Returns:
            父节点列表，从近到远排序
        """
        with get_db() as db:
            parents = []
            current_id = node_id
            seen_ids = set()  # 防止循环引用

            while True:
                # 查找指向当前节点的边（target = current_id），排除自环边
                edge = db.query(Edge).filter(
                    Edge.target == current_id,
                    Edge.source != current_id  # 排除自环边
                ).first()
                if not edge:
                    break

                # 获取父节点（source 节点）
                parent = db.query(Node).filter(Node.id == edge.source).first()
                if not parent:
                    break

                # 检查是否已经访问过（防止循环）
                if parent.id in seen_ids:
                    break

                # 强制加载所有属性
                _ = (parent.id, parent.type, parent.label, parent.content,
                     parent.node_metadata, parent.position, parent.created_at, parent.updated_at)

                parents.append(parent)
                seen_ids.add(parent.id)

                if not recursive:
                    break

                current_id = edge.source

            return parents

    @staticmethod
    def get_node_context(node_id: str) -> dict:
        """
        获取节点及其上下文信息（包含父节点）

        Args:
            node_id: 节点 ID

        Returns:
            {"node": Node, "parents": List[Node]}
        """
        node = GraphCRUD.get_node_by_id(node_id)
        if not node:
            return None

        parents = GraphCRUD.get_parent_nodes(node_id, recursive=True)

        return {
            "node": node,
            "parents": parents
        }
