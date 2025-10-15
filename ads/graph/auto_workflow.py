"""
自动工作流引擎 - 实现节点定稿后的自动流转和AI生成

本模块实现了基于规则的工作流自动化系统，核心功能包括：

核心概念：
1. **工作流模板**：预定义的节点序列，如 DDD开发流程、Bugfix流程
2. **自动流转**：节点定稿后自动创建下游节点
3. **AI自动生成**：基于上游节点内容，AI生成下游节点的初始内容

工作流流转算法：
    ┌──────────────┐
    │ 节点定稿完成  │
    └───────┬──────┘
            │
            ▼
    ┌──────────────────────┐
    │ 查询流转规则          │ ← 从 NodeTypeConfig.FLOW_RULES 读取
    │ (基于节点类型)        │
    └───────┬──────────────┘
            │
      ┌─────┴──────┐
      │            │
      ▼            ▼
    无规则      有规则
      │            │
      │            ▼
      │    ┌────────────────┐
      │    │ 检查下游节点    │
      │    │ 是否已存在？    │
      │    └───────┬────────┘
      │            │
      │      ┌─────┴─────┐
      │      │           │
      │      ▼           ▼
      │    已存在       不存在
      │      │           │
      │      │           ▼
      │      │    ┌──────────────┐
      │      │    │ 创建新节点    │
      │      │    │ 生成标签+位置 │
      │      │    │ 创建连接边    │
      │      │    └──────┬───────┘
      │      │           │
      │      ▼           ▼
      │    激活    ┌──────────────┐
      │    状态    │ 触发AI生成？  │
      │      │     └──────┬───────┘
      │      │            │
      │      │      ┌─────┴─────┐
      │      │      │           │
      │      │      ▼           ▼
      │      │    需要        不需要
      │      │      │           │
      │      │      ▼           │
      │      │  ┌────────────┐  │
      │      │  │ 构建提示词  │  │
      │      │  │ (基于父节点)│  │
      │      │  └─────┬──────┘  │
      │      │        │         │
      │      └────────┴─────────┘
      │                 │
      └─────────────────┘
                 │
                 ▼
          ┌──────────────┐
          │ 返回流转结果  │
          └──────────────┘

AI提示词构建策略：
    - 递归获取父节点内容（requirement, design, implementation等）
    - 使用模板字符串（ai_prompt_template）填充上下文
    - 确保使用定稿内容（content字段）而非草稿（draft_content）
    - 缺失的上下文使用"无"作为占位符

技术设计：
    - 配置驱动：所有流转规则在 FLOW_RULES 字典中定义
    - 幂等性：重复触发流转不会创建重复节点
    - 位置计算：新节点自动排列在父节点右侧（水平间距350px）
    - 边类型：使用 'next' 表示工作流顺序边
    - 异步AI：提示词返回给调用方，由调用方异步执行AI生成

支持的工作流：
    - DDD_STANDARD: Aggregate → Requirement → Design → Implementation → Test → Code Review → Documentation
    - BUGFIX: Bug Report → Bug Analysis → Bug Fix → Bug Verify
"""
from typing import Optional, Dict, Any, List
from enum import Enum
import uuid
from datetime import datetime

from .crud import GraphCRUD
from .models import Node, Edge
from ..storage.database import get_db
from sqlalchemy.orm import Session


class WorkflowTemplate(str, Enum):
    """工作流模板"""
    DDD_STANDARD = "DDD_STANDARD"  # Aggregate → Req → Design → Impl → Test
    BUGFIX = "BUGFIX"  # BugReport → Analysis → Fix → Verify


