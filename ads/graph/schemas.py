from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List, Literal
from datetime import datetime

class NodeCreate(BaseModel):
    id: str
    type: Literal[
        "aggregate", "requirement", "design", "implementation",
        "test", "bug_report", "bug_analysis", "bug_fix", "bug_verify"
    ]
    label: str
    content: Optional[str] = ""
    metadata: Optional[Dict[str, Any]] = None
    position: Optional[Dict[str, float]] = None

class NodeUpdate(BaseModel):
    type: Optional[Literal[
        "aggregate", "requirement", "design", "implementation",
        "test", "bug_report", "bug_analysis", "bug_fix", "bug_verify"
    ]] = None
    label: Optional[str] = None
    content: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    position: Optional[Dict[str, float]] = None

class NodeResponse(BaseModel):
    id: str
    type: str
    data: Dict[str, Any]
    position: Dict[str, float]
    created_at: str
    updated_at: str

    model_config = {"from_attributes": True}

    @classmethod
    def from_orm_model(cls, node):
        """从ORM模型创建响应"""
        return cls(
            id=node.id,
            type=node.type,
            data={
                "label": node.label,
                "content": node.content,
                **(node.node_metadata or {})
            },
            position=node.position or {"x": 0, "y": 0},
            created_at=node.created_at.isoformat(),
            updated_at=node.updated_at.isoformat()
        )


class EdgeResponse(BaseModel):
    """边响应模型"""
    id: str
    source: str
    target: str
    source_handle: Optional[str] = 'right'
    target_handle: Optional[str] = 'left'
    label: Optional[str] = None
    type: str
    animated: bool = False

    model_config = {"from_attributes": True}

    @classmethod
    def from_orm_model(cls, edge):
        """从ORM模型创建响应"""
        return cls(
            id=edge.id,
            source=edge.source,
            target=edge.target,
            source_handle=edge.source_handle or 'right',
            target_handle=edge.target_handle or 'left',
            label=edge.label,
            type=edge.edge_type,
            animated=edge.animated
        )


# ========== 对话驱动节点编辑 Schemas ==========

class DraftInfo(BaseModel):
    """草稿信息"""
    content: str
    source_type: Literal["ai_generated", "ai_modified", "manual_created", "manual_modified"]
    conversation_id: Optional[str] = None
    message_id: Optional[int] = None
    based_on_version: Optional[int] = None
    ai_original_content: Optional[str] = None
    updated_at: Optional[datetime] = None


class NodeDetailResponse(BaseModel):
    """节点详情响应（包含草稿和版本信息）"""
    id: str
    label: str
    type: str
    content: Optional[str] = None
    current_version: int = 0

    # 草稿信息
    is_draft: bool = False
    draft: Optional[DraftInfo] = None

    created_at: str
    updated_at: str


class ApplyAIResponseRequest(BaseModel):
    """应用AI回复请求"""
    message_id: int = Field(..., description="AI消息ID")


class UpdateDraftRequest(BaseModel):
    """更新草稿请求"""
    content: str = Field(..., description="草稿内容")
    label: Optional[str] = Field(None, description="节点名称")


class FinalizeNodeRequest(BaseModel):
    """定稿请求"""
    change_description: Optional[str] = Field(None, description="变更说明")


class NodeVersionInfo(BaseModel):
    """节点版本信息"""
    id: int
    node_id: str
    version: int
    content: str
    source_type: Literal["ai_generated", "ai_modified", "manual_created", "manual_modified"]
    conversation_id: Optional[str] = None
    message_id: Optional[int] = None
    based_on_version: Optional[int] = None
    change_description: Optional[str] = None
    created_at: Optional[str] = None

    model_config = {"from_attributes": True}

    @classmethod
    def from_orm_model(cls, version):
        """从ORM模型创建响应"""
        return cls(
            id=version.id,
            node_id=version.node_id,
            version=version.version,
            content=version.content,
            source_type=version.source_type,
            conversation_id=version.conversation_id,
            message_id=version.message_id,
            based_on_version=version.based_on_version,
            change_description=version.change_description,
            created_at=version.created_at.isoformat() if version.created_at else None
        )


class VersionListResponse(BaseModel):
    """版本列表响应"""
    versions: List[NodeVersionInfo]
    total: int

    model_config = {"from_attributes": True}


class VersionDiffResponse(BaseModel):
    """版本对比响应"""
    old_version: NodeVersionInfo
    new_version: NodeVersionInfo
    diff: str  # 差异文本（unified diff格式）

    model_config = {"from_attributes": True}


# ========== 工作流 Schemas ==========

class WorkflowCreateResponse(BaseModel):
    """工作流创建响应"""
    requirements: NodeResponse
    design: NodeResponse
    implementation: NodeResponse

