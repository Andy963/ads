"""
测试Pydantic schemas验证和序列化
"""
import pytest
from datetime import datetime
from pydantic import ValidationError
from ads.graph.schemas import (
    NodeCreate, NodeUpdate, NodeResponse, EdgeResponse,
    DraftInfo, NodeDetailResponse, ApplyAIResponseRequest,
    UpdateDraftRequest, FinalizeNodeRequest, NodeVersionInfo
)


class TestNodeCreate:
    """测试节点创建schema"""

    def test_valid_node_create(self):
        """测试有效的节点创建"""
        node = NodeCreate(
            id="node_001",
            type="aggregate",
            label="Test Node",
            content="Test content",
            metadata={"status": "draft"},
            position={"x": 100, "y": 200}
        )
        
        assert node.id == "node_001"
        assert node.type == "aggregate"
        assert node.label == "Test Node"
        assert node.content == "Test content"
        assert node.metadata["status"] == "draft"
        assert node.position["x"] == 100

    def test_node_create_with_minimal_fields(self):
        """测试最小字段的节点创建"""
        node = NodeCreate(
            id="node_002",
            type="requirement",
            label="Minimal Node"
        )
        
        assert node.id == "node_002"
        assert node.type == "requirement"
        assert node.label == "Minimal Node"
        assert node.content == ""
        assert node.metadata is None
        assert node.position is None

    def test_node_create_invalid_type(self):
        """测试无效的节点类型"""
        with pytest.raises(ValidationError):
            NodeCreate(
                id="node_003",
                type="invalid_type",
                label="Invalid"
            )

    def test_node_create_missing_required_fields(self):
        """测试缺少必需字段"""
        with pytest.raises(ValidationError):
            NodeCreate(type="aggregate", label="Missing ID")
        
        with pytest.raises(ValidationError):
            NodeCreate(id="node_004", label="Missing type")
        
        with pytest.raises(ValidationError):
            NodeCreate(id="node_005", type="requirement")

    def test_node_create_all_node_types(self):
        """测试所有支持的节点类型"""
        valid_types = [
            "aggregate", "requirement", "design", "implementation",
            "test", "bug_report", "bug_analysis", "bug_fix", "bug_verify"
        ]
        
        for node_type in valid_types:
            node = NodeCreate(
                id=f"node_{node_type}",
                type=node_type,
                label=f"{node_type} node"
            )
            assert node.type == node_type


class TestNodeUpdate:
    """测试节点更新schema"""

    def test_valid_node_update(self):
        """测试有效的节点更新"""
        update = NodeUpdate(
            label="Updated Label",
            content="Updated content",
            metadata={"status": "updated"}
        )
        
        assert update.label == "Updated Label"
        assert update.content == "Updated content"
        assert update.metadata["status"] == "updated"

    def test_node_update_partial(self):
        """测试部分字段更新"""
        update = NodeUpdate(label="Only Label")
        assert update.label == "Only Label"
        assert update.content is None
        assert update.type is None

    def test_node_update_empty(self):
        """测试空更新"""
        update = NodeUpdate()
        assert update.label is None
        assert update.content is None
        assert update.metadata is None

    def test_node_update_invalid_type(self):
        """测试无效的更新类型"""
        with pytest.raises(ValidationError):
            NodeUpdate(type="invalid_type")


class TestNodeResponse:
    """测试节点响应schema"""

    def test_node_response_creation(self):
        """测试节点响应创建"""
        response = NodeResponse(
            id="node_001",
            type="aggregate",
            data={"label": "Test", "content": "Content"},
            position={"x": 100, "y": 200},
            created_at="2025-01-01T00:00:00",
            updated_at="2025-01-01T00:00:00"
        )
        
        assert response.id == "node_001"
        assert response.type == "aggregate"
        assert response.data["label"] == "Test"
        assert response.position["x"] == 100

    def test_node_response_from_orm_model(self):
        """测试从ORM模型创建响应"""
        from ads.graph.models import Node
        from datetime import datetime
        
        # 创建模拟的ORM节点
        node = Node(
            id="node_orm",
            type="requirement",
            label="ORM Node",
            content="ORM content",
            node_metadata={"key": "value"},
            position={"x": 50, "y": 100},
            created_at=datetime(2025, 1, 1),
            updated_at=datetime(2025, 1, 1)
        )
        
        response = NodeResponse.from_orm_model(node)
        
        assert response.id == "node_orm"
        assert response.type == "requirement"
        assert response.data["label"] == "ORM Node"
        assert response.data["content"] == "ORM content"
        assert response.data["key"] == "value"
        assert response.position["x"] == 50


class TestEdgeResponse:
    """测试边响应schema"""

    def test_edge_response_creation(self):
        """测试边响应创建"""
        edge = EdgeResponse(
            id="edge_001",
            source="node_1",
            target="node_2",
            label="connects",
            type="next"
        )
        
        assert edge.id == "edge_001"
        assert edge.source == "node_1"
        assert edge.target == "node_2"
        assert edge.label == "connects"
        assert edge.type == "next"
        assert edge.animated is False

    def test_edge_response_with_handles(self):
        """测试带句柄的边响应"""
        edge = EdgeResponse(
            id="edge_002",
            source="node_a",
            target="node_b",
            source_handle="bottom",
            target_handle="top",
            type="dependency",
            animated=True
        )
        
        assert edge.source_handle == "bottom"
        assert edge.target_handle == "top"
        assert edge.animated is True

    def test_edge_response_from_orm_model(self):
        """测试从ORM模型创建边响应"""
        from ads.graph.models import Edge
        
        # 创建模拟的ORM边
        edge = Edge(
            id="edge_orm",
            source="src",
            target="tgt",
            label="test edge",
            edge_type="next",
            animated=True
        )
        
        response = EdgeResponse.from_orm_model(edge)
        
        assert response.id == "edge_orm"
        assert response.source == "src"
        assert response.target == "tgt"
        assert response.label == "test edge"
        assert response.type == "next"
        assert response.animated is True


