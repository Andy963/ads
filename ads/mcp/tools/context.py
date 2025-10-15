"""
工作流上下文相关的  MCP  工具

提供基于步骤名称的工作流操作，无需记住  node_id。
"""

import  json
import  shutil
from  pathlib  import  Path
from  typing  import  Optional

from  ...workspace.context  import  WorkflowContext
from  ...workspace.detector  import  WorkspaceDetector
from  ...graph.crud  import  GraphCRUD

#  导入命令常量
from  .workflow  import  CMD_ADD,  CMD_COMMIT,  CMD_NEW,  CMD_STATUS,  CMD_CHECKOUT,  CMD_BRANCH


async  def  get_active_workflow(workspace_path:  Optional[str]  =  None)  ->  str:
        """
        获取当前活动的工作流（Git  风格格式）。

        Note:  建议使用  list_workflows  或  get_workflow_status  代替此工具。

        Returns:
                格式化的文本输出
        """
        try:
                from  pathlib  import  Path
                workspace  =  Path(workspace_path)  if  workspace_path  else  None

                #  尝试自动激活单个工作流
                WorkflowContext.auto_activate_if_single_workflow(workspace)

                workflow  =  WorkflowContext.get_active_workflow(workspace)

                if  not  workflow:
                        return  f"""❌  没有活动的工作流

💡  开始使用：
    -  创建新工作流:  {CMD_NEW}  <type>  <title>
    -  查看所有工作流:  {CMD_BRANCH}"""

                #  构建简洁的输出  (使用  Markdown  代码块保留格式)
                lines  =  []
                lines.append("```")
                lines.append("✓  Active  workflow:")
                lines.append(f"    Title:  {workflow['title']}")
                lines.append(f"    Template:  {workflow['template']}")
                lines.append(f"    ID:  {workflow['workflow_id']}")

                if  workflow.get('current_step'):
                        lines.append(f"    Current  step:  {workflow['current_step']}")

                #  显示步骤
                steps  =  workflow.get('steps',  {})
                if  steps:
                        lines.append(f"")
                        lines.append(f"    Steps  ({len(steps)}  total):")
                        for  step_name,  node_id  in  steps.items():
                                if  node_id:
                                        lines.append(f"        -  {step_name}:  {node_id}")
                                else:
                                        lines.append(f"        -  {step_name}:  (not  created)")

                lines.append("")
                lines.append(f"💡  For  detailed  status,  use:  {CMD_STATUS}")
                lines.append("```")

                return  "\n".join(lines)

        except  Exception  as  e:
                return  f"❌  Error:  {str(e)}"


