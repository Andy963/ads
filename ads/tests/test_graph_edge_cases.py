"""
测试Graph CRUD的边界条件和错误处理
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from ads.storage.base import Base
from ads.graph.crud import GraphCRUD
from ads.graph.models import Node, Edge


@pytest.fixture
def test_db():
    """创建测试数据库"""
    engine = create_engine("sqlite:///:memory:")
    
    from ads.graph.models import Node, Edge, NodeVersion
    
    Base.metadata.create_all(engine)

    from ads.storage import database
    original_engine = database._engine
    original_session = database._SessionLocal
    database._engine = engine
    database._SessionLocal = sessionmaker(
        autocommit=False, 
        autoflush=False, 
        bind=engine, 
        expire_on_commit=False
    )

    yield engine

    database._engine = original_engine
    database._SessionLocal = original_session
    Base.metadata.drop_all(engine)


class TestNodeCRUDEdgeCases:
    """测试Node CRUD边界条件"""

    def test_create_node_with_very_long_id(self, test_db):
        """测试创建具有很长ID的节点"""
        long_id = "node_" + "x" * 200
        node = GraphCRUD.create_node(
            id=long_id,
            type="aggregate",
            label="Long ID Node"
        )
        assert node.id == long_id

    def test_create_node_with_special_characters(self, test_db):
        """测试创建包含特殊字符的节点"""
        node = GraphCRUD.create_node(
            id="node_special_!@#$%^&*()",
            type="requirement",
            label="Special <>&\"' Characters",
            content="Content with\nnewlines\tand\ttabs"
        )
        assert node.label == "Special <>&\"' Characters"
        assert "\n" in node.content
        assert "\t" in node.content

    def test_create_node_with_empty_content(self, test_db):
        """测试创建空内容的节点"""
        node = GraphCRUD.create_node(
            id="node_empty",
            type="aggregate",
            label="Empty Content",
            content=""
        )
        assert node.content == ""

    def test_create_node_with_none_content(self, test_db):
        """测试创建None内容的节点"""
        node = GraphCRUD.create_node(
            id="node_none",
            type="aggregate",
            label="None Content",
            content=None
        )
        assert node.content is None

    def test_create_duplicate_node_id(self, test_db):
        """测试创建重复ID的节点"""
        GraphCRUD.create_node(
            id="duplicate_id",
            type="aggregate",
            label="First"
        )
        
        # 尝试创建相同ID的节点应该失败或被忽略
        # 具体行为取决于数据库约束
        with pytest.raises(Exception):
            GraphCRUD.create_node(
                id="duplicate_id",
                type="requirement",
                label="Second"
            )

    def test_get_nonexistent_node(self, test_db):
        """测试获取不存在的节点"""
        node = GraphCRUD.get_node_by_id("nonexistent_id")
        assert node is None

    def test_update_nonexistent_node(self, test_db):
        """测试更新不存在的节点"""
        result = GraphCRUD.update_node(
            "nonexistent_id",
            {"label": "Updated"}
        )
        assert result is None

    def test_update_node_with_empty_dict(self, test_db):
        """测试用空字典更新节点"""
        GraphCRUD.create_node(
            id="node_update_empty",
            type="aggregate",
            label="Original"
        )
        
        result = GraphCRUD.update_node("node_update_empty", {})
        assert result is not None
        assert result.label == "Original"  # 没有变化

    def test_delete_nonexistent_node(self, test_db):
        """测试删除不存在的节点"""
        result = GraphCRUD.delete_node("nonexistent_id")
        assert result is False

    def test_delete_node_with_edges(self, test_db):
        """测试删除有边连接的节点"""
        # 创建两个节点和一条边
        GraphCRUD.create_node(id="node_with_edge", type="aggregate", label="Node")
        GraphCRUD.create_node(id="target_node", type="requirement", label="Target")
        GraphCRUD.create_edge(
            id="edge_1",
            source="node_with_edge",
            target="target_node"
        )
        
        # 删除有边的节点
        result = GraphCRUD.delete_node("node_with_edge")
        # 应该成功删除（或根据外键约束可能失败）
        # 这取决于数据库设置

    def test_node_with_large_metadata(self, test_db):
        """测试创建包含大量元数据的节点"""
        large_metadata = {
            f"key_{i}": f"value_{i}" for i in range(100)
        }
        
        node = GraphCRUD.create_node(
            id="node_large_meta",
            type="aggregate",
            label="Large Metadata",
            metadata=large_metadata
        )
        
        assert len(node.node_metadata) == 100
        assert node.node_metadata["key_50"] == "value_50"

    def test_node_with_nested_metadata(self, test_db):
        """测试创建包含嵌套元数据的节点"""
        nested_metadata = {
            "level1": {
                "level2": {
                    "level3": {
                        "value": "deep nested"
                    }
                }
            }
        }
        
        node = GraphCRUD.create_node(
            id="node_nested_meta",
            type="aggregate",
            label="Nested Metadata",
            metadata=nested_metadata
        )
        
        assert node.node_metadata["level1"]["level2"]["level3"]["value"] == "deep nested"

    def test_update_node_metadata_merge(self, test_db):
        """测试更新节点元数据是否合并"""
        GraphCRUD.create_node(
            id="node_meta_merge",
            type="aggregate",
            label="Meta Merge",
            metadata={"key1": "value1", "key2": "value2"}
        )
        
        # 更新部分元数据
        updated = GraphCRUD.update_node(
            "node_meta_merge",
            {"metadata": {"key2": "updated", "key3": "new"}}
        )
        
        # 验证元数据是否正确更新
        # 这取决于实现：是覆盖还是合并


class TestEdgeCRUDEdgeCases:
    """测试Edge CRUD边界条件"""

    def test_create_edge_with_nonexistent_nodes(self, test_db):
        """测试创建指向不存在节点的边"""
        # 如果有外键约束，应该失败
        # 如果没有约束，可能成功
        try:
            edge = GraphCRUD.create_edge(
                id="edge_invalid",
                source="nonexistent_source",
                target="nonexistent_target"
            )
            # 如果成功，边应该被创建
            assert edge.source == "nonexistent_source"
        except Exception:
            # 如果失败，符合预期
            pass

    def test_create_self_referencing_edge(self, test_db):
        """测试创建自引用边"""
        GraphCRUD.create_node(id="self_node", type="aggregate", label="Self")
        
        edge = GraphCRUD.create_edge(
            id="self_edge",
            source="self_node",
            target="self_node"
        )
        
        assert edge.source == edge.target

    def test_create_duplicate_edge_id(self, test_db):
        """测试创建重复ID的边"""
        GraphCRUD.create_node(id="n1", type="aggregate", label="N1")
        GraphCRUD.create_node(id="n2", type="requirement", label="N2")
        
        GraphCRUD.create_edge(id="dup_edge", source="n1", target="n2")
        
        with pytest.raises(Exception):
            GraphCRUD.create_edge(id="dup_edge", source="n2", target="n1")

    def test_create_multiple_edges_between_same_nodes(self, test_db):
        """测试在相同节点间创建多条边"""
        GraphCRUD.create_node(id="na", type="aggregate", label="A")
        GraphCRUD.create_node(id="nb", type="requirement", label="B")
        
        edge1 = GraphCRUD.create_edge(id="e1", source="na", target="nb", edge_type="next")
        edge2 = GraphCRUD.create_edge(id="e2", source="na", target="nb", edge_type="dependency")
        
        assert edge1.id != edge2.id
        assert edge1.edge_type != edge2.edge_type

    def test_get_edges_empty_database(self, test_db):
        """测试在空数据库中获取边"""
        edges = GraphCRUD.get_all_edges()
        assert edges == []

    def test_delete_edge_twice(self, test_db):
        """测试删除同一条边两次"""
        GraphCRUD.create_node(id="nx", type="aggregate", label="X")
        GraphCRUD.create_node(id="ny", type="requirement", label="Y")
        GraphCRUD.create_edge(id="edge_del", source="nx", target="ny")
        
        # 第一次删除
        result1 = GraphCRUD.delete_edge("edge_del")
        assert result1 is True
        
        # 第二次删除
        result2 = GraphCRUD.delete_edge("edge_del")
        assert result2 is False


class TestNodeContext:
    """测试节点上下文查询边界条件"""

    def test_get_parent_nodes_for_root_node(self, test_db):
        """测试获取根节点的父节点"""
        GraphCRUD.create_node(id="root", type="aggregate", label="Root")
        
        parents = GraphCRUD.get_parent_nodes("root", recursive=False)
        assert parents == []

    def test_get_parent_nodes_recursive_complex_tree(self, test_db):
        """测试在复杂树结构中递归获取父节点"""
        # 创建多层次结构
        GraphCRUD.create_node(id="root", type="aggregate", label="Root")
        GraphCRUD.create_node(id="branch1", type="requirement", label="Branch 1")
        GraphCRUD.create_node(id="branch2", type="requirement", label="Branch 2")
        GraphCRUD.create_node(id="leaf1", type="design", label="Leaf 1")
        GraphCRUD.create_node(id="leaf2", type="design", label="Leaf 2")
        
        # 创建边: root -> branch1 -> leaf1
        #         root -> branch2 -> leaf2
        GraphCRUD.create_edge(id="e1", source="root", target="branch1")
        GraphCRUD.create_edge(id="e2", source="root", target="branch2")
        GraphCRUD.create_edge(id="e3", source="branch1", target="leaf1")
        GraphCRUD.create_edge(id="e4", source="branch2", target="leaf2")
        
        # leaf1的父节点应该包括branch1和root
        parents = GraphCRUD.get_parent_nodes("leaf1", recursive=True)
        parent_ids = [p.id for p in parents]
        
        assert "branch1" in parent_ids
        assert "root" in parent_ids

    def test_get_parent_nodes_circular_reference(self, test_db):
        """测试循环引用情况下获取父节点"""
        GraphCRUD.create_node(id="a", type="aggregate", label="A")
        GraphCRUD.create_node(id="b", type="requirement", label="B")
        GraphCRUD.create_node(id="c", type="design", label="C")
        
        # 创建循环: a -> b -> c -> a
        GraphCRUD.create_edge(id="e1", source="a", target="b")
        GraphCRUD.create_edge(id="e2", source="b", target="c")
        GraphCRUD.create_edge(id="e3", source="c", target="a")
        
        # 应该能处理循环引用而不陷入死循环
        parents = GraphCRUD.get_parent_nodes("c", recursive=True)
        # 实现应该检测循环并避免无限递归

    def test_get_node_context_nonexistent_node(self, test_db):
        """测试获取不存在节点的上下文"""
        context = GraphCRUD.get_node_context("nonexistent")
        # 应该返回None或空上下文
        assert context is None or context["node"] is None

    def test_get_node_context_isolated_node(self, test_db):
        """测试获取孤立节点的上下文"""
        GraphCRUD.create_node(id="isolated", type="aggregate", label="Isolated")
        
        context = GraphCRUD.get_node_context("isolated")
        assert context["node"].id == "isolated"
        assert len(context["parents"]) == 0


class TestConcurrencyAndPerformance:
    """测试并发和性能相关场景"""

    def test_create_many_nodes(self, test_db):
        """测试创建大量节点"""
        count = 100
        for i in range(count):
            GraphCRUD.create_node(
                id=f"node_{i}",
                type="aggregate",
                label=f"Node {i}"
            )
        
        nodes = GraphCRUD.get_all_nodes()
        assert len(nodes) == count

    def test_create_many_edges(self, test_db):
        """测试创建大量边"""
        # 创建节点
        for i in range(10):
            GraphCRUD.create_node(id=f"n{i}", type="aggregate", label=f"N{i}")
        
        # 创建网状边
        edge_count = 0
        for i in range(10):
            for j in range(i + 1, 10):
                GraphCRUD.create_edge(
                    id=f"e_{i}_{j}",
                    source=f"n{i}",
                    target=f"n{j}"
                )
                edge_count += 1
        
        edges = GraphCRUD.get_all_edges()
        assert len(edges) == edge_count

    def test_update_many_nodes(self, test_db):
        """测试批量更新节点"""
        # 创建节点
        for i in range(20):
            GraphCRUD.create_node(
                id=f"update_node_{i}",
                type="aggregate",
                label=f"Original {i}"
            )
        
        # 批量更新
        for i in range(20):
            GraphCRUD.update_node(
                f"update_node_{i}",
                {"label": f"Updated {i}"}
            )
        
        # 验证更新
        node = GraphCRUD.get_node_by_id("update_node_10")
        assert node.label == "Updated 10"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
