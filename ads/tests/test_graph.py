"""
测试 Graph (Node/Edge) CRUD 操作和 Pydantic 序列化
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from ads.storage.base import Base
from ads.graph.crud import GraphCRUD
from ads.graph.schemas import NodeResponse, EdgeResponse
from ads.graph.models import Node, Edge


@pytest.fixture
def test_db():
    """创建测试数据库"""
    # 使用内存数据库
    engine = create_engine("sqlite:///:memory:")
    
    # 导入所有models以确保它们注册到metadata
    from ads.graph.models import Node, Edge, NodeVersion
    # chat models 是 server 专用的，ads 测试不需要
    
    Base.metadata.create_all(engine)

    # 临时替换全局引擎
    from ads.storage import database
    original_engine = database.engine
    database.engine = engine
    database.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)

    yield engine

    # 恢复原始引擎
    database.engine = original_engine
    Base.metadata.drop_all(engine)


class TestNodeCRUD:
    """Node CRUD 测试类"""

    def test_create_node(self, test_db):
        """测试创建节点"""
        node = GraphCRUD.create_node(
            id="node_test_001",
            type="aggregate",
            label="Test Aggregate",
            content="Test content",
            metadata={"status": "draft"},
            position={"x": 100, "y": 200}
        )

        assert node.id == "node_test_001"
        assert node.type == "aggregate"
        assert node.label == "Test Aggregate"
        assert node.content == "Test content"
        assert node.node_metadata["status"] == "draft"
        assert node.position["x"] == 100

    def test_get_node_by_id(self, test_db):
        """测试根据 ID 获取节点"""
        # 创建节点
        GraphCRUD.create_node(
            id="node_test_002",
            type="requirement",
            label="Test Requirement",
            content="Requirement details"
        )

        # 获取节点
        node = GraphCRUD.get_node_by_id("node_test_002")

        assert node is not None
        assert node.id == "node_test_002"
        assert node.type == "requirement"
        assert node.label == "Test Requirement"

    def test_get_all_nodes(self, test_db):
        """测试获取所有节点"""
        # 创建多个节点
        GraphCRUD.create_node(id="node1", type="aggregate", label="Node 1")
        GraphCRUD.create_node(id="node2", type="requirement", label="Node 2")
        GraphCRUD.create_node(id="node3", type="design", label="Node 3")

        nodes = GraphCRUD.get_all_nodes()

        assert len(nodes) == 3
        assert all(isinstance(node, Node) for node in nodes)

    def test_update_node(self, test_db):
        """测试更新节点"""
        # 创建节点
        GraphCRUD.create_node(
            id="node_update",
            type="aggregate",
            label="Original Label",
            content="Original content"
        )

        # 更新节点
        updated = GraphCRUD.update_node(
            "node_update",
            {
                "label": "Updated Label",
                "content": "Updated content",
                "metadata": {"status": "updated"}
            }
        )

        assert updated is not None
        assert updated.label == "Updated Label"
        assert updated.content == "Updated content"
        assert updated.node_metadata["status"] == "updated"

    def test_delete_node(self, test_db):
        """测试删除节点"""
        # 创建节点
        GraphCRUD.create_node(
            id="node_delete",
            type="aggregate",
            label="To Delete"
        )

        # 删除节点
        result = GraphCRUD.delete_node("node_delete")
        assert result is True

        # 验证已删除
        node = GraphCRUD.get_node_by_id("node_delete")
        assert node is None

    def test_node_to_pydantic(self, test_db):
        """测试 Node ORM 到 Pydantic 模型的转换"""
        # 创建节点
        node = GraphCRUD.create_node(
            id="node_pydantic_test",
            type="aggregate",
            label="Pydantic Test",
            content="Testing Pydantic conversion",
            metadata={"key": "value"},
            position={"x": 50, "y": 100}
        )

        # 转换为 Pydantic 模型
        node_response = NodeResponse.from_orm_model(node)

        # 验证转换结果
        assert isinstance(node_response, NodeResponse)
        assert node_response.id == "node_pydantic_test"
        assert node_response.type == "aggregate"
        assert node_response.data["label"] == "Pydantic Test"
        assert node_response.data["content"] == "Testing Pydantic conversion"
        assert node_response.data["key"] == "value"
        assert node_response.position["x"] == 50
        assert node_response.position["y"] == 100
        assert node_response.created_at is not None
        assert node_response.updated_at is not None


class TestEdgeCRUD:
    """Edge CRUD 测试类"""

    def test_create_edge(self, test_db):
        """测试创建边"""
        # 先创建两个节点
        GraphCRUD.create_node(id="node_source", type="aggregate", label="Source")
        GraphCRUD.create_node(id="node_target", type="requirement", label="Target")

        # 创建边
        edge = GraphCRUD.create_edge(
            id="edge_001",
            source="node_source",
            target="node_target",
            label="connects to",
            edge_type="next"
        )

        assert edge.id == "edge_001"
        assert edge.source == "node_source"
        assert edge.target == "node_target"
        assert edge.label == "connects to"
        assert edge.edge_type == "next"

    def test_get_all_edges(self, test_db):
        """测试获取所有边"""
        # 创建节点
        GraphCRUD.create_node(id="n1", type="aggregate", label="N1")
        GraphCRUD.create_node(id="n2", type="requirement", label="N2")
        GraphCRUD.create_node(id="n3", type="design", label="N3")

        # 创建边
        GraphCRUD.create_edge(id="e1", source="n1", target="n2", edge_type="next")
        GraphCRUD.create_edge(id="e2", source="n2", target="n3", edge_type="next")

        edges = GraphCRUD.get_all_edges()

        assert len(edges) == 2
        assert all(isinstance(edge, Edge) for edge in edges)

    def test_delete_edge(self, test_db):
        """测试删除边"""
        # 创建节点和边
        GraphCRUD.create_node(id="ns", type="aggregate", label="Source")
        GraphCRUD.create_node(id="nt", type="requirement", label="Target")
        GraphCRUD.create_edge(id="edge_delete", source="ns", target="nt")

        # 删除边
        result = GraphCRUD.delete_edge("edge_delete")
        assert result is True

        # 验证边已删除
        edges = GraphCRUD.get_all_edges()
        assert len(edges) == 0

    def test_edge_to_pydantic(self, test_db):
        """测试 Edge ORM 到 Pydantic 模型的转换"""
        # 创建节点和边
        GraphCRUD.create_node(id="src", type="aggregate", label="Source")
        GraphCRUD.create_node(id="tgt", type="requirement", label="Target")
        edge = GraphCRUD.create_edge(
            id="edge_pydantic_test",
            source="src",
            target="tgt",
            label="test connection",
            edge_type="dependency",
            animated=True
        )

        # 转换为 Pydantic 模型
        edge_response = EdgeResponse.from_orm_model(edge)

        # 验证转换结果
        assert isinstance(edge_response, EdgeResponse)
        assert edge_response.id == "edge_pydantic_test"
        assert edge_response.source == "src"
        assert edge_response.target == "tgt"
        assert edge_response.label == "test connection"
        assert edge_response.type == "dependency"
        assert edge_response.animated is True


class TestNodeContext:
    """测试节点上下文查询"""

    def test_get_parent_nodes(self, test_db):
        """测试获取父节点"""
        # 创建节点层次结构: root -> middle -> leaf
        GraphCRUD.create_node(id="root", type="aggregate", label="Root")
        GraphCRUD.create_node(id="middle", type="requirement", label="Middle")
        GraphCRUD.create_node(id="leaf", type="design", label="Leaf")

        # 创建边
        GraphCRUD.create_edge(id="e1", source="root", target="middle")
        GraphCRUD.create_edge(id="e2", source="middle", target="leaf")

        # 获取 leaf 的所有父节点（递归）
        parents = GraphCRUD.get_parent_nodes("leaf", recursive=True)

        assert len(parents) == 2
        parent_ids = [p.id for p in parents]
        assert "middle" in parent_ids
        assert "root" in parent_ids

    def test_get_node_context(self, test_db):
        """测试获取节点上下文"""
        # 创建节点层次结构
        GraphCRUD.create_node(id="ctx_root", type="aggregate", label="Root")
        GraphCRUD.create_node(id="ctx_child", type="requirement", label="Child")

        GraphCRUD.create_edge(id="ctx_edge", source="ctx_root", target="ctx_child")

        # 获取上下文
        context = GraphCRUD.get_node_context("ctx_child")

        assert context is not None
        assert context["node"].id == "ctx_child"
        assert len(context["parents"]) == 1
        assert context["parents"][0].id == "ctx_root"


class TestNodeVersions:
    """测试节点版本管理"""

    def test_node_draft_fields(self, test_db):
        """测试节点草稿字段"""
        node = GraphCRUD.create_node(
            id="node_draft",
            type="requirement",
            label="Draft Node"
        )

        # 验证草稿字段初始状态
        assert node.current_version == 0 or node.current_version is None
        assert node.is_draft is False or node.is_draft is None
        assert node.draft_content is None

    def test_update_node_preserves_orm_model(self, test_db):
        """测试更新节点后仍然是 ORM 模型"""
        # 创建节点
        GraphCRUD.create_node(
            id="node_update_orm",
            type="aggregate",
            label="Original"
        )

        # 更新节点
        updated = GraphCRUD.update_node("node_update_orm", {"label": "Updated"})

        # 验证返回的是 ORM 模型
        assert isinstance(updated, Node)
        assert updated.label == "Updated"

        # 验证可以转换为 Pydantic
        response = NodeResponse.from_orm_model(updated)
        assert response.data["label"] == "Updated"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