async  def  get_workflow_status(workspace_path:  Optional[str]  =  None)  ->  str:
        """
        获取当前工作流的状态（Git  风格格式，类似  git  status）。

        显示所有步骤的进度和当前步骤。

        Returns:
                格式化的文本输出
        """
        try:
                from  pathlib  import  Path
                from  datetime  import  datetime
                workspace  =  Path(workspace_path)  if  workspace_path  else  None

                #  尝试自动激活单个工作流
                WorkflowContext.auto_activate_if_single_workflow(workspace)

                #  获取活动工作流
                workflow  =  WorkflowContext.get_active_workflow(workspace)

                if  not  workflow:
                        return  f"""❌  No  active  workflow

💡  To  get  started:
    -  List  existing  workflows:  {CMD_BRANCH}
    -  Create  new  workflow:  {CMD_NEW}  <type>  <title>
    -  Switch  to  workflow:  {CMD_CHECKOUT}  <workflow>"""

                #  构建  Git  status  风格输出
                lines  =  []
                lines.append(f"On  workflow:  {workflow.get('title',  'Unknown')}")
                lines.append(f"Template:  {workflow.get('template',  'Unknown')}")

                workflow_id  =  workflow.get('workflow_id',  '')
                if  workflow_id:
                        lines.append(f"ID:  {workflow_id}")

                lines.append("")
                lines.append("Steps:")

                #  步骤状态图标
                steps_dict  =  workflow.get('steps',  {})
                current_step  =  workflow.get('current_step')

                #  收集步骤信息（保持步骤顺序）
                template  =  workflow.get('template',  '')
                step_mapping  =  WorkflowContext.STEP_MAPPINGS.get(template,  {})

                step_order  =  list(step_mapping.keys())

                total_steps  =  len(step_order)
                finalized_count  =  0

                for  step_name  in  step_order:
                        node_id  =  steps_dict.get(step_name)

                        if  not  node_id:
                                lines.append(f"    ⚪  {step_name:<12}  (not  created  yet)")
                                continue

                        node  =  GraphCRUD.get_node_by_id(node_id)
                        if  not  node:
                                lines.append(f"    ⚪  {step_name:<12}  (not  found)")
                                continue

                        is_draft  =  node.is_draft
                        current_version  =  node.current_version  or  0
                        label  =  node.label

                        #  状态图标
                        if  not  is_draft:
                                #  已定稿（不管版本号，因为可能是旧数据没有版本记录）
                                icon  =  "✅"
                                if  current_version  >  0:
                                        status_text  =  f"(v{current_version},  finalized)"
                                else:
                                        status_text  =  "(finalized,  no  version)"
                                finalized_count  +=  1
                        elif  is_draft:
                                icon  =  "📝"
                                status_text  =  "(draft)"
                        else:
                                icon  =  "⚪"
                                status_text  =  "(empty)"

                        #  当前步骤标记
                        marker  =  "→  "  if  step_name  ==  current_step  else  "    "

                        lines.append(f"{marker}{icon}  {step_name:<12}  {label}  {status_text}")

                #  进度统计
                lines.append("")
                progress_pct  =  int(finalized_count  /  total_steps  *  100)  if  total_steps  >  0  else  0

                lines.append(f"Progress:  {finalized_count}/{total_steps}  steps  finalized  ({progress_pct}%)")

                if  progress_pct  ==  100:
                        lines.append("")
                        lines.append("🎉  This  workflow  is  complete!")

                #  当前步骤详情
                if  current_step  and  current_step  in  steps_dict:
                        node_id  =  steps_dict[current_step]
                        if  node_id:
                                node  =  GraphCRUD.get_node_by_id(node_id)
                                if  node:
                                        lines.append("")
                                        lines.append(f"→  Current  step:  {current_step}")
                                        if  node.is_draft:
                                                lines.append("    Status:  Draft  in  progress")
                                                #  显示更新时间
                                                updated_at  =  node.updated_at
                                                if  updated_at:
                                                        try:
                                                                now  =  datetime.now()
                                                                delta  =  now  -  updated_at
                                                                if  delta.seconds  <  60:
                                                                        time_ago  =  "just  now"
                                                                elif  delta.seconds  <  3600:
                                                                        time_ago  =  f"{delta.seconds  //  60}  minutes  ago"
                                                                elif  delta.seconds  <  86400:
                                                                        time_ago  =  f"{delta.seconds  //  3600}  hours  ago"
                                                                else:
                                                                        time_ago  =  f"{delta.days}  days  ago"
                                                                lines.append(f"    Last  updated:  {time_ago}")
                                                        except:
                                                                pass
                                        else:
                                                lines.append("    Status:  Finalized")

                #  下一步建议
                lines.append("")
                lines.append("💡  Next  actions:")
                if  current_step:
                        node_id  =  steps_dict.get(current_step)
                        if  node_id:
                                node  =  GraphCRUD.get_node_by_id(node_id)
                                if  node  and  node.is_draft:
                                        #  检查是否是第一步
                                        is_first_step  =  (current_step  ==  step_order[0]  if  step_order  else  False)

                                        if  is_first_step  and  (node.current_version  or  0)  ==  0:
                                                #  第一步的特殊引导
                                                lines.append(f"    ⚠️    First  step  needs  detailed  content  before  committing!")
                                                lines.append("")

                                                #  根据模板类型提供引导
                                                if  template  ==  "bugfix":
                                                        lines.append("    For  Bug  Report,  make  sure  to  include:")
                                                        lines.append("        -  问题描述:  简要说明bug是什么")
                                                        lines.append("        -  复现步骤:  如何重现这个问题")
                                                        lines.append("        -  期望行为  vs  实际行为")
                                                        lines.append("        -  影响范围和优先级")
                                                elif  template  ==  "standard":
                                                        lines.append("    For  Aggregate  Root,  make  sure  to  include:")
                                                        lines.append("        -  领域概念:  这个聚合根代表什么")
                                                        lines.append("        -  业务边界:  负责哪些业务规则")
                                                        lines.append("        -  核心实体:  包含哪些主要实体")
                                                        lines.append("        -  业务规则:  关键的业务约束")
                                                elif  template  ==  "feature":
                                                        lines.append("    For  Feature,  make  sure  to  include:")
                                                        lines.append("        -  功能描述:  这个功能做什么")
                                                        lines.append("        -  用户价值:  为什么需要这个功能")
                                                        lines.append("        -  验收标准:  如何判断功能完成")

                                                lines.append("")
                                                lines.append(f"    Then:")

                                        lines.append(f"    -  Continue  editing:  Just  tell  me  what  to  change")
                                        lines.append(f"    -  Finalize  step:  {CMD_COMMIT}  {current_step}")
                                else:
                                        lines.append(f"    -  Step  already  finalized,  next  step  will  be  created  automatically")
                lines.append(f"    -  View  all  workflows:  {CMD_BRANCH}")
                lines.append(f"    -  Switch  workflow:  {CMD_CHECKOUT}  <workflow>")

                return  "\n".join(lines)

        except  Exception  as  e:
                import  traceback
                return  f"❌  Error:  {str(e)}\n\n{traceback.format_exc()}"


