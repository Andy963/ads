"""
AD Assistant MCP Server

Main entry point for the MCP server that exposes AD Assistant tools.
"""

import asyncio
import sys
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from .tools import workflow, graph, system, workspace, commands, templates, context, rules
from ..graph.edge_types import get_edge_types, EdgeTypeConfig


# Create server instance
app = Server("ad")


@app.list_tools()
async def list_tools() -> list[Tool]:
    """List all available tools."""
    return [
        # Rules tools
        Tool(
            name="read_rules",
            description="读取项目规则。返回工作空间的开发约束和规范，AI 必须严格遵守这些规则。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选，默认自动检测）"
                    }
                }
            }
        ),
        Tool(
            name="list_rules",
            description="列出所有规则项（解析规则文档中的各项规则）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    },
                    "category": {
                        "type": "string",
                        "description": "规则分类筛选（可选）"
                    }
                }
            }
        ),

        # Workflow tools
        Tool(
            name="list_workflow_templates",
            description="列出所有可用的工作流模板。",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="get_workflow_template",
            description="获取工作流模板的详细信息，包括节点类型、步骤和连接规则。",
            inputSchema={
                "type": "object",
                "properties": {
                    "template_id": {
                        "type": "string",
                        "description": "模板 ID（如 bugfix, standard, feature）"
                    }
                },
                "required": ["template_id"]
            }
        ),
        Tool(
            name="get_node_type_config",
            description="获取节点类型的配置信息（颜色、图标、描述、模板）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "node_type": {
                        "type": "string",
                        "description": "节点类型（如 bug_report, design, implementation）"
                    }
                },
                "required": ["node_type"]
            }
        ),
        Tool(
            name="ads.new",
            description="从工作流模板创建完整的工作流。根据模板配置创建一系列相连的节点，组织在同一个工作流中。",
            inputSchema={
                "type": "object",
                "properties": {
                    "template_id": {
                        "type": "string",
                        "description": "模板 ID（如 standard, bugfix, feature）"
                    },
                    "title": {
                        "type": "string",
                        "description": "工作流标题"
                    },
                    "description": {
                        "type": "string",
                        "description": "工作流描述（可选，作为第一个节点的内容）"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["template_id", "title"]
            }
        ),

        # Graph read tools
        Tool(
            name="get_workspace_info",
            description="获取工作空间的基本信息和统计数据。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径，默认为当前目录"
                    }
                }
            }
        ),
        Tool(
            name="list_nodes",
            description="列出工作空间中的节点，支持按类型和状态筛选。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径"
                    },
                    "node_type": {
                        "type": "string",
                        "description": "节点类型筛选"
                    },
                    "status": {
                        "type": "string",
                        "description": "状态筛选（draft/finalized）",
                        "enum": ["draft", "finalized"]
                    },
                    "limit": {
                        "type": "integer",
                        "description": "限制返回数量"
                    }
                }
            }
        ),
        Tool(
            name="get_node",
            description="获取节点的详细信息，包括内容、父节点和子节点。",
            inputSchema={
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "节点 ID"
                    }
                },
                "required": ["node_id"]
            }
        ),
        Tool(
            name="get_node_context",
            description="获取节点的完整上下文，包括所有父节点的内容链。用于了解任务的完整背景。",
            inputSchema={
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "节点 ID"
                    }
                },
                "required": ["node_id"]
            }
        ),

        # Graph write tools
        Tool(
            name="create_node",
            description="创建新的图谱节点。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径"
                    },
                    "node_type": {
                        "type": "string",
                        "description": "节点类型"
                    },
                    "title": {
                        "type": "string",
                        "description": "节点标题"
                    },
                    "content": {
                        "type": "string",
                        "description": "节点内容（Markdown 格式）"
                    },
                    "parent_id": {
                        "type": "string",
                        "description": "父节点 ID（可选）"
                    },
                    "status": {
                        "type": "string",
                        "description": "状态（draft/finalized），默认为 draft",
                        "enum": ["draft", "finalized"]
                    }
                },
                "required": ["workspace_path", "node_type", "title", "content"]
            }
        ),
        Tool(
            name="update_node",
            description="更新节点的内容或状态。",
            inputSchema={
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "节点 ID"
                    },
                    "content": {
                        "type": "string",
                        "description": "新内容（Markdown 格式）"
                    },
                    "status": {
                        "type": "string",
                        "description": "新状态（draft/finalized）",
                        "enum": ["draft", "finalized"]
                    }
                },
                "required": ["node_id"]
            }
        ),
        Tool(
            name="create_edge",
            description=f"创建节点之间的关系边。支持的边类型：{', '.join(f'{t}({EdgeTypeConfig.get_edge_type_description(t)})' for t in get_edge_types())}",
            inputSchema={
                "type": "object",
                "properties": {
                    "source_id": {
                        "type": "string",
                        "description": "源节点 ID"
                    },
                    "target_id": {
                        "type": "string",
                        "description": "目标节点 ID"
                    },
                    "edge_type": {
                        "type": "string",
                        "description": "边类型",
                        "enum": get_edge_types()  # 动态获取边类型
                    }
                },
                "required": ["source_id", "target_id", "edge_type"]
            }
        ),
        Tool(
            name="finalize_node",
            description="将节点标记为已定稿（finalized）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "节点 ID"
                    }
                },
                "required": ["node_id"]
            }
        ),

        # System tools
        Tool(
            name="get_system_info",
            description="获取系统信息，包括版本、可用工具列表等。",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="sync_all_nodes_to_files",
            description="将所有节点同步到文件系统（docs/specs/，按工作流分组）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径"
                    }
                }
            }
        ),
        Tool(
            name="relayout_all_workflows",
            description="重新布局所有工作流（水平排列 + 垂直分隔）。",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),

        # Workspace tools
        Tool(
            name="ads.init",
            description="初始化当前目录为 AD 工作空间。创建 .ads/ 目录结构和配置文件。",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "工作空间名称（可选，默认使用目录名）"
                    }
                }
            }
        ),
        Tool(
            name="get_current_workspace",
            description="获取当前工作空间的信息（路径、配置、初始化状态等）。",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),

        # Workflow Context tools (Git-like workflow management)
        Tool(
            name="ads.branch",
            description="获取当前活动的工作流（类似 git branch）。显示工作流信息和步骤映射。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                }
            }
        ),
        Tool(
            name="ads.status",
            description="获取当前工作流的状态（类似 git status）。显示所有步骤的进度、当前步骤、以及每个步骤的定稿状态。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                }
            }
        ),
        Tool(
            name="ads.list",
            description="列出所有工作流，显示每个工作流的标题、模板类型、节点数量和完成进度。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                }
            }
        ),
        Tool(
            name="ads.checkout",
            description="切换活动工作流（类似 git checkout）。可以通过工作流 ID 或标题切换，支持模糊匹配。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workflow_identifier": {
                        "type": "string",
                        "description": "工作流 ID 或标题（支持模糊匹配）"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["workflow_identifier"]
            }
        ),
        Tool(
            name="ads.get",
            description="通过步骤名称获取节点信息。例如：get_step_node(\"report\") 获取 bug 报告节点。步骤名称：bugfix(report/analysis/fix/verify), standard(aggregate/requirement/design/implementation)。",
            inputSchema={
                "type": "object",
                "properties": {
                    "step_name": {
                        "type": "string",
                        "description": "步骤名称（如 report, analysis, fix, verify, aggregate, requirement, design, implementation）"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["step_name"]
            }
        ),
        Tool(
            name="ads.update",
            description="更新工作流步骤的草稿内容。例如：update_step_draft(\"analysis\", content) 更新分析步骤的内容。",
            inputSchema={
                "type": "object",
                "properties": {
                    "step_name": {
                        "type": "string",
                        "description": "步骤名称"
                    },
                    "content": {
                        "type": "string",
                        "description": "新内容（Markdown 格式）"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["step_name", "content"]
            }
        ),
        Tool(
            name="ads.finalize",
            description="定稿工作流步骤并触发自动流转。例如：finalize_step(\"report\") 定稿报告步骤，系统会自动创建下一步（分析步骤）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "step_name": {
                        "type": "string",
                        "description": "步骤名称"
                    },
                    "change_description": {
                        "type": "string",
                        "description": "变更描述（可选）"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["step_name"]
            }
        ),

        # Command tools
        Tool(
            name="ads.commands",
            description="列出所有可用的 slash commands（项目级自定义命令）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选，默认自动检测）"
                    }
                }
            }
        ),
        Tool(
            name="get_command",
            description="获取 slash command 的详细信息。",
            inputSchema={
                "type": "object",
                "properties": {
                    "command_name": {
                        "type": "string",
                        "description": "命令名称"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["command_name"]
            }
        ),
        Tool(
            name="ads.run",
            description="执行 slash command，进行变量替换后返回展开的命令内容。",
            inputSchema={
                "type": "object",
                "properties": {
                    "command_name": {
                        "type": "string",
                        "description": "命令名称"
                    },
                    "variables": {
                        "type": "string",
                        "description": "JSON 格式的变量字典（可选）"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["command_name"]
            }
        ),
        Tool(
            name="validate_command",
            description="验证 slash command 和提供的变量是否有效。",
            inputSchema={
                "type": "object",
                "properties": {
                    "command_name": {
                        "type": "string",
                        "description": "命令名称"
                    },
                    "variables": {
                        "type": "string",
                        "description": "JSON 格式的变量字典（可选）"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["command_name"]
            }
        ),

        # Template tools
        Tool(
            name="list_templates",
            description="列出所有可用的模板（节点模板和工作流模板）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                }
            }
        ),
        Tool(
            name="get_node_template",
            description="获取节点模板的详细信息。",
            inputSchema={
                "type": "object",
                "properties": {
                    "template_name": {
                        "type": "string",
                        "description": "模板名称"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["template_name"]
            }
        ),
        Tool(
            name="get_workflow_template_custom",
            description="获取自定义工作流模板的详细信息（从 .ads/templates/workflows/）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "template_name": {
                        "type": "string",
                        "description": "模板名称"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["template_name"]
            }
        ),
        Tool(
            name="render_template",
            description="渲染模板（进行变量替换）。",
            inputSchema={
                "type": "object",
                "properties": {
                    "template_content": {
                        "type": "string",
                        "description": "模板内容"
                    },
                    "variables": {
                        "type": "string",
                        "description": "JSON 格式的变量字典"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["template_content", "variables"]
            }
        ),
        Tool(
            name="validate_template",
            description="验证模板和变量。",
            inputSchema={
                "type": "object",
                "properties": {
                    "template_content": {
                        "type": "string",
                        "description": "模板内容"
                    },
                    "variables": {
                        "type": "string",
                        "description": "JSON 格式的变量字典（可选）"
                    },
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径（可选）"
                    }
                },
                "required": ["template_content"]
            }
        ),
        Tool(
            name="create_node_from_template",
            description="从模板创建节点。",
            inputSchema={
                "type": "object",
                "properties": {
                    "workspace_path": {
                        "type": "string",
                        "description": "工作空间路径"
                    },
                    "template_name": {
                        "type": "string",
                        "description": "模板名称"
                    },
                    "variables": {
                        "type": "string",
                        "description": "JSON 格式的变量字典"
                    },
                    "parent_id": {
                        "type": "string",
                        "description": "父节点 ID（可选）"
                    },
                    "status": {
                        "type": "string",
                        "description": "状态（draft/finalized），默认为 draft",
                        "enum": ["draft", "finalized"]
                    }
                },
                "required": ["workspace_path", "template_name", "variables"]
            }
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: Any) -> list[TextContent]:
    """Execute tool calls."""

    # Rules tools
    if name == "read_rules":
        result = await rules.read_rules(
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "list_rules":
        result = await rules.list_rules(
            workspace_path=arguments.get("workspace_path"),
            category=arguments.get("category")
        )
        return [TextContent(type="text", text=result)]

    # Workflow tools
    if name == "list_workflow_templates":
        result = await workflow.list_workflow_templates()
        return [TextContent(type="text", text=result)]

    elif name == "get_workflow_template":
        result = await workflow.get_workflow_template(
            template_id=arguments["template_id"]
        )
        return [TextContent(type="text", text=result)]

    elif name == "get_node_type_config":
        result = await workflow.get_node_type_config(
            node_type=arguments["node_type"]
        )
        return [TextContent(type="text", text=result)]

    elif name == "ads.new":
        result = await workflow.create_workflow_from_template(
            template_id=arguments["template_id"],
            title=arguments["title"],
            description=arguments.get("description", ""),
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    # Graph read tools
    elif name == "get_workspace_info":
        result = await graph.get_workspace_info(
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "list_nodes":
        result = await graph.list_nodes(
            workspace_path=arguments.get("workspace_path"),
            node_type=arguments.get("node_type"),
            status=arguments.get("status"),
            limit=arguments.get("limit")
        )
        return [TextContent(type="text", text=result)]

    elif name == "get_node":
        result = await graph.get_node(
            node_id=arguments["node_id"]
        )
        return [TextContent(type="text", text=result)]

    elif name == "get_node_context":
        result = await graph.get_node_context(
            node_id=arguments["node_id"]
        )
        return [TextContent(type="text", text=result)]

    # Graph write tools
    elif name == "create_node":
        result = await graph.create_node(
            workspace_path=arguments["workspace_path"],
            node_type=arguments["node_type"],
            title=arguments["title"],
            content=arguments["content"],
            parent_id=arguments.get("parent_id"),
            status=arguments.get("status", "draft")
        )
        return [TextContent(type="text", text=result)]

    elif name == "update_node":
        result = await graph.update_node(
            node_id=arguments["node_id"],
            content=arguments.get("content"),
            status=arguments.get("status")
        )
        return [TextContent(type="text", text=result)]

    elif name == "create_edge":
        result = await graph.create_edge(
            source_id=arguments["source_id"],
            target_id=arguments["target_id"],
            edge_type=arguments["edge_type"]
        )
        return [TextContent(type="text", text=result)]

    elif name == "finalize_node":
        result = await graph.finalize_node(
            node_id=arguments["node_id"]
        )
        return [TextContent(type="text", text=result)]

    # System tools
    elif name == "get_system_info":
        result = await system.get_system_info()
        return [TextContent(type="text", text=result)]

    elif name == "sync_all_nodes_to_files":
        result = await graph.sync_all_nodes_to_files(
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "relayout_all_workflows":
        result = await graph.relayout_all_workflows()
        return [TextContent(type="text", text=result)]

    # Workspace tools
    elif name == "ads.init":
        result = await workspace.init_workspace(
            name=arguments.get("name")
        )
        return [TextContent(type="text", text=result)]

    elif name == "get_current_workspace":
        result = await workspace.get_current_workspace()
        return [TextContent(type="text", text=result)]

    # Workflow Context tools
    elif name == "ads.branch":
        result = await context.get_active_workflow(
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "ads.status":
        result = await context.get_workflow_status(
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "ads.list":
        result = await context.list_workflows(
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "ads.checkout":
        result = await context.switch_workflow(
            workflow_identifier=arguments["workflow_identifier"],
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "ads.get":
        result = await context.get_step_node(
            step_name=arguments["step_name"],
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "ads.update":
        result = await context.update_step_draft(
            step_name=arguments["step_name"],
            content=arguments["content"],
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "ads.finalize":
        result = await context.finalize_step(
            step_name=arguments["step_name"],
            change_description=arguments.get("change_description"),
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    # Command tools
    elif name == "ads.commands":
        result = await commands.list_commands(
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "get_command":
        result = await commands.get_command(
            command_name=arguments["command_name"],
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "ads.run":
        result = await commands.execute_command(
            command_name=arguments["command_name"],
            variables=arguments.get("variables"),
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "validate_command":
        result = await commands.validate_command(
            command_name=arguments["command_name"],
            variables=arguments.get("variables"),
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    # Template tools
    elif name == "list_templates":
        result = await templates.list_templates(
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "get_node_template":
        result = await templates.get_node_template(
            template_name=arguments["template_name"],
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "get_workflow_template_custom":
        result = await templates.get_workflow_template(
            template_name=arguments["template_name"],
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "render_template":
        result = await templates.render_template(
            template_content=arguments["template_content"],
            variables=arguments["variables"],
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "validate_template":
        result = await templates.validate_template(
            template_content=arguments["template_content"],
            variables=arguments.get("variables"),
            workspace_path=arguments.get("workspace_path")
        )
        return [TextContent(type="text", text=result)]

    elif name == "create_node_from_template":
        result = await templates.create_node_from_template(
            workspace_path=arguments["workspace_path"],
            template_name=arguments["template_name"],
            variables=arguments["variables"],
            parent_id=arguments.get("parent_id"),
            status=arguments.get("status", "draft")
        )
        return [TextContent(type="text", text=result)]

    else:
        raise ValueError(f"Unknown tool: {name}")


async def main():
    """Run the MCP server."""
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            app.create_initialization_options()
        )


if __name__ == "__main__":
    asyncio.run(main())
