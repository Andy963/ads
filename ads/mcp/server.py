"""
AD  Assistant  MCP  Server

Main  entry  point  for  the  MCP  server  that  exposes  AD  Assistant  tools.
"""

import  asyncio
import  sys
from  typing  import  Any

from  mcp.server  import  Server
from  mcp.server.stdio  import  stdio_server
from  mcp.types  import  Tool,  TextContent

from  .tools  import  workflow,  graph,  system,  workspace,  commands,  templates,  context,  rules
from  ..graph.edge_types  import  get_edge_types,  EdgeTypeConfig


#  Create  server  instance
app  =  Server("ad")


@app.list_tools()
async  def  list_tools()  ->  list[Tool]:
        """List  all  available  tools."""
        return  [
                #  Rules  tools
                Tool(
                        name="read_rules",
                        description="Read  project  rules.  Returns  workspace  development  constraints  and  specifications  that  AI  must  strictly  follow.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选，默认自动检测）"
                                        }
                                }
                        }
                ),
                Tool(
                        name="list_rules",
                        description="List  all  rule  items  (parse  individual  rules  from  the  rules  document).",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        },
                                        "category":  {
                                                "type":  "string",
                                                "description":  "规则分类筛选（可选）"
                                        }
                                }
                        }
                ),

                #  Workflow  tools
                Tool(
                        name="list_workflow_templates",
                        description="List  all  available  workflow  templates.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {}
                        }
                ),
                Tool(
                        name="get_workflow_template",
                        description="Get  detailed  information  of  a  workflow  template,  including  node  types,  steps,  and  connection  rules.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "template_id":  {
                                                "type":  "string",
                                                "description":  "模板  ID（如  bugfix,  standard,  feature）"
                                        }
                                },
                                "required":  ["template_id"]
                        }
                ),
                Tool(
                        name="get_node_type_config",
                        description="Get  configuration  information  of  a  node  type  (color,  icon,  description,  template).",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "node_type":  {
                                                "type":  "string",
                                                "description":  "节点类型（如  bug_report,  design,  implementation）"
                                        }
                                },
                                "required":  ["node_type"]
                        }
                ),
                Tool(
                        name="ads.new",
                        description="Create  a  complete  workflow  from  a  template.  Creates  a  series  of  connected  nodes  organized  in  the  same  workflow  based  on  template  configuration.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "template_id":  {
                                                "type":  "string",
                                                "description":  "模板  ID（如  standard,  bugfix,  feature）"
                                        },
                                        "title":  {
                                                "type":  "string",
                                                "description":  "工作流标题"
                                        },
                                        "description":  {
                                                "type":  "string",
                                                "description":  "工作流描述（可选，作为第一个节点的内容）"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["template_id",  "title"]
                        }
                ),

                #  Graph  read  tools
                Tool(
                        name="get_workspace_info",
                        description="Get  basic  information  and  statistics  of  the  workspace.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径，默认为当前目录"
                                        }
                                }
                        }
                ),
                Tool(
                        name="list_nodes",
                        description="List  nodes  in  the  workspace  with  filtering  by  type  and  status.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径"
                                        },
                                        "node_type":  {
                                                "type":  "string",
                                                "description":  "节点类型筛选"
                                        },
                                        "status":  {
                                                "type":  "string",
                                                "description":  "状态筛选（draft/finalized）",
                                                "enum":  ["draft",  "finalized"]
                                        },
                                        "limit":  {
                                                "type":  "integer",
                                                "description":  "限制返回数量"
                                        }
                                }
                        }
                ),
                Tool(
                        name="get_node",
                        description="Get  detailed  information  of  a  node,  including  content,  parent  nodes,  and  child  nodes.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "node_id":  {
                                                "type":  "string",
                                                "description":  "节点  ID"
                                        }
                                },
                                "required":  ["node_id"]
                        }
                ),
                Tool(
                        name="get_node_context",
                        description="Get  complete  context  of  a  node  including  all  parent  node  content  chains.  Used  to  understand  the  full  background  of  a  task.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "node_id":  {
                                                "type":  "string",
                                                "description":  "节点  ID"
                                        }
                                },
                                "required":  ["node_id"]
                        }
                ),

                #  Graph  write  tools
                Tool(
                        name="create_node",
                        description="Create  a  new  graph  node.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径"
                                        },
                                        "node_type":  {
                                                "type":  "string",
                                                "description":  "节点类型"
                                        },
                                        "title":  {
                                                "type":  "string",
                                                "description":  "节点标题"
                                        },
                                        "content":  {
                                                "type":  "string",
                                                "description":  "节点内容（Markdown  格式）"
                                        },
                                        "parent_id":  {
                                                "type":  "string",
                                                "description":  "父节点  ID（可选）"
                                        },
                                        "status":  {
                                                "type":  "string",
                                                "description":  "状态（draft/finalized），默认为  draft",
                                                "enum":  ["draft",  "finalized"]
                                        }
                                },
                                "required":  ["workspace_path",  "node_type",  "title",  "content"]
                        }
                ),
                Tool(
                        name="update_node",
                        description="Update  node  content  or  status.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "node_id":  {
                                                "type":  "string",
                                                "description":  "节点  ID"
                                        },
                                        "content":  {
                                                "type":  "string",
                                                "description":  "新内容（Markdown  格式）"
                                        },
                                        "status":  {
                                                "type":  "string",
                                                "description":  "新状态（draft/finalized）",
                                                "enum":  ["draft",  "finalized"]
                                        }
                                },
                                "required":  ["node_id"]
                        }
                ),
                Tool(
                        name="create_edge",
                        description=f"Create  a  relationship  edge  between  nodes.  Supported  edge  types:  {',  '.join(get_edge_types())}",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "source_id":  {
                                                "type":  "string",
                                                "description":  "源节点  ID"
                                        },
                                        "target_id":  {
                                                "type":  "string",
                                                "description":  "目标节点  ID"
                                        },
                                        "edge_type":  {
                                                "type":  "string",
                                                "description":  "边类型",
                                                "enum":  get_edge_types()    #  动态获取边类型
                                        }
                                },
                                "required":  ["source_id",  "target_id",  "edge_type"]
                        }
                ),
                Tool(
                        name="finalize_node",
                        description="Mark  a  node  as  finalized.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "node_id":  {
                                                "type":  "string",
                                                "description":  "节点  ID"
                                        }
                                },
                                "required":  ["node_id"]
                        }
                ),

                #  System  tools
                Tool(
                        name="get_system_info",
                        description="Get  system  information  including  version  and  available  tools  list.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {}
                        }
                ),
                Tool(
                        name="sync_all_nodes_to_files",
                        description="Sync  all  nodes  to  file  system  (docs/specs/,  grouped  by  workflow).",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径"
                                        }
                                }
                        }
                ),
                #  Workspace  tools
                Tool(
                        name="ads.init",
                        description="Initialize  current  directory  as  ADS  workspace.  Create  .ads/  directory  structure  and  configuration  files.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "name":  {
                                                "type":  "string",
                                                "description":  "工作空间名称（可选，默认使用目录名）"
                                        }
                                }
                        }
                ),
                Tool(
                        name="get_current_workspace",
                        description="Get  information  of  the  current  workspace  (path,  configuration,  initialization  status,  etc.).",
                        inputSchema={
                                "type":  "object",
                                "properties":  {}
                        }
                ),

                #  Workflow  Context  tools  (Git-like  workflow  management)
                Tool(
                        name="ads.branch",
                        description="Workflow  management  (fully  mimics  git  branch).  List  all  workflows  when  no  params;  -d  to  delete  completed  workflows;  -D  to  force  delete  any  workflow.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "operation":  {
                                                "type":  "string",
                                                "description":  "操作类型：'list'（列出，默认）、'delete'（-d  安全删除）、'force_delete'（-D  强制删除）",
                                                "enum":  ["list",  "delete",  "force_delete"]
                                        },
                                        "workflow":  {
                                                "type":  "string",
                                                "description":  "工作流名称、ID  或序号（删除操作时必需）"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  []
                        }
                ),
                Tool(
                        name="ads.status",
                        description="Get  current  workflow  status  (like  git  status).  Show  progress  of  all  steps,  current  step,  and  finalization  status  of  each  step.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                }
                        }
                ),
                Tool(
                        name="ads.log",
                        description="List recent workflows (default 5) showing title, template type, node count, and completion progress for each.",
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
                        description="Switch  active  workflow  (like  git  checkout).  Can  switch  by  workflow  ID  or  title  with  fuzzy  matching  support.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workflow_identifier":  {
                                                "type":  "string",
                                                "description":  "工作流  ID  或标题（支持模糊匹配）"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["workflow_identifier"]
                        }
                ),
                Tool(
                        name="ads.get",
                        description="Get  node  information  by  step  name.  Example:  get_step_node('report')  to  get  bug  report  node.  Step  names:  bugfix(report/analysis/fix/verify),  standard(aggregate/requirement/design/implementation).",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "step_name":  {
                                                "type":  "string",
                                                "description":  "步骤名称（如  report,  analysis,  fix,  verify,  aggregate,  requirement,  design,  implementation）"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["step_name"]
                        }
                ),
                Tool(
                        name="ads.add",
                        description="Update  draft  content  of  workflow  step.  Example:  add_step_content('analysis',  content)  to  update  analysis  step  content.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "step_name":  {
                                                "type":  "string",
                                                "description":  "步骤名称"
                                        },
                                        "content":  {
                                                "type":  "string",
                                                "description":  "新内容（Markdown  格式）"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["step_name",  "content"]
                        }
                ),
                Tool(
                        name="ads.commit",
                        description="Commit  workflow  step  and  trigger  automatic  flow.  Example:  commit_step('report')  commits  report  step  and  system  automatically  creates  next  step  (analysis).",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "step_name":  {
                                                "type":  "string",
                                                "description":  "步骤名称"
                                        },
                                        "change_description":  {
                                                "type":  "string",
                                                "description":  "变更描述（可选）"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["step_name"]
                        }
                ),


                #  Command  tools
                Tool(
                        name="ads.commands",
                        description="List  all  available  slash  commands  (project-level  custom  commands).",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选，默认自动检测）"
                                        }
                                }
                        }
                ),
                Tool(
                        name="get_command",
                        description="Get  detailed  information  of  a  slash  command.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "command_name":  {
                                                "type":  "string",
                                                "description":  "命令名称"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["command_name"]
                        }
                ),
                Tool(
                        name="ads.run",
                        description="Execute  a  slash  command  with  variable  substitution  and  return  expanded  content.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "command_name":  {
                                                "type":  "string",
                                                "description":  "命令名称"
                                        },
                                        "variables":  {
                                                "type":  "string",
                                                "description":  "JSON  格式的变量字典（可选）"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["command_name"]
                        }
                ),
                Tool(
                        name="validate_command",
                        description="Validate  if  slash  command  and  provided  variables  are  valid.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "command_name":  {
                                                "type":  "string",
                                                "description":  "命令名称"
                                        },
                                        "variables":  {
                                                "type":  "string",
                                                "description":  "JSON  格式的变量字典（可选）"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["command_name"]
                        }
                ),

                #  Template  tools
                Tool(
                        name="list_templates",
                        description="List  all  available  templates  (node  templates  and  workflow  templates).",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                }
                        }
                ),
                Tool(
                        name="get_node_template",
                        description="Get  detailed  information  of  a  node  template.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "template_name":  {
                                                "type":  "string",
                                                "description":  "模板名称"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["template_name"]
                        }
                ),
                Tool(
                        name="get_workflow_template_custom",
                        description="Get  detailed  information  of  a  custom  workflow  template  (from  .ads/templates/workflows/).",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "template_name":  {
                                                "type":  "string",
                                                "description":  "模板名称"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["template_name"]
                        }
                ),
                Tool(
                        name="render_template",
                        description="Render  a  template  (perform  variable  substitution).",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "template_content":  {
                                                "type":  "string",
                                                "description":  "模板内容"
                                        },
                                        "variables":  {
                                                "type":  "string",
                                                "description":  "JSON  格式的变量字典"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["template_content",  "variables"]
                        }
                ),
                Tool(
                        name="validate_template",
                        description="Validate  template  and  variables.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "template_content":  {
                                                "type":  "string",
                                                "description":  "模板内容"
                                        },
                                        "variables":  {
                                                "type":  "string",
                                                "description":  "JSON  格式的变量字典（可选）"
                                        },
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径（可选）"
                                        }
                                },
                                "required":  ["template_content"]
                        }
                ),
                Tool(
                        name="create_node_from_template",
                        description="Create  a  node  from  a  template.",
                        inputSchema={
                                "type":  "object",
                                "properties":  {
                                        "workspace_path":  {
                                                "type":  "string",
                                                "description":  "工作空间路径"
                                        },
                                        "template_name":  {
                                                "type":  "string",
                                                "description":  "模板名称"
                                        },
                                        "variables":  {
                                                "type":  "string",
                                                "description":  "JSON  格式的变量字典"
                                        },
                                        "parent_id":  {
                                                "type":  "string",
                                                "description":  "父节点  ID（可选）"
                                        },
                                        "status":  {
                                                "type":  "string",
                                                "description":  "状态（draft/finalized），默认为  draft",
                                                "enum":  ["draft",  "finalized"]
                                        }
                                },
                                "required":  ["workspace_path",  "template_name",  "variables"]
                        }
                ),
        ]