async  def  switch_workflow(
        workflow_identifier:  str,
        workspace_path:  Optional[str]  =  None
)  ->  str:
        """
        切换活动工作流（Git  风格格式，类似  git  checkout）。

        Args:
                workflow_identifier:  工作流  ID  或标题（支持模糊匹配）
                workspace_path:  工作空间路径

        Returns:
                格式化的文本输出
        """
        try:
                from  pathlib  import  Path
                workspace  =  Path(workspace_path)  if  workspace_path  else  None

                switch_result  =  WorkflowContext.switch_workflow(workflow_identifier,  workspace)

                if  not  switch_result  or  not  switch_result.get("success"):
                        lines  =  []
                        message  =  (switch_result  or  {}).get("message")  or  f"Workflow  not  found:  '{workflow_identifier}'"
                        lines.append(f"❌  {message}\n")

                        matches  =  (switch_result  or  {}).get("matches")  or  []

                        if  matches:
                                lines.append("Possible  matches:")
                                for  i,  wf  in  enumerate(matches,  1):
                                        template_name  =  {"bugfix":  "Bug修复",  "standard":  "标准开发",  "feature":  "功能开发"}.get(
                                                wf.get("template",  ""),  wf.get("template",  "")
                                        )
                                        lines.append(f"    {i}.  {wf['title']:<30}    {template_name}")
                                lines.append("\n💡  指定更精确的名称或 ID 再试一次")
                        else:
                                all_workflows  =  WorkflowContext.list_all_workflows(workspace)
                                if  all_workflows:
                                        lines.append("Available  workflows:")
                                        for  i,  wf  in  enumerate(all_workflows,  1):
                                                template_name  =  {"bugfix":  "Bug修复",  "standard":  "标准开发",  "feature":  "功能开发"}.get(
                                                        wf.get("template",  ""),  wf.get("template",  "")
                                                )
                                                lines.append(f"    {i}.  {wf['title']:<30}    {template_name}")

                                lines.append("\n💡  Use  {CMD_BRANCH}  to  see  all  workflows")
                                lines.append("💡  Try:  {CMD_CHECKOUT}  <workflow_title>")

                        return  "\n".join(lines)

                new_workflow  =  switch_result.get("workflow")

                if  not  new_workflow:
                        return  f"❌  Unexpected  error:  missing  workflow  data"

                #  切换成功，显示新工作流状态
                lines  =  []
                lines.append(f"Switched  to  workflow  '{new_workflow['title']}'\n")

                #  显示工作流信息
                template_name  =  {"bugfix":  "Bug修复",  "standard":  "标准开发",  "feature":  "功能开发"}.get(
                        new_workflow.get("template",  ""),  new_workflow.get("template",  "")
                )
                lines.append(f"📦  {template_name}:  {new_workflow['title']}")
                lines.append(f"Template:  {new_workflow['template']}")

                #  显示步骤概览
                steps  =  new_workflow.get('steps',  {})
                if  steps:
                        lines.append(f"Progress:  {len(steps)}  steps  configured")

                        lines.append("\nSteps:")
                        for  step_name,  node_id  in  steps.items():
                                if  node_id:
                                        node  =  GraphCRUD.get_node_by_id(node_id)
                                        if  node:
                                                icon  =  "✅"  if  not  node.is_draft  else  "📝"
                                                lines.append(f"    {icon}  {step_name:<12}  {node.label}")
                                        else:
                                                lines.append(f"    ⚪  {step_name:<12}  (not  found)")
                                else:
                                        lines.append(f"    ⚪  {step_name:<12}  (not  created  yet)")

                #  当前步骤
                current_step  =  new_workflow.get('current_step')
                if  current_step:
                        lines.append(f"\n→  Current  step:  {current_step}")

                #  下一步建议
                lines.append("\n💡  Next  actions:")
                lines.append("    -  View  status:  {CMD_STATUS}")
                if  current_step:
                        lines.append(f"    -  Work  on  current  step:  Just  tell  me  what  to  do")
                        lines.append(f"    -  Finalize  step:  /ads.commit  {current_step}")

                return  "\n".join(lines)

        except  Exception  as  e:
                return  f"❌  Error:  {str(e)}"