class NodeTypeConfig:
    """节点类型配置 - 定义自动流转规则"""
    
    FLOW_RULES = {
        # DDD标准流程
        "aggregate": {
            "next_type": "requirement",
            "label_template": "{parent_label}-需求",
            "next_label_template": "{parent_label} - 需求分析",
            "auto_generate": False,  # aggregate不自动生成
            "ai_prompt_template": ""
        },
        "requirement": {
            "next_type": "design",
            "label_template": "{parent_label}-设计",
            "next_label_template": "{parent_label} - 设计方案",
            "auto_generate": True,
            "ai_prompt_template": """请基于以下需求分析，生成详细的设计方案：

需求内容：
{parent_content}

请包含：
1. 技术架构设计
2. 核心模块划分
3. 接口设计
4. 数据模型设计
5. 关键流程设计"""
        },
        "design": {
            "next_type": "implementation",
            "label_template": "{parent_label}-实现",
            "next_label_template": "{parent_label} - 实现方案",
            "auto_generate": True,
            "ai_prompt_template": """请基于以下设计方案，生成详细的实现方案：

需求：
{requirement_content}

设计方案：
{parent_content}

请包含：
1. 技术栈选型
2. 目录结构
3. 核心代码实现要点
4. 关键类和方法说明
5. 实现步骤"""
        },
        "implementation": {
            "next_type": "test",
            "label_template": "{parent_label}-测试",
            "next_label_template": "{parent_label} - 测试方案",
            "auto_generate": True,
            "ai_prompt_template": """请基于以下实现方案，生成测试方案：

需求：
{requirement_content}

设计：
{design_content}

实现方案：
{parent_content}

请包含：
1. 单元测试计划
2. 集成测试计划
3. 测试用例列表
4. 测试数据准备
5. 验收标准"""
        },
        "test": {
            "next_type": None,  # 流程在测试阶段结束
            "label_template": None,
            "next_label_template": None,
            "auto_generate": False,
            "ai_prompt_template": ""
        },
        "integration_test": {
            "next_type": "code_review",
            "label_template": "{parent_label}-代码评审",
            "next_label_template": "{parent_label} - 代码评审",
            "auto_generate": True,
            "ai_prompt_template": """请基于以下测试结果，生成代码评审报告：

实现方案：
{implementation_content}

测试结果：
{parent_content}

请包含：
1. 代码质量评估
2. 架构合理性
3. 安全性检查
4. 性能优化建议
5. 改进建议"""
        },
        "code_review": {
            "next_type": "documentation",
            "label_template": "{parent_label}-文档",
            "next_label_template": "{parent_label} - 文档",
            "auto_generate": True,
            "ai_prompt_template": """请基于以下内容，生成技术文档：

需求：
{requirement_content}

设计：
{design_content}

实现：
{implementation_content}

评审意见：
{parent_content}

请包含：
1. 功能说明
2. API文档
3. 使用指南
4. 部署说明
5. 常见问题"""
        },
        "documentation": {
            "next_type": None,  # 流程结束
            "next_label_template": None,
            "label_template": None,
            "auto_generate": False,
            "ai_prompt_template": ""
        },
        
        # Bugfix流程
        "bug_report": {
            "next_type": "bug_analysis",
            "label_template": "{parent_label}-分析",
            "next_label_template": "{parent_label} - 问题分析",
            "auto_generate": True,
            "ai_prompt_template": """请分析以下Bug报告：

Bug描述：
{parent_content}

请提供：
1. 问题根因分析
2. 影响范围评估
3. 可能的解决方案
4. 风险评估"""
        },
        "bug_analysis": {
            "next_type": "bug_fix",
            "label_template": "{parent_label}-修复",
            "next_label_template": "{parent_label} - 修复方案",
            "auto_generate": True,
            "ai_prompt_template": """请基于以下问题分析，提供修复方案：

Bug报告：
{bug_report_content}

问题分析：
{parent_content}

请提供：
1. 具体修复步骤
2. 代码修改点
3. 配置调整
4. 数据迁移方案（如需要）"""
        },
        "bug_fix": {
            "next_type": "bug_verify",
            "label_template": "{parent_label}-验证",
            "next_label_template": "{parent_label} - 验证方案",
            "auto_generate": True,
            "ai_prompt_template": """请为以下修复方案提供验证计划：

修复方案：
{parent_content}

请提供：
1. 验证步骤
2. 回归测试计划
3. 验收标准
4. 回滚预案"""
        },
        "bug_verify": {
            "next_type": None,  # Bugfix流程结束
            "next_label_template": None,
            "label_template": None,
            "auto_generate": False,
            "ai_prompt_template": ""
        }
    }
    
    @classmethod
    def get_next_config(cls, node_type: str) -> Optional[Dict[str, Any]]:
        """获取下一步配置"""
        return cls.FLOW_RULES.get(node_type)


