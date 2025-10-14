"""
工作流上下文管理

类似 git 分支的概念，管理当前活动的工作流。
用户无需记住 node_id，只需要知道工作流步骤名称。
"""

import json
from pathlib import Path
from typing import Optional, Dict, List
from datetime import datetime

from .detector import WorkspaceDetector
from ..graph.crud import GraphCRUD
from ..graph.workflow_config import WorkflowRulesConfig


class WorkflowContext:
    """工作流上下文管理器"""

    CONTEXT_FILE = ".ads/context.json"

    # 步骤名称映射（短名称 -> 节点类型）
    STEP_MAPPINGS = {
        "bugfix": {
            "report": "bug_report",
            "analysis": "bug_analysis",
            "fix": "bug_fix",
            "verify": "bug_verify"
        },
        "standard": {
            "aggregate": "aggregate",
            "requirement": "requirement",
            "design": "design",
            "implementation": "implementation"
        },
        "feature": {
            "requirement": "requirement",
            "implementation": "implementation"
        }
    }

    # 类型关键词映射（关键词 -> 模板类型）
    TYPE_KEYWORDS = {
        # bugfix 相关
        "bug": "bugfix",
        "bugfix": "bugfix",
        "修复": "bugfix",
        
        # standard 相关
        "standard": "standard",
        "标准": "standard",
        "完整": "standard",
        
        # feature 相关
        "feature": "feature",
        "快速": "feature",
        "特性": "feature",
        "功能": "feature",
    }

    @staticmethod
    def _get_context_file(workspace: Optional[Path] = None) -> Path:
        """获取上下文文件路径"""
        if workspace is None:
            workspace = WorkspaceDetector.detect()
        return workspace / WorkflowContext.CONTEXT_FILE

    @staticmethod
    def auto_activate_if_single_workflow(workspace: Optional[Path] = None) -> Optional[Dict]:
        """
        如果只有一个工作流且没有活动工作流，自动激活它。
        
        Returns:
            激活的工作流上下文，如果没有工作流或已有活动工作流则返回None
        """
        # 检查是否已有活动工作流
        active = WorkflowContext.get_active_workflow(workspace)
        if active:
            return None  # 已经有活动工作流，无需自动激活
        
        # 获取所有工作流
        all_workflows = WorkflowContext.list_all_workflows(workspace)
        
        # 如果只有一个工作流，自动激活它
        if len(all_workflows) == 1:
            wf = all_workflows[0]
            result = WorkflowContext.switch_workflow(wf["workflow_id"], workspace)
            if result["success"]:
                return result["workflow"]
        
        return None
    
    @staticmethod
    def get_active_workflow(workspace: Optional[Path] = None) -> Optional[Dict]:
        """
        获取当前活动的工作流。

        Returns:
            {
                "workflow_id": "bug_report_abc123",
                "template": "bugfix",
                "title": "登录页面崩溃",
                "created_at": "2025-01-10T10:00:00",
                "steps": {
                    "report": "bug_report_abc123",
                    "analysis": "bug_analysis_def456",
                    "fix": "bug_fix_ghi789",
                    "verify": "bug_verify_jkl012"
                },
                "current_step": "analysis"  # 最后编辑的步骤
            }
        """
        context_file = WorkflowContext._get_context_file(workspace)
        if not context_file.exists():
            return None

        try:
            with open(context_file, 'r', encoding='utf-8') as f:
                context = json.load(f)
                return context.get("active_workflow")
        except Exception:
            return None

    @staticmethod
    def set_active_workflow(
        workflow_root_id: str,
        template: str,
        title: str,
        steps: Dict[str, str],
        workspace: Optional[Path] = None
    ) -> Dict:
        """
        设置活动工作流。

        Args:
            workflow_root_id: 工作流根节点 ID
            template: 模板类型（bugfix, standard, feature）
            title: 工作流标题
            steps: 步骤映射 {"report": "bug_report_abc123", ...}
            workspace: 工作空间路径

        Returns:
            更新后的工作流上下文
        """
        context_file = WorkflowContext._get_context_file(workspace)
        context_file.parent.mkdir(parents=True, exist_ok=True)

        workflow_context = {
            "workflow_id": workflow_root_id,
            "template": template,
            "title": title,
            "created_at": datetime.now().isoformat(),
            "steps": steps,
            "current_step": list(steps.keys())[0] if steps else None
        }

        # 读取现有上下文
        if context_file.exists():
            try:
                with open(context_file, 'r', encoding='utf-8') as f:
                    context = json.load(f)
            except Exception:
                context = {}
        else:
            context = {}

        # 更新活动工作流
        context["active_workflow"] = workflow_context

        # 保存到文件
        with open(context_file, 'w', encoding='utf-8') as f:
            json.dump(context, f, indent=2, ensure_ascii=False)

        return workflow_context

    @staticmethod
    def get_workflow_step_node_id(
        step_name: str,
        workflow_context: Optional[Dict] = None,
        workspace: Optional[Path] = None
    ) -> Optional[str]:
        """
        通过步骤名称获取节点 ID。

        Args:
            step_name: 步骤名称（如 "report", "analysis"）
            workflow_context: 工作流上下文（可选，会自动获取）
            workspace: 工作空间路径

        Returns:
            节点 ID，如果不存在返回 None
        """
        if workflow_context is None:
            workflow_context = WorkflowContext.get_active_workflow(workspace)

        if not workflow_context:
            return None

        return workflow_context.get("steps", {}).get(step_name)

    @staticmethod
    def update_current_step(
        step_name: str,
        workspace: Optional[Path] = None
    ):
        """
        更新当前步骤（最后编辑的步骤）。

        Args:
            step_name: 步骤名称
            workspace: 工作空间路径
        """
        context_file = WorkflowContext._get_context_file(workspace)
        if not context_file.exists():
            return

        try:
            with open(context_file, 'r', encoding='utf-8') as f:
                context = json.load(f)

            if "active_workflow" in context:
                context["active_workflow"]["current_step"] = step_name

                with open(context_file, 'w', encoding='utf-8') as f:
                    json.dump(context, f, indent=2, ensure_ascii=False)
        except Exception:
            pass

    @staticmethod
    def list_all_workflows(workspace: Optional[Path] = None) -> List[Dict]:
        """
        列出所有工作流（用于切换）。

        Returns:
            [
                {
                    "workflow_id": "bug_report_abc123",
                    "template": "bugfix",
                    "title": "登录页面崩溃",
                    "node_count": 4,
                    "finalized_count": 2,
                    "created_at": "2025-01-10T10:00:00"
                },
                ...
            ]
        """
        # 获取所有节点
        all_nodes = GraphCRUD.get_all_nodes()

        # 按工作流分组（查找根节点）
        workflows = {}

        for node in all_nodes:
            # 查找根节点
            parents = GraphCRUD.get_parent_nodes(node.id, recursive=True)
            if parents:
                root_id = parents[-1].id
            else:
                root_id = node.id

            if root_id not in workflows:
                # 获取根节点信息
                root_node = GraphCRUD.get_node_by_id(root_id)
                if root_node:
                    # 尝试从 metadata 获取 template
                    template = root_node.node_metadata.get("workflow_template", "unknown") if root_node.node_metadata else "unknown"
                    
                    workflows[root_id] = {
                        "workflow_id": root_id,
                        "template": template,
                        "title": root_node.label,
                        "nodes": [],
                        "created_at": root_node.created_at.isoformat() if root_node.created_at else None
                    }

            if root_id in workflows:
                workflows[root_id]["nodes"].append(node)

        # 转换为列表，添加统计信息，并推断模板类型
        result = []
        for root_id, workflow in workflows.items():
            template = workflow["template"]
            
            # 如果 template 是 unknown，尝试根据节点类型推断
            if template == "unknown":
                node_types = set(n.type for n in workflow["nodes"])
                
                # 根据节点类型组合推断工作流类型
                if {"bug_report", "bug_analysis", "bug_fix", "bug_verify"} & node_types:
                    template = "bugfix"
                elif {"aggregate", "requirement", "design", "implementation"} <= node_types:
                    template = "standard"
                elif {"feature"} & node_types:
                    template = "feature"
            
            result.append({
                "workflow_id": workflow["workflow_id"],
                "template": template,
                "title": workflow["title"],
                "node_count": len(workflow["nodes"]),
                "finalized_count": sum(1 for n in workflow["nodes"] if not n.is_draft and (n.current_version or 0) > 0),
                "created_at": workflow["created_at"]
            })

        # 按创建时间倒序排列
        result.sort(key=lambda w: w["created_at"] or "", reverse=True)

        return result

    @staticmethod
    def switch_workflow(
        workflow_identifier: str,
        workspace: Optional[Path] = None
    ) -> Dict:
        """
        切换活动工作流（类似 git checkout）。

        Args:
            workflow_identifier: 工作流 ID、标题或类型关键词（支持模糊匹配）
            workspace: 工作空间路径

        Returns:
            {
                "success": bool,
                "workflow": dict or None,  # 成功切换的工作流
                "matches": list,           # 多个匹配的工作流列表
                "message": str             # 提示信息
            }
        """
        # 列出所有工作流
        all_workflows = WorkflowContext.list_all_workflows(workspace)
        
        if not all_workflows:
            return {
                "success": False,
                "workflow": None,
                "matches": [],
                "message": "没有找到任何工作流"
            }

        matched = None
        matches = []

        # 1. 精确匹配 ID
        for wf in all_workflows:
            if wf["workflow_id"] == workflow_identifier:
                matched = wf
                break

        # 2. 精确匹配标题
        if not matched:
            for wf in all_workflows:
                if wf["title"] == workflow_identifier:
                    matched = wf
                    break

        # 3. 通过类型关键词匹配
        if not matched:
            # 检查是否是类型关键词
            template_type = WorkflowContext.TYPE_KEYWORDS.get(workflow_identifier.lower())
            if template_type:
                # 查找该类型的所有工作流
                matches = [wf for wf in all_workflows if wf["template"] == template_type]
                if len(matches) == 1:
                    matched = matches[0]
                elif len(matches) > 1:
                    return {
                        "success": False,
                        "workflow": None,
                        "matches": matches,
                        "message": f"找到 {len(matches)} 个 '{template_type}' 类型的工作流，请指定具体的工作流"
                    }

        # 4. 模糊匹配标题（包含关系）
        if not matched:
            for wf in all_workflows:
                if workflow_identifier.lower() in wf["title"].lower():
                    matched = wf
                    break

        if not matched:
            return {
                "success": False,
                "workflow": None,
                "matches": [],
                "message": f"未找到匹配 '{workflow_identifier}' 的工作流"
            }

        # 获取工作流的所有节点（使用 list_all_nodes 而不是遍历）
        all_nodes = GraphCRUD.get_all_nodes()
        
        # 找到该工作流的所有节点
        workflow_nodes = []
        for node in all_nodes:
            # 通过父节点链判断是否属于该工作流
            parents = GraphCRUD.get_parent_nodes(node.id, recursive=True)
            if parents:
                root_id = parents[-1].id
            else:
                root_id = node.id
            
            if root_id == matched["workflow_id"]:
                workflow_nodes.append(node)

        # 根据模板类型构建步骤映射
        template = matched["template"]
        step_mapping = WorkflowContext.STEP_MAPPINGS.get(template, {})

        steps = {}
        for step_name, node_type in step_mapping.items():
            # 查找对应类型的节点
            for node in workflow_nodes:
                if node.type == node_type:
                    steps[step_name] = node.id
                    break

        # 设置为活动工作流
        workflow_context = WorkflowContext.set_active_workflow(
            workflow_root_id=matched["workflow_id"],
            template=template,
            title=matched["title"],
            steps=steps,
            workspace=workspace
        )
        
        return {
            "success": True,
            "workflow": workflow_context,
            "matches": [],
            "message": f"已切换到工作流: {matched['title']}"
        }

    @staticmethod
    def get_workflow_status(workspace: Optional[Path] = None) -> Optional[Dict]:
        """
        获取当前工作流状态（类似 git status）。

        Returns:
            {
                "workflow": {...},  # 工作流信息
                "steps": [
                    {
                        "name": "report",
                        "node_id": "bug_report_abc123",
                        "label": "登录页面崩溃 - Bug报告",
                        "status": "finalized",  # draft/finalized
                        "is_current": true
                    },
                    ...
                ]
            }
        """
        workflow = WorkflowContext.get_active_workflow(workspace)
        if not workflow:
            return None

        steps_info = []
        current_step = workflow.get("current_step")

        for step_name, node_id in workflow.get("steps", {}).items():
            node = GraphCRUD.get_node_by_id(node_id)
            if node:
                steps_info.append({
                    "name": step_name,
                    "node_id": node_id,
                    "label": node.label,
                    "status": "draft" if node.is_draft else "finalized",
                    "is_current": step_name == current_step
                })

        return {
            "workflow": workflow,
            "steps": steps_info
        }