async  def  get_step_node(
        step_name:  str,
        workspace_path:  Optional[str]  =  None
)  ->  str:
        """
        通过步骤名称获取节点信息。

        Args:
                step_name:  步骤名称（如  report,  analysis,  fix,  verify）
                workspace_path:  工作空间路径

        Returns:
                JSON  格式的节点信息
        """
        try:
                from  pathlib  import  Path
                workspace  =  Path(workspace_path)  if  workspace_path  else  None

                workflow  =  WorkflowContext.get_active_workflow(workspace)
                if  not  workflow:
                        return  json.dumps({
                                "error":  "没有活动的工作流"
                        },  ensure_ascii=False,  indent=2)

                node_id  =  WorkflowContext.get_workflow_step_node_id(step_name,  workflow,  workspace)
                if  not  node_id:
                        available_steps  =  list(workflow.get("steps",  {}).keys())
                        return  json.dumps({
                                "error":  f"步骤  '{step_name}'  不存在",
                                "available_steps":  available_steps
                        },  ensure_ascii=False,  indent=2)

                #  获取节点详细信息
                node  =  GraphCRUD.get_node_by_id(node_id)
                if  not  node:
                        return  json.dumps({
                                "error":  f"节点  {node_id}  不存在"
                        },  ensure_ascii=False,  indent=2)

                #  获取父节点（用于上下文）
                parents  =  GraphCRUD.get_parent_nodes(node_id,  recursive=True)

                #  读取项目规则（如果存在）
                rules_notice  =  ""
                try:
                        from  .  import  rules  as  rules_module
                        rules_content  =  await  rules_module.read_rules(str(workspace)  if  workspace  else  None)
                        if  rules_content  and  "error"  not  in  rules_content:
                                rules_notice  =  "\n\n⚠️  **请遵守项目规则**  -  使用  read_rules  工具查看完整规则"
                except:
                        pass

                return  json.dumps({
                        "node":  {
                                "id":  node.id,
                                "type":  node.type,
                                "label":  node.label,
                                "content":  node.content,
                                "is_draft":  node.is_draft,
                                "draft_content":  node.draft_content  if  node.is_draft  else  None,
                                "current_version":  node.current_version  or  0,
                                "created_at":  node.created_at.isoformat()  if  node.created_at  else  None,
                                "updated_at":  node.updated_at.isoformat()  if  node.updated_at  else  None
                        },
                        "step_name":  step_name,
                        "workflow":  {
                                "title":  workflow["title"],
                                "template":  workflow["template"]
                        },
                        "parents":  [
                                {
                                        "id":  p.id,
                                        "type":  p.type,
                                        "label":  p.label,
                                        "content":  p.content
                                }
                                for  p  in  parents
                        ],
                        "rules_notice":  rules_notice.strip()
                },  ensure_ascii=False,  indent=2)

        except  Exception  as  e:
                import  traceback
                return  json.dumps({
                        "error":  str(e),
                        "traceback":  traceback.format_exc()
                },  ensure_ascii=False)