class AutoWorkflowEngine:
    """自动工作流引擎"""

    def __init__(self, session: Optional[Session] = None):
        self.session: Optional[Session] = session

    @classmethod
    def run(
        cls,
        node_id: str,
        enable_ai: bool = True,
        session: Optional[Session] = None,
    ) -> Optional[Dict[str, Any]]:
        """向后兼容的快捷入口。"""

        return cls(session).on_node_finalized(node_id, enable_ai)

    def on_node_finalized(
        self,
        node_id: str,
        enable_ai: bool = True,
    ) -> Optional[Dict[str, Any]]:
        """
        节点定稿后的自动流转处理 - 工作流引擎的核心入口

        当用户完成节点定稿（finalize）后，此方法被自动调用，执行以下流程：
        1. 查询节点类型对应的流转规则
        2. 检查是否需要创建下游节点
        3. 创建/激活下游节点
        4. 构建AI生成提示词（如果配置启用）

        执行逻辑决策树：
        ```
        节点定稿
           │
           ├─→ 无流转规则？ → 返回 workflow_completed
           │
           ├─→ 有流转规则
           │   │
           │   ├─→ 下游节点已存在？
           │   │   └─→ 激活现有节点 (action: "activated_existing")
           │   │
           │   └─→ 下游节点不存在？
           │       └─→ 创建新节点 + 创建边 (action: "created_new")
           │
           ├─→ enable_ai=True && auto_generate=True？
           │   │
           │   ├─→ 父节点有内容？
           │   │   └─→ 构建AI提示词 (ai_generation.enabled=True)
           │   │
           │   └─→ 父节点无内容？
           │       └─→ 跳过AI生成 (reason: "parent_node_empty")
           │
           └─→ 返回流转结果
        ```

        Args:
            node_id (str): 已定稿的节点ID，必须是有效的节点
            enable_ai (bool): 是否启用AI自动生成，默认 True
                - True: 如果配置支持，会返回AI提示词供调用方执行
                - False: 只创建下游节点，不触发AI生成

        Returns:
            Optional[Dict[str, Any]]: 流转结果字典，包含以下字段：

            当工作流结束时：
            {
                "workflow_completed": True,
                "message": "工作流已完成，节点 XXX 是最后一个节点"
            }

            当激活现有节点时：
            {
                "action": "activated_existing",
                "node_id": "req_456",
                "node_label": "用户管理 - 需求分析",
                "message": "已激活现有节点: 用户管理 - 需求分析",
                "ai_generation": {
                    "enabled": True,
                    "prompt": "请基于以下内容...",
                    "node_id": "req_456",
                    "message": "AI生成已触发（需要调用方异步执行）"
                }
            }

            当创建新节点时：
            {
                "action": "created_new",
                "node_id": "design_789",
                "node_label": "用户管理 - 设计方案",
                "message": "已创建新节点: 用户管理 - 设计方案",
                "ai_generation": {
                    "enabled": True,
                    "prompt": "请基于以下需求分析...",
                    "node_id": "design_789"
                }
            }

            当AI生成跳过时（父节点无内容）：
            {
                "action": "created_new",
                "node_id": "test_101",
                "node_label": "用户管理 - 测试方案",
                "message": "已创建新节点: 用户管理 - 测试方案",
                "ai_generation": {
                    "enabled": False,
                    "reason": "parent_node_empty",
                    "message": "父节点无内容，跳过AI生成"
                }
            }

        Example Usage:
            engine = AutoWorkflowEngine()
            workflow_result = engine.on_node_finalized(
                node_id="agg_123",
                enable_ai=True,
            )

            # 检查是否需要触发AI生成
            if workflow_result and workflow_result.get("ai_generation", {}).get("enabled"):
                ai_info = workflow_result["ai_generation"]
                # 在后台线程异步执行AI生成
                start_async_ai_generation(ai_info["node_id"], ai_info["prompt"])

        Technical Notes:
            - 幂等性保证：同一节点多次定稿不会创建重复的下游节点
            - 状态管理：激活现有节点时会更新 metadata.status 为 "in_progress"
            - 节点创建：新节点位置自动计算为父节点右侧 350px
            - 边的创建：默认从父节点右边连到子节点左边（source_handle="right", target_handle="left"）
            - 提示词构建：递归获取祖先节点内容（requirement, design, implementation等）
            - 内容验证：只有定稿内容（node.content）非空时才触发AI生成
        """
        node = GraphCRUD.get_node_by_id(node_id, session=self.session)
        if not node:
            return None

        # 获取流转规则
        flow_config = NodeTypeConfig.get_next_config(node.type)
        if not flow_config or not flow_config.get("next_type"):
            return None

        # 检查下一个节点是否已存在
        next_node = self._find_next_node(node_id, flow_config["next_type"])

        if next_node:
            return None

        # 创建新节点
        next_node = self._create_next_node(node, flow_config)

        result: Dict[str, Any] = {
            "id": next_node.id,
            "node_id": next_node.id,
            "type": next_node.type,
            "label": next_node.label,
            "node_label": next_node.label,
        }

        if enable_ai and flow_config.get("auto_generate"):
            has_content = node.content and node.content.strip()
            if not has_content:
                result["ai_prompt"] = None
                result["ai_generation"] = {
                    "enabled": False,
                    "reason": "parent_node_empty",
                    "message": "父节点无内容，跳过AI生成"
                }
            else:
                try:
                    prompt = self._build_ai_prompt(node, flow_config)
                    result["ai_prompt"] = prompt
                    result["ai_generation"] = {
                        "enabled": True,
                        "prompt": prompt,
                        "node_id": next_node.id,
                        "message": "AI生成已触发（需要调用方异步执行）"
                    }
                except Exception as exc:
                    result["ai_prompt"] = None
                    result["ai_error"] = str(exc)
                    result["ai_generation"] = {
                        "enabled": False,
                        "reason": "generation_error",
                        "error": str(exc)
                    }

        return result
    
    def _find_next_node(self, parent_id: str, next_type: str) -> Optional[Node]:
        """查找是否已存在下一个节点"""

        session = self.session
        if session is not None:
            edges = session.query(Edge).filter(Edge.source == parent_id).all()
        else:
            edges = GraphCRUD.get_edges_from_node(parent_id)

        for edge in edges:
            if edge.target == parent_id:
                continue

            candidate = GraphCRUD.get_node_by_id(edge.target, session=self.session)
            if candidate and candidate.type == next_type:
                return candidate

        return None

    def _create_next_node(self, parent_node: Node, flow_config: Dict[str, Any]) -> Node:
        """创建下一个节点"""
        # 生成label（去除父节点标签中的阶段后缀）
        parent_label_clean = parent_node.label
        for suffix in [" - 需求分析", " - 设计方案", " - 实现方案", " - 测试方案", 
                       " - 问题分析", " - 修复方案", " - 验证方案"]:
            parent_label_clean = parent_label_clean.replace(suffix, "")

        label_template = flow_config.get("label_template") or flow_config.get("next_label_template")
        if label_template:
            next_label = label_template.format(parent_label=parent_label_clean)
        else:
            next_label = parent_label_clean
        
        # 生成位置（在父节点右侧350px，水平排列）
        parent_pos = parent_node.position or {"x": 100, "y": 100}
        next_position = {
            "x": parent_pos.get("x", 100) + 350,
            "y": parent_pos.get("y", 100)
        }
        
        # 创建节点
        next_node_id = f"node_{uuid.uuid4().hex[:12]}"
        next_node = GraphCRUD.create_node(
            id=next_node_id,
            type=flow_config["next_type"],
            label=next_label,
            content="",  # 等待AI生成
            metadata={
                "status": "in_progress",
                "auto_created": True,
                "parent_node_id": parent_node.id,
                "created_at": datetime.now().isoformat()
            },
            position=next_position,
            is_draft=True,
            session=self.session
        )
        
        # 创建连接边（默认从右边连到左边）
        edge_id = f"edge_{uuid.uuid4().hex[:8]}"
        GraphCRUD.create_edge(
            id=edge_id,
            source=parent_node.id,
            target=next_node.id,
            source_handle="right",
            target_handle="left",
            label="自动流转",
            edge_type="references",
            session=self.session
        )
        
        return next_node
    
    def _build_ai_prompt(self, parent_node: Node, flow_config: Dict[str, Any]) -> str:
        """构建AI生成提示词"""
        if isinstance(flow_config, str):
            flow_config = NodeTypeConfig.get_next_config(flow_config) or {}

        prompt_template = flow_config.get("ai_prompt_template", "")
        if not prompt_template:
            return ""

        # 重要：使用定稿版本的 content，而非 draft_content
        # 前提条件：此函数调用前已验证 parent_node.content 非空
        context = {
            "parent_content": parent_node.content
        }

        # 递归获取祖先节点的定稿内容
        aggregate_content = None
        ancestors = GraphCRUD.get_parent_nodes(parent_node.id, recursive=True, session=self.session)
        for ancestor in ancestors:
            if ancestor.type == "requirement":
                context["requirement_content"] = ancestor.content or "无"
            elif ancestor.type == "design":
                context["design_content"] = ancestor.content or "无"
            elif ancestor.type == "bug_report":
                context["bug_report_content"] = ancestor.content or "无"
            elif ancestor.type == "aggregate":
                aggregate_content = ancestor.content or "无"

        if "requirement_content" not in context and aggregate_content:
            context["requirement_content"] = aggregate_content

        # 填充模板（缺失的上下文使用"无"）
        try:
            prompt = prompt_template.format(**context)
        except KeyError:
            # 缺少某些上下文，使用默认值
            prompt = prompt_template.format(
                parent_content=context["parent_content"],
                requirement_content=context.get("requirement_content", "无"),
                design_content=context.get("design_content", "无"),
                bug_report_content=context.get("bug_report_content", "无")
            )

        # 自动注入项目规则
        rules_context = AutoWorkflowEngine._get_project_rules()
        if rules_context:
            prompt = f"""{prompt}

## 项目规则和约束

请确保生成的内容遵循以下项目规则：

{rules_context}
"""

        return prompt

    @staticmethod
    def _get_project_rules() -> str:
        """获取项目规则（用于AI生成时的约束）"""
        try:
            from ..rules.file_manager import RuleFileManager
            import os

            workspace_path = os.getcwd()
            manager = RuleFileManager(workspace_path)

            # 读取合并后的规则
            rules_content = manager.read_merged_rules()

            if not rules_content:
                return ""

            # 提取关键规则（避免提示词过长）
            # 只保留高优先级规则（Priority >= 200）
            lines = rules_content.split('\n')
            key_rules = []
            current_rule = []
            current_priority = 0

            for line in lines:
                if line.startswith('###'):  # 规则标题
                    if current_rule and current_priority >= 200:
                        key_rules.extend(current_rule)
                    current_rule = [line]
                    current_priority = 0
                elif line.startswith('**Priority**:'):
                    try:
                        priority_str = line.split(':')[1].strip()
                        current_priority = int(priority_str)
                        current_rule.append(line)
                    except:
                        pass
                elif current_rule:
                    current_rule.append(line)

            # 添加最后一个规则
            if current_rule and current_priority >= 200:
                key_rules.extend(current_rule)

            return '\n'.join(key_rules) if key_rules else ""

        except Exception as e:
            # 如果读取失败，不影响主流程
            return ""
    
    @staticmethod
    def create_workflow_from_template(
        template: WorkflowTemplate,
        root_label: str,
        root_content: str = "",
        position: Dict[str, float] = None
    ) -> Dict[str, Any]:
        """
        从模板创建完整工作流
        
        Args:
            template: 工作流模板类型
            root_label: 根节点标签
            root_content: 根节点内容
            position: 起始位置
            
        Returns:
            创建的节点信息
        """
        if position is None:
            position = {"x": 100, "y": 100}
        
        if template == WorkflowTemplate.DDD_STANDARD:
            return AutoWorkflowEngine._create_ddd_workflow(root_label, root_content, position)
        elif template == WorkflowTemplate.BUGFIX:
            return AutoWorkflowEngine._create_bugfix_workflow(root_label, root_content, position)
        else:
            raise ValueError(f"Unknown template: {template}")
    
    @staticmethod
    def create_workflow_from_config(
        nodes: List,  # List[WorkflowNodeConfig]
        root_label: str,
        root_content: str = "",
        position: Dict[str, float] = None
    ) -> Dict[str, Any]:
        """
        根据节点配置列表创建工作流
        
        Args:
            nodes: 节点配置列表（WorkflowNodeConfig）
            root_label: 工作流名称
            root_content: 根节点内容
            position: 起始位置
            
        Returns:
            包含所有创建的节点和边的字典
        """
        if position is None:
            position = {"x": 100, "y": 100}
        
        if not nodes:
            raise ValueError("节点列表不能为空")
        
        created_nodes = []
        created_edges = []
        
        x_offset = 250  # 水平间距
        current_x = position["x"]
        current_y = position["y"]
        
        prev_node = None
        
        for i, node_config in enumerate(nodes):
            # 生成节点ID和标签
            from .workflow_config import generate_node_id
            node_id = generate_node_id(node_config.node_type)
            node_label = f"{root_label} - {node_config.label_suffix}"
            
            # 创建节点
            node = GraphCRUD.create_node(
                id=node_id,
                type=node_config.node_type,
                label=node_label,
                content=root_content if i == 0 else "",
                metadata={
                    "workflow": root_label,
                    "step": i + 1,
                    "required": node_config.required
                },
                position={"x": current_x, "y": current_y}
            )
            created_nodes.append(node)
            
            # 创建连线（连接到前一个节点）
            if prev_node:
                edge_id = f"edge_{prev_node.id}_{node.id}"
                edge = GraphCRUD.create_edge(
                    id=edge_id,
                    source=prev_node.id,
                    target=node.id,
                    label="下一步",
                    edge_type="next",
                    source_handle="right",
                    target_handle="left"
                )
                created_edges.append(edge)
            
            prev_node = node
            current_x += x_offset
        
        from .schemas import NodeResponse, EdgeResponse
        return {
            "nodes": [NodeResponse.from_orm_model(n) for n in created_nodes],
            "edges": [EdgeResponse.from_orm_model(e) for e in created_edges]
        }
    
    @staticmethod
    def _create_ddd_workflow(label: str, content: str, position: Dict[str, float]) -> Dict[str, Any]:
        """创建DDD标准工作流"""
        # 创建Aggregate根节点
        aggregate_id = f"node_{uuid.uuid4().hex[:12]}"
        aggregate = GraphCRUD.create_node(
            id=aggregate_id,
            type="aggregate",
            label=label,
            content=content,
            metadata={"workflow_template": "DDD_STANDARD", "status": "in_progress"},
            position=position
        )
        
        # 创建需求节点（水平偏移）
        req_id = f"node_{uuid.uuid4().hex[:12]}"
        requirement = GraphCRUD.create_node(
            id=req_id,
            type="requirement",
            label=f"{label} - 需求分析",
            content="",
            metadata={"status": "draft", "parent_node_id": aggregate_id},
            position={"x": position["x"] + 350, "y": position["y"]}
        )
        
        # 连接（默认从右边连到左边）- 使用 next 表示工作流顺序
        GraphCRUD.create_edge(
            id=f"edge_{uuid.uuid4().hex[:8]}",
            source=aggregate_id,
            target=req_id,
            source_handle="right",
            target_handle="left",
            label="下一步",
            edge_type="next"
        )
        
        return {
            "template": "DDD_STANDARD",
            "root_node": {"id": aggregate_id, "label": label},
            "nodes_created": 2,
            "message": "DDD工作流已创建，请在需求节点定稿后自动流转"
        }
    
    @staticmethod
    def _create_bugfix_workflow(label: str, content: str, position: Dict[str, float]) -> Dict[str, Any]:
        """创建Bugfix工作流"""
        bug_report_id = f"node_{uuid.uuid4().hex[:12]}"
        bug_report = GraphCRUD.create_node(
            id=bug_report_id,
            type="bug_report",
            label=label,
            content=content,
            metadata={"workflow_template": "BUGFIX", "status": "reported"},
            position=position
        )
        
        return {
            "template": "BUGFIX",
            "root_node": {"id": bug_report_id, "label": label},
            "nodes_created": 1,
            "message": "Bugfix工作流已创建，请在问题描述完善后定稿以触发自动分析"
        }