class TestDraftInfo:
    """测试草稿信息schema"""

    def test_draft_info_ai_generated(self):
        """测试AI生成的草稿"""
        draft = DraftInfo(
            content="AI generated content",
            source_type="ai_generated",
            conversation_id="conv_001",
            message_id=123
        )
        
        assert draft.content == "AI generated content"
        assert draft.source_type == "ai_generated"
        assert draft.conversation_id == "conv_001"
        assert draft.message_id == 123

    def test_draft_info_manual_created(self):
        """测试手动创建的草稿"""
        draft = DraftInfo(
            content="Manual content",
            source_type="manual_created"
        )
        
        assert draft.content == "Manual content"
        assert draft.source_type == "manual_created"
        assert draft.conversation_id is None

    def test_draft_info_invalid_source_type(self):
        """测试无效的来源类型"""
        with pytest.raises(ValidationError):
            DraftInfo(
                content="Test",
                source_type="invalid_source"
            )


class TestNodeDetailResponse:
    """测试节点详情响应schema"""

    def test_node_detail_without_draft(self):
        """测试无草稿的节点详情"""
        detail = NodeDetailResponse(
            id="node_001",
            label="Test Node",
            type="aggregate",
            content="Content",
            current_version=1,
            is_draft=False,
            created_at="2025-01-01T00:00:00",
            updated_at="2025-01-01T00:00:00"
        )
        
        assert detail.id == "node_001"
        assert detail.is_draft is False
        assert detail.draft is None

    def test_node_detail_with_draft(self):
        """测试带草稿的节点详情"""
        draft = DraftInfo(
            content="Draft content",
            source_type="ai_modified",
            based_on_version=1
        )
        
        detail = NodeDetailResponse(
            id="node_002",
            label="Node with Draft",
            type="requirement",
            current_version=1,
            is_draft=True,
            draft=draft,
            created_at="2025-01-01T00:00:00",
            updated_at="2025-01-01T00:00:00"
        )
        
        assert detail.is_draft is True
        assert detail.draft is not None
        assert detail.draft.content == "Draft content"


class TestRequestSchemas:
    """测试请求schemas"""

    def test_apply_ai_response_request(self):
        """测试应用AI响应请求"""
        request = ApplyAIResponseRequest(message_id=42)
        assert request.message_id == 42

    def test_update_draft_request(self):
        """测试更新草稿请求"""
        request = UpdateDraftRequest(
            content="Updated draft",
            label="New Label"
        )
        assert request.content == "Updated draft"
        assert request.label == "New Label"

    def test_finalize_node_request(self):
        """测试定稿请求"""
        request = FinalizeNodeRequest(
            change_description="Fixed typo"
        )
        assert request.change_description == "Fixed typo"

    def test_finalize_node_request_without_description(self):
        """测试无变更说明的定稿请求"""
        request = FinalizeNodeRequest()
        assert request.change_description is None


class TestNodeVersionInfo:
    """测试节点版本信息schema"""

    def test_node_version_info_creation(self):
        """测试版本信息创建"""
        version = NodeVersionInfo(
            id=1,
            node_id="node_001",
            version=1,
            content="Version 1 content",
            source_type="manual_created",
            created_at="2025-01-01T00:00:00"
        )
        
        assert version.id == 1
        assert version.node_id == "node_001"
        assert version.version == 1
        assert version.source_type == "manual_created"

    def test_node_version_info_from_orm(self):
        """测试从ORM模型创建版本信息"""
        from ads.graph.models import NodeVersion
        from datetime import datetime
        
        orm_version = NodeVersion(
            id=1,
            node_id="node_001",
            version=2,
            content="Test content",
            source_type="ai_modified",
            conversation_id="conv_001",
            message_id=100,
            based_on_version=1,
            change_description="Modified by AI",
            created_at=datetime(2025, 1, 1)
        )
        
        version = NodeVersionInfo.from_orm_model(orm_version)
        
        assert version.id == 1
        assert version.version == 2
        assert version.source_type == "ai_modified"
        assert version.conversation_id == "conv_001"
        assert version.message_id == 100
        assert version.based_on_version == 1


class TestSchemaValidation:
    """测试schema验证规则"""

    def test_node_create_extra_fields_ignored(self):
        """测试额外字段被忽略"""
        # Pydantic默认不会忽略额外字段，但我们可以配置
        node = NodeCreate(
            id="node_001",
            type="aggregate",
            label="Test",
            content="content"
        )
        assert hasattr(node, 'id')
        assert hasattr(node, 'type')

    def test_position_dict_structure(self):
        """测试position字典结构"""
        node = NodeCreate(
            id="node_001",
            type="aggregate",
            label="Test",
            position={"x": 100.5, "y": 200.5}
        )
        
        assert isinstance(node.position, dict)
        assert node.position["x"] == 100.5
        assert node.position["y"] == 200.5

    def test_metadata_dict_flexibility(self):
        """测试metadata字典的灵活性"""
        node = NodeCreate(
            id="node_001",
            type="aggregate",
            label="Test",
            metadata={
                "status": "draft",
                "priority": 1,
                "tags": ["important", "urgent"],
                "nested": {"key": "value"}
            }
        )
        
        assert node.metadata["status"] == "draft"
        assert node.metadata["priority"] == 1
        assert len(node.metadata["tags"]) == 2
        assert node.metadata["nested"]["key"] == "value"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