async  def  update_step_draft(
        step_name:  str,
        content:  str,
        workspace_path:  Optional[str]  =  None
)  ->  str:
        """
        更新工作流步骤的草稿内容。

        Args:
                step_name:  步骤名称
                content:  新内容
                workspace_path:  工作空间路径

        Returns:
                JSON  格式的更新结果
        """
        try:
                from  pathlib  import  Path
                from  datetime  import  datetime
                workspace  =  Path(workspace_path)  if  workspace_path  else  None

                workflow  =  WorkflowContext.get_active_workflow(workspace)
                if  not  workflow:
                        return  json.dumps({
                                "error":  "没有活动的工作流"
                        },  ensure_ascii=False,  indent=2)

                node_id  =  WorkflowContext.get_workflow_step_node_id(step_name,  workflow,  workspace)
                if  not  node_id:
                        return  json.dumps({
                                "error":  f"步骤  '{step_name}'  不存在"
                        },  ensure_ascii=False,  indent=2)

                #  更新节点草稿
                from  ...storage.database  import  get_db
                from  ...graph.models  import  Node

                with  get_db()  as  db:
                        node  =  db.query(Node).filter(Node.id  ==  node_id).first()
                        if  not  node:
                                return  json.dumps({
                                        "error":  f"节点  {node_id}  不存在"
                                },  ensure_ascii=False,  indent=2)

                        #  更新草稿
                        node.draft_content  =  content
                        node.is_draft  =  True
                        node.draft_updated_at  =  datetime.now()

                        #  判断草稿来源
                        if  not  node.draft_source_type:
                                if  node.current_version  ==  0  or  not  node.current_version:
                                        node.draft_source_type  =  "manual_created"
                                else:
                                        node.draft_source_type  =  "manual_modified"
                                        node.draft_based_on_version  =  node.current_version

                        db.commit()

                #  更新当前步骤
                WorkflowContext.update_current_step(step_name,  workspace)

                return  json.dumps({
                        "success":  True,
                        "step_name":  step_name,
                        "node_id":  node_id,
                        "message":  f"已更新步骤  '{step_name}'  的草稿内容"
                },  ensure_ascii=False,  indent=2)

        except  Exception  as  e:
                import  traceback
                return  json.dumps({
                        "error":  str(e),
                        "traceback":  traceback.format_exc()
                },  ensure_ascii=False)


