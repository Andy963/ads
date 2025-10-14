"""
System-related MCP tools.
"""

import json
from typing import Dict, Any
from ...graph.edge_types import get_edge_types


async def get_system_info() -> str:
    """
    获取系统信息。
    """
    try:
        from ...graph.workflow_config import WorkflowRulesConfig

        # 获取可用的节点类型
        config = WorkflowRulesConfig()
        node_types = list(config.node_types.keys())

        # 获取可用的工作流模板
        templates = list(config.get_all_workflow_templates().keys())

        result = {
            "name": "AD Assistant",
            "version": "1.0.0",
            "description": "基于知识图谱的领域驱动设计协助开发系统",
            "capabilities": {
                "rules": {
                    "categories": [
                        "architecture",
                        "code",
                        "security",
                        "test",
                        "tech",
                        "business"
                    ],
                    "supports_global_rules": True,
                    "supports_workspace_rules": True
                },
                "workflow": {
                    "node_types": node_types,
                    "templates": templates
                },
                "graph": {
                    "supports_nodes": True,
                    "supports_edges": True,
                    "supports_draft_finalized": True,
                    "edge_types": get_edge_types()  # 动态获取边类型
                }
            },
            "mcp": {
                "protocol_version": "1.0",
                "tools": [
                    "read_rules",
                    "list_rules",
                    "list_workflow_templates",
                    "get_workflow_template",
                    "get_node_type_config",
                    "get_workspace_info",
                    "list_nodes",
                    "get_node",
                    "get_node_context",
                    "create_node",
                    "update_node",
                    "create_edge",
                    "finalize_node",
                    "get_system_info"
                ]
            }
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)
