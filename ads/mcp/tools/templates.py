"""
Template management MCP tools
"""

import json
from pathlib import Path
from typing import Optional
import uuid

from ...templates import TemplateLoader, TemplateRenderer
from ...workspace.detector import WorkspaceDetector
from ...graph.crud import GraphCRUD
from ...graph.file_manager import WorkflowFileManager
from ...graph.workflow_config import generate_node_id
from ...graph.edge_types import get_default_edge_type


async def list_templates(workspace_path: Optional[str] = None) -> str:
    """
    列出所有可用的模板。

    Args:
        workspace_path: 工作空间路径（可选）

    Returns:
        JSON 格式的模板列表
    """
    try:
        if not workspace_path:
            workspace_path = str(WorkspaceDetector.detect())

        workspace = Path(workspace_path)
        templates = TemplateLoader.list_workspace_templates(workspace)

        return json.dumps({
            "workspace": str(workspace),
            "templates": templates,
            "node_template_count": len(templates.get("node_templates", [])),
            "workflow_template_count": len(templates.get("workflow_templates", []))
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "error": str(e)
        }, ensure_ascii=False)


async def get_node_template(
    template_name: str,
    workspace_path: Optional[str] = None
) -> str:
    """
    获取节点模板详情。

    Args:
        template_name: 模板名称
        workspace_path: 工作空间路径（可选）

    Returns:
        JSON 格式的模板详情
    """
    try:
        if not workspace_path:
            workspace_path = str(WorkspaceDetector.detect())

        workspace = Path(workspace_path)
        template = TemplateLoader.get_node_template(workspace, template_name)

        if not template:
            return json.dumps({
                "error": f"模板不存在: {template_name}"
            }, ensure_ascii=False)

        return json.dumps({
            "name": template.name,
            "node_type": template.node_type,
            "title_template": template.title_template,
            "content_template": template.content_template,
            "variables": template.variables,
            "metadata": template.metadata,
            "file_path": str(template.file_path)
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "error": str(e)
        }, ensure_ascii=False)


async def get_workflow_template(
    template_name: str,
    workspace_path: Optional[str] = None
) -> str:
    """
    获取工作流模板详情。

    Args:
        template_name: 模板名称
        workspace_path: 工作空间路径（可选）

    Returns:
        JSON 格式的模板详情
    """
    try:
        if not workspace_path:
            workspace_path = str(WorkspaceDetector.detect())

        workspace = Path(workspace_path)
        template = TemplateLoader.get_workflow_template(workspace, template_name)

        if not template:
            return json.dumps({
                "error": f"模板不存在: {template_name}"
            }, ensure_ascii=False)

        return json.dumps({
            "name": template.name,
            "title": template.title,
            "description": template.description,
            "nodes": template.nodes,
            "edges": template.edges,
            "file_path": str(template.file_path)
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "error": str(e)
        }, ensure_ascii=False)


async def render_template(
    template_content: str,
    variables: str,
    workspace_path: Optional[str] = None
) -> str:
    """
    渲染模板（变量替换）。

    Args:
        template_content: 模板内容
        variables: JSON 格式的变量字典
        workspace_path: 工作空间路径（可选）

    Returns:
        渲染后的内容
    """
    try:
        # 解析变量
        try:
            var_dict = json.loads(variables)
        except json.JSONDecodeError as e:
            return json.dumps({
                "error": f"变量格式错误: {str(e)}"
            }, ensure_ascii=False)

        # 渲染
        rendered = TemplateRenderer.render(template_content, var_dict)

        return json.dumps({
            "success": True,
            "rendered_content": rendered
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False)


async def validate_template(
    template_content: str,
    variables: Optional[str] = None,
    workspace_path: Optional[str] = None
) -> str:
    """
    验证模板和变量。

    Args:
        template_content: 模板内容
        variables: JSON 格式的变量字典（可选）
        workspace_path: 工作空间路径（可选）

    Returns:
        验证结果
    """
    try:
        # 解析变量
        var_dict = {}
        if variables:
            try:
                var_dict = json.loads(variables)
            except json.JSONDecodeError:
                var_dict = {}

        # 提取模板变量
        extracted = TemplateRenderer.extract_variables(template_content)

        # 验证
        validation = TemplateRenderer.validate(template_content, var_dict)

        return json.dumps({
            "valid": validation["valid"],
            "errors": validation["errors"],
            "missing_variables": validation["missing_variables"],
            "required_variables": validation["required_variables"],
            "optional_variables": validation.get("optional_variables", []),
            "extracted_variables": extracted
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "valid": False,
            "error": str(e)
        }, ensure_ascii=False)


async def create_node_from_template(
    workspace_path: str,
    template_name: str,
    variables: str,
    parent_id: Optional[str] = None,
    status: str = "draft"
) -> str:
    """
    从模板创建节点。

    Args:
        workspace_path: 工作空间路径
        template_name: 模板名称
        variables: JSON 格式的变量字典
        parent_id: 父节点 ID（可选）
        status: 状态（draft/finalized）

    Returns:
        创建结果
    """
    try:
        workspace = Path(workspace_path)

        # 加载模板
        template = TemplateLoader.get_node_template(workspace, template_name)

        if not template:
            return json.dumps({
                "success": False,
                "error": f"模板不存在: {template_name}"
            }, ensure_ascii=False)

        # 解析变量
        try:
            var_dict = json.loads(variables)
        except json.JSONDecodeError as e:
            return json.dumps({
                "success": False,
                "error": f"变量格式错误: {str(e)}"
            }, ensure_ascii=False)

        # 验证变量
        validation = TemplateRenderer.validate(template.content_template, var_dict)
        if not validation["valid"]:
            return json.dumps({
                "success": False,
                "error": "变量验证失败",
                "validation": validation
            }, ensure_ascii=False)

        # 渲染模板
        title = TemplateRenderer.render(template.title_template, var_dict)
        content = TemplateRenderer.render(template.content_template, var_dict)

        # 生成节点 ID 并创建节点
        node_id = generate_node_id(template.node_type)
        is_draft = status != "finalized"

        node = GraphCRUD.create_node(
            id=node_id,
            type=template.node_type,
            label=title,
            content=content,
            metadata={},
            is_draft=is_draft
        )

        created_edge = None

        # 如果指定父节点，创建连接边
        if parent_id:
            edge_id = f"edge_{uuid.uuid4().hex[:8]}"
            edge = GraphCRUD.create_edge(
                id=edge_id,
                source=parent_id,
                target=node_id,
                edge_type=get_default_edge_type()
            )
            created_edge = {
                "id": edge.id,
                "source": edge.source,
                "target": edge.target,
                "type": edge.edge_type
            }

        # 将节点内容同步到文件系统
        try:
            file_path = WorkflowFileManager.save_node_to_file(node, str(workspace))
            file_saved = str(file_path)
        except Exception as sync_error:
            file_saved = f"文件保存失败: {sync_error}"

        result = {
            "success": True,
            "template": template.name,
            "node": {
                "id": node.id,
                "type": node.type,
                "label": node.label,
                "content": node.content,
                "status": "draft" if node.is_draft else "finalized"
            },
            "file": file_saved
        }

        if created_edge:
            result["edge"] = created_edge

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False)