async  def  finalize_step(
        step_name:  str,
        change_description:  Optional[str]  =  None,
        workspace_path:  Optional[str]  =  None
)  ->  str:
        """
        定稿工作流步骤并触发自动流转（Git  风格格式，类似  git  commit）。

        Args:
                step_name:  步骤名称
                change_description:  变更描述（可选）
                workspace_path:  工作空间路径

        Returns:
                格式化的文本输出
        """
        try:
                from  pathlib  import  Path
                workspace  =  Path(workspace_path)  if  workspace_path  else  None

                workflow  =  WorkflowContext.get_active_workflow(workspace)
                if  not  workflow:
                        return  "❌  没有活动的工作流\n\n💡  Use  {CMD_NEW}  <type>  <title>  to  create  one"

                node_id  =  WorkflowContext.get_workflow_step_node_id(step_name,  workflow,  workspace)
                if  not  node_id:
                        available_steps  =  list(workflow.get("steps",  {}).keys())
                        return  f"❌  步骤  '{step_name}'  不存在\n\n可用步骤:  {',  '.join(available_steps)}"

                #  定稿节点
                from  ...graph.finalize_helper  import  (
                        validate_node_for_finalization,
                        create_node_version,
                        update_node_content,
                        clear_draft
                )
                from  ...graph.file_manager  import  WorkflowFileManager
                from  ...graph.auto_workflow  import  AutoWorkflowEngine
                from  ...storage.database  import  get_db

                result  =  {}
                with  get_db()  as  db:
                        #  验证和定稿
                        node  =  validate_node_for_finalization(db,  node_id)
                        version,  new_version  =  create_node_version(db,  node,  change_description)
                        update_node_content(node,  new_version)
                        clear_draft(node)

                        #  保存到文件
                        file_path  =  WorkflowFileManager.save_node_to_file(node,  workspace)
                        result["file_saved"]  =  str(file_path)  if  file_path  else  None

                        db.commit()

                        #  触发自动工作流
                        engine  =  AutoWorkflowEngine()
                        workflow_result  =  engine.on_node_finalized(node.id)
                        result["workflow"]  =  workflow_result

                #  获取定稿后的节点信息
                finalized_node  =  GraphCRUD.get_node_by_id(node_id)
                if  not  finalized_node:
                        return  f"❌  定稿失败：节点  {node_id}  不存在"

                #  构建  Git  commit  风格输出
                lines  =  []
                lines.append(f"✅  Committed  '{step_name}'  as  v{finalized_node.current_version}")

                #  显示保存的文件
                if  result.get("file_saved"):
                        lines.append(f"\n📁  Saved  to:  {result['file_saved']}")

                #  更新当前步骤（如果创建了新节点，切换到新节点对应的步骤）
                next_step_name  =  None
                if  result.get("workflow")  and  result["workflow"].get("node_id"):
                        new_node_id  =  result["workflow"]["node_id"]
                        new_node  =  GraphCRUD.get_node_by_id(new_node_id)

                        if  new_node:
                                #  查找新节点对应的步骤名称
                                template  =  workflow["template"]
                                step_mapping  =  WorkflowContext.STEP_MAPPINGS.get(template,  {})
                                for  sn,  nt  in  step_mapping.items():
                                        if  nt  ==  new_node.type:
                                                next_step_name  =  sn
                                                #  记录新步骤到  context.json
                                                WorkflowContext.add_workflow_step(sn,  new_node_id,  workspace)
                                                break

                #  显示工作流进度
                updated_workflow  =  WorkflowContext.get_active_workflow(workspace)
                if  updated_workflow:
                        lines.append("\n🔄  Workflow  Progress:")

                        steps_dict  =  updated_workflow.get('steps',  {})
                        template  =  updated_workflow.get('template',  '')
                        step_mapping  =  WorkflowContext.STEP_MAPPINGS.get(template,  {})
                        step_order  =  list(step_mapping.keys())

                        for  sn  in  step_order:
                                node_id  =  steps_dict.get(sn)

                                if  not  node_id:
                                        lines.append(f"    ⚪  {sn:<12}  (not  created  yet)")
                                        continue

                                node  =  GraphCRUD.get_node_by_id(node_id)
                                if  not  node:
                                        lines.append(f"    ⚪  {sn:<12}  (not  found)")
                                        continue

                                is_draft  =  node.is_draft
                                current_version  =  node.current_version  or  0
                                label  =  node.label

                                if  not  is_draft:
                                        #  已定稿
                                        icon  =  "✅"
                                        if  current_version  >  0:
                                                status_text  =  f"(v{current_version})"
                                        else:
                                                status_text  =  "(finalized)"
                                        #  标记刚刚定稿的
                                        if  sn  ==  step_name:
                                                status_text  +=  "  ←  Just  committed"
                                elif  is_draft:
                                        icon  =  "📝"
                                        status_text  =  "(draft)"
                                        #  标记新创建的
                                        if  sn  ==  next_step_name:
                                                status_text  +=  "  ←  Newly  created"
                                else:
                                        icon  =  "⚪"
                                        status_text  =  "(empty)"

                                lines.append(f"    {icon}  {sn:<12}  {label}  {status_text}")

                #  下一步提示
                if  next_step_name:
                        lines.append(f"\n🎯  Next  Step:  {next_step_name}")
                        lines.append(f"\nThe  '{next_step_name}'  step  has  been  created  with  a  template.")
                        lines.append("\n💡  What  would  you  like  to  do?")
                        lines.append(f"    -  Start  working  on  {next_step_name}:  Let's  discuss  the  approach")
                        lines.append(f"    -  Review  what  we  just  committed:  Show  me  the  {step_name}  content")
                        lines.append("    -  See  full  status:  {CMD_STATUS}")
                else:
                        #  工作流完成
                        lines.append("\n🎉  Workflow  Complete!  All  steps  finalized.")
                        lines.append("\n💡  What's  next?")
                        lines.append("    -  Start  a  new  workflow:  {CMD_NEW}  <type>  <title>")
                        lines.append("    -  Review  this  workflow:  {CMD_STATUS}")
                        lines.append("    -  Switch  to  another  workflow:  {CMD_CHECKOUT}  <workflow>")

                return  "\n".join(lines)

        except  Exception  as  e:
                import  traceback
                return  f"❌  Error:  {str(e)}\n\n{traceback.format_exc()}"


