from sqlalchemy import Column, String, JSON, Text, Boolean, Integer, DateTime, ForeignKey, Index
from sqlalchemy.sql import func
from ..storage.base import BaseModel


class NodeType:
    """节点类型常量"""
    AGGREGATE = "aggregate"
    REQUIREMENT = "requirement"
    DESIGN = "design"
    IMPLEMENTATION = "implementation"
    TEST = "test"  # 新增
    BUG_REPORT = "bug_report"  # 新增
    BUG_ANALYSIS = "bug_analysis"  # 新增
    BUG_FIX = "bug_fix"  # 新增
    BUG_VERIFY = "bug_verify"  # 新增


class Node(BaseModel):
    """
    节点模型
    
    状态机说明：
    1. 新建节点（草稿）：
       - is_draft=True
       - current_version=0
       - content=None 或空
       - draft_content=有值（用户输入的内容）
    
    2. 已定稿节点（无新草稿）：
       - is_draft=False
       - current_version>=1
       - content=有值（最新定稿版本的内容）
       - draft_content=None
    
    3. 已定稿节点（有新草稿）：
       - is_draft=True
       - current_version>=1
       - content=有值（上一个定稿版本的内容）
       - draft_content=有值（新草稿内容）
    """
    __tablename__ = 'nodes'

    id = Column(String, primary_key=True)
    type = Column(String, nullable=False)
    label = Column(String, nullable=False)
    content = Column(Text)
    node_metadata = Column('metadata', JSON)  # 使用 node_metadata 避免与 SQLAlchemy metadata 冲突
    position = Column(JSON)

    # ========== 版本管理 ==========
    current_version = Column(Integer, default=0)  # 当前定稿版本号（0表示未定稿）

    # ========== 草稿区 ==========
    draft_content = Column(Text, nullable=True)  # 草稿内容
    draft_source_type = Column(String, nullable=True)  # ai_generated, ai_modified, manual_created, manual_modified
    draft_conversation_id = Column(String, nullable=True)  # 对话ID（无外键，chat模块已迁移到server）
    draft_message_id = Column(Integer, nullable=True)  # 消息ID（无外键，chat模块已迁移到server）
    draft_based_on_version = Column(Integer, nullable=True)  # 草稿基于哪个版本
    draft_ai_original_content = Column(Text, nullable=True)  # AI原始生成内容（用于检测人工修改）
    is_draft = Column(Boolean, default=True)  # 是否有草稿（新建节点默认为True）
    draft_updated_at = Column(DateTime, nullable=True)  # 草稿最后更新时间


class NodeVersion(BaseModel):
    """节点版本历史"""
    __tablename__ = "node_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    node_id = Column(String, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False)
    version = Column(Integer, nullable=False)  # 版本号：1, 2, 3...
    content = Column(Text, nullable=False)  # 版本内容快照

    # 来源追踪
    source_type = Column(String, nullable=False)  # ai_generated, ai_modified, manual_created, manual_modified
    conversation_id = Column(String, nullable=True)  # 对话ID（无外键，chat模块已迁移到server）
    message_id = Column(Integer, nullable=True)  # 消息ID（无外键，chat模块已迁移到server）
    based_on_version = Column(Integer, nullable=True)  # 基于哪个版本（修改时）

    # 元信息
    change_description = Column(Text, nullable=True)  # 变更说明

    # 索引
    __table_args__ = (
        Index('ix_node_versions_node_id', 'node_id'),
        Index('ix_node_versions_version', 'node_id', 'version'),
    )


class Edge(BaseModel):
    """边模型"""
    __tablename__ = 'edges'

    id = Column(String, primary_key=True)
    source = Column(String, nullable=False)
    target = Column(String, nullable=False)
    source_handle = Column(String, default='right')  # 源节点的连接点ID
    target_handle = Column(String, default='left')   # 目标节点的连接点ID
    label = Column(String)
    edge_type = Column(String, default='next')
    animated = Column(Boolean, default=False)