# Tool handlers mapping - 工具路由表
async def _handle_ads_branch(arguments: Any) -> str:
        """特殊处理 ads.branch 的多操作分发"""
        operation = arguments.get("operation", "list")
        if operation == "list":
                return await context.list_workflows(
                        workspace_path=arguments.get("workspace_path"),
                        limit=5
                )
        elif operation == "delete":
                return await context.delete_workflow(
                        workflow_id=arguments["workflow"],
                        workspace_path=arguments.get("workspace_path"),
                        force=False
                )
        elif operation == "force_delete":
                return await context.delete_workflow(
                        workflow_id=arguments["workflow"],
                        workspace_path=arguments.get("workspace_path"),
                        force=True
                )
        else:
                raise ValueError(f"Unsupported operation for ads.branch: {operation}")


TOOL_HANDLERS = {
        # Rules tools
        "read_rules": lambda args: rules.read_rules(workspace_path=args.get("workspace_path")),
        "list_rules": lambda args: rules.list_rules(workspace_path=args.get("workspace_path"), category=args.get("category")),
        
        # Workflow tools
        "list_workflow_templates": lambda args: workflow.list_workflow_templates(),
        "get_workflow_template": lambda args: workflow.get_workflow_template(template_id=args["template_id"]),
        "get_node_type_config": lambda args: workflow.get_node_type_config(node_type=args["node_type"]),
        "ads.new": lambda args: workflow.create_workflow_from_template(
                template_id=args["template_id"],
                title=args["title"],
                description=args.get("description", ""),
                workspace_path=args.get("workspace_path")
        ),
        
        # Graph read tools
        "get_workspace_info": lambda args: graph.get_workspace_info(workspace_path=args.get("workspace_path")),
        "list_nodes": lambda args: graph.list_nodes(
                workspace_path=args.get("workspace_path"),
                node_type=args.get("node_type"),
                status=args.get("status"),
                limit=args.get("limit")
        ),
        "get_node": lambda args: graph.get_node(node_id=args["node_id"]),
        "get_node_context": lambda args: graph.get_node_context(node_id=args["node_id"]),
        
        # Graph write tools
        "create_node": lambda args: graph.create_node(
                workspace_path=args["workspace_path"],
                node_type=args["node_type"],
                title=args["title"],
                content=args["content"],
                parent_id=args.get("parent_id"),
                status=args.get("status", "draft")
        ),
        "update_node": lambda args: graph.update_node(
                node_id=args["node_id"],
                content=args.get("content"),
                status=args.get("status")
        ),
        "create_edge": lambda args: graph.create_edge(
                source_id=args["source_id"],
                target_id=args["target_id"],
                edge_type=args["edge_type"]
        ),
        "finalize_node": lambda args: graph.finalize_node(node_id=args["node_id"]),
        
        # System tools
        "get_system_info": lambda args: system.get_system_info(),
        "sync_all_nodes_to_files": lambda args: graph.sync_all_nodes_to_files(workspace_path=args.get("workspace_path")),
        
        # Workspace tools
        "ads.init": lambda args: workspace.init_workspace(name=args.get("name")),
        "get_current_workspace": lambda args: workspace.get_current_workspace(),
        
        # Workflow Context tools
        "ads.branch": _handle_ads_branch,
        "ads.status": lambda args: context.get_workflow_status(workspace_path=args.get("workspace_path")),
        "ads.log": lambda args: context.list_workflows(workspace_path=args.get("workspace_path"), limit=5),
        "ads.checkout": lambda args: context.switch_workflow(
                workflow_identifier=args["workflow_identifier"],
                workspace_path=args.get("workspace_path")
        ),
        "ads.get": lambda args: context.get_step_node(
                step_name=args["step_name"],
                workspace_path=args.get("workspace_path")
        ),
        "ads.add": lambda args: context.update_step_draft(
                step_name=args["step_name"],
                content=args["content"],
                workspace_path=args.get("workspace_path")
        ),
        "ads.commit": lambda args: context.finalize_step(
                step_name=args["step_name"],
                change_description=args.get("change_description"),
                workspace_path=args.get("workspace_path")
        ),
        
        # Command tools
        "ads.commands": lambda args: commands.list_commands(workspace_path=args.get("workspace_path")),
        "get_command": lambda args: commands.get_command(
                command_name=args["command_name"],
                workspace_path=args.get("workspace_path")
        ),
        "ads.run": lambda args: commands.execute_command(
                command_name=args["command_name"],
                variables=args.get("variables"),
                workspace_path=args.get("workspace_path")
        ),
        "validate_command": lambda args: commands.validate_command(
                command_name=args["command_name"],
                variables=args.get("variables"),
                workspace_path=args.get("workspace_path")
        ),
        
        # Template tools
        "list_templates": lambda args: templates.list_templates(workspace_path=args.get("workspace_path")),
        "get_node_template": lambda args: templates.get_node_template(
                template_name=args["template_name"],
                workspace_path=args.get("workspace_path")
        ),
        "get_workflow_template_custom": lambda args: templates.get_workflow_template(
                template_name=args["template_name"],
                workspace_path=args.get("workspace_path")
        ),
        "render_template": lambda args: templates.render_template(
                template_content=args["template_content"],
                variables=args["variables"],
                workspace_path=args.get("workspace_path")
        ),
        "validate_template": lambda args: templates.validate_template(
                template_content=args["template_content"],
                variables=args.get("variables"),
                workspace_path=args.get("workspace_path")
        ),
        "create_node_from_template": lambda args: templates.create_node_from_template(
                workspace_path=args["workspace_path"],
                template_name=args["template_name"],
                variables=args["variables"],
                parent_id=args.get("parent_id"),
                status=args.get("status", "draft")
        ),
}


@app.call_tool()
async  def  call_tool(name:  str,  arguments:  Any)  ->  list[TextContent]:
        """Execute  tool  calls."""
        
        handler = TOOL_HANDLERS.get(name)
        if not handler:
                raise ValueError(f"Unknown tool: {name}")
        
        args = arguments or {}
        if not isinstance(args, dict):
                raise TypeError(f"Tool '{name}' expects arguments object, got {type(arguments).__name__}")
        result = await handler(args)
        return [TextContent(type="text", text=result)]


async  def  main():
        """Run  the  MCP  server."""
        async  with  stdio_server()  as  (read_stream,  write_stream):
                await  app.run(
                        read_stream,
                        write_stream,
                        app.create_initialization_options()
                )


if  __name__  ==  "__main__":
        asyncio.run(main())