async  def  list_workflows(workspace_path:  Optional[str]  =  None,  limit:  int  =  5)  ->  str:
        """
        列出所有工作流（类似  git  branch）。

        显示所有工作流，标记活动工作流，显示序号便于删除操作。

        Args:
                workspace_path:  工作空间路径
                limit:  最多显示多少个工作流（默认  5）

        Returns:
                格式化的工作流列表
        """
        try:
                workspace  =  Path(workspace_path)  if  workspace_path  else  WorkspaceDetector.detect()

                #  获取活动工作流
                active  =  WorkflowContext.get_active_workflow(workspace)
                active_id  =  active.get("workflow_id")  if  active  else  None

                #  查找所有工作流根节点
                all_nodes  =  GraphCRUD.get_all_nodes()

                #  找出所有工作流根节点（没有入边的节点）
                workflow_roots  =  []
                for  node  in  all_nodes:
                        incoming_edges  =  [e  for  e  in  GraphCRUD.get_all_edges()  if  e.target  ==  node.id]
                        if  not  incoming_edges:
                                workflow_roots.append(node)

                if  not  workflow_roots:
                        return  """❌  没有工作流

💡  创建新工作流:  {CMD_NEW}  <type>  <title>

可用类型:
    -  bugfix:  Bug  修复工作流
    -  feature:  快速功能开发
    -  standard:  标准  DDD  开发流程"""

                #  限制显示数量
                total_workflows  =  len(workflow_roots)
                displayed_roots  =  workflow_roots[:limit]
                remaining  =  total_workflows  -  len(displayed_roots)

                #  格式化输出
                lines  =  []
                lines.append(f"📋  工作流列表  ({workspace})\n")

                for  i,  node  in  enumerate(displayed_roots,  1):
                        #  标记活动工作流
                        marker  =  "*"  if  node.id  ==  active_id  else  "  "

                        #  统计节点信息
                        def  count_nodes(root_id):
                                nodes  =  [root_id]
                                edges  =  GraphCRUD.get_edges_from_node(root_id)
                                for  edge  in  edges:
                                        nodes.extend(count_nodes(edge.target))
                                return  list(set(nodes))

                        all_node_ids  =  count_nodes(node.id)
                        total  =  len(all_node_ids)

                        #  统计已定稿的节点
                        finalized  =  0
                        for  nid  in  all_node_ids:
                                n  =  GraphCRUD.get_node_by_id(nid)
                                if  n  and  not  n.is_draft:
                                        finalized  +=  1

                        percent  =  int(finalized  /  total  *  100)  if  total  >  0  else  0
                        status  =  f"({finalized}/{total}  nodes,  {percent}%"
                        if  percent  ==  100:
                                status  +=  "  ✓"
                        status  +=  ")"

                        lines.append(f"    {marker}  {i}.  {node.label:<30}  {status}")

                lines.append(f"\n✓  {len(displayed_roots)}/{total_workflows}  个工作流")

                if  remaining  >  0:
                        lines.append(f"    ({remaining}  more  not  shown)")

                if  active_id:
                        active_node  =  GraphCRUD.get_node_by_id(active_id)
                        if  active_node:
                                lines.append(f"*  活动:  {active_node.label}")

                lines.append("\n💡  操作提示:")
                lines.append("    {CMD_BRANCH}                      列出工作流")
                lines.append("    {CMD_BRANCH}  -d  <N>        删除工作流（已完成）")
                lines.append("    {CMD_BRANCH}  -D  <N>        强制删除工作流")
                lines.append("    {CMD_CHECKOUT}  <N>          切换工作流")

                return  "\n".join(lines)

        except  Exception  as  e:
                import  traceback
                return  f"❌  Error:  {str(e)}\n\n{traceback.format_exc()}"


async  def  delete_workflow(workflow_id:  str,  workspace_path:  Optional[str]  =  None,  force:  bool  =  False)  ->  str:
        """
        删除工作流（类似  git  branch  -d/-D）。

        删除工作流的所有节点、边和文件。

        Args:
                workflow_id:  工作流序号、根节点  ID  或标题（支持模糊匹配）
                workspace_path:  工作空间路径
                force:  是否强制删除（-D），False  表示安全删除（-d）

        Returns:
                格式化的删除结果
        """
        try:
                workspace  =  Path(workspace_path)  if  workspace_path  else  WorkspaceDetector.detect()

                #  获取活动工作流
                active  =  WorkflowContext.get_active_workflow(workspace)
                active_id  =  active.get("workflow_id")  if  active  else  None

                #  查找所有工作流根节点
                all_nodes  =  GraphCRUD.get_all_nodes()

                #  找出所有工作流根节点（没有入边的节点）
                workflow_roots  =  []
                for  node  in  all_nodes:
                        incoming_edges  =  [e  for  e  in  GraphCRUD.get_all_edges()  if  e.target  ==  node.id]
                        if  not  incoming_edges:
                                workflow_roots.append(node)

                #  查找目标工作流
                root_node  =  None

                #  1.  尝试按序号查找
                if  workflow_id.isdigit():
                        index  =  int(workflow_id)  -  1    #  序号从  1  开始
                        if  0  <=  index  <  len(workflow_roots):
                                root_node  =  workflow_roots[index]

                #  2.  尝试按  ID  精确匹配
                if  not  root_node:
                        root_node  =  GraphCRUD.get_node_by_id(workflow_id)

                #  3.  尝试按标题模糊匹配
                if  not  root_node:
                        for  node  in  workflow_roots:
                                if  workflow_id.lower()  in  node.label.lower():
                                        root_node  =  node
                                        break

                if  not  root_node:
                        return  f"❌  工作流不存在:  {workflow_id}\n\n💡  使用  {CMD_BRANCH}  查看所有工作流"

                #  检查是否是活动工作流
                is_active  =  (root_node.id  ==  active_id)

                if  is_active  and  not  force:
                        return  f"""❌  无法删除活动工作流

工作流  '{root_node.label}'  当前是活动工作流。

💡  选项:
    1.  切换到其他工作流:  {CMD_CHECKOUT}  <other_workflow>
    2.  强制删除:  {CMD_BRANCH}  -D  {workflow_id}

⚠️    强制删除将清除当前工作上下文！"""

                #  获取所有相关节点（包括根节点和所有子节点）
                def  get_all_downstream_nodes(node_id:  str)  ->  list:
                        """递归获取所有下游节点"""
                        nodes  =  [node_id]
                        edges  =  GraphCRUD.get_edges_from_node(node_id)
                        for  edge  in  edges:
                                nodes.extend(get_all_downstream_nodes(edge.target))
                        return  list(set(nodes))    #  去重

                #  检查工作流是否已完成（-d  安全删除模式）
                if  not  force:
                        all_related_node_ids  =  get_all_downstream_nodes(root_node.id)

                        #  检查是否所有节点都已定稿
                        has_draft  =  False
                        for  node_id  in  all_related_node_ids:
                                node  =  GraphCRUD.get_node_by_id(node_id)
                                if  node  and  node.is_draft:
                                        has_draft  =  True
                                        break

                        if  has_draft:
                                return  f"""❌  工作流未完成，无法安全删除

工作流  '{root_node.label}'  还有未定稿的节点。

💡  选项:
    1.  完成所有节点后删除:  使用  /ads.finalize  定稿所有步骤
    2.  强制删除:  {CMD_BRANCH}  -D  {workflow_id}

⚠️    -d  (安全删除)  只能删除已完成的工作流
⚠️    -D  (强制删除)  可删除任何工作流"""

                all_node_ids  =  get_all_downstream_nodes(root_node.id)

                #  删除数据库中的节点和边
                deleted_nodes  =  0
                deleted_edges  =  0

                for  node_id  in  all_node_ids:
                        #  删除相关的边
                        edges  =  GraphCRUD.get_edges_from_node(node_id)
                        for  edge  in  edges:
                                if  GraphCRUD.delete_edge(edge.id):
                                        deleted_edges  +=  1

                        #  删除节点
                        if  GraphCRUD.delete_node(node_id):
                                deleted_nodes  +=  1

                #  删除文件系统中的  spec  目录
                specs_dir  =  WorkspaceDetector.get_workspace_specs_dir(workspace)
                workflow_spec_dir  =  specs_dir  /  root_node.id

                if  workflow_spec_dir.exists():
                        shutil.rmtree(workflow_spec_dir)
                        spec_deleted  =  True
                else:
                        spec_deleted  =  False

                #  如果是活动工作流，清除  context
                if  is_active:
                        WorkflowContext.clear_active_workflow(workspace)

                return  f"""✅  工作流已删除

📋  **删除信息**
-  工作流:  {root_node.label}
-  ID:  {root_node.id}
-  删除节点:  {deleted_nodes}  个
-  删除边:  {deleted_edges}  个
-  删除文件:  {'是'  if  spec_deleted  else  '否'}
{'  -  已清除活动工作流'  if  is_active  else  ''}

💡  **提示**:  使用  {CMD_BRANCH}  查看剩余工作流
"""

        except  Exception  as  e:
                import  traceback
                return  f"❌  Error:  {str(e)}\n\n{traceback.format_exc()}"
