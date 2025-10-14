"""
Workflow-related MCP tools.
"""

import json
from typing import Optional, List, Dict, Any

from ...graph.workflow_config import WorkflowRulesConfig
from ...graph.auto_workflow import AutoWorkflowEngine


def get_guidance_for_node_type(node_type: str, title: str) -> Dict[str, Any]:
    """
    获取节点类型的引导信息
    
    返回 AI 应该如何引导用户收集需求的指令
    """
    guidance_templates = {
        "bug_report": {
            "message": f"已创建 Bug 修复工作流 '{title}'。现在需要收集详细的 Bug 信息。",
            "questions": [
                "1. **问题描述**：这个 bug 具体是什么？发生了什么问题？",
                "2. **复现步骤**：如何一步步复现这个问题？请列出详细步骤。",
                "3. **期望行为**：正常情况下应该是什么样的？",
                "4. **实际行为**：实际发生了什么？有报错信息吗？",
                "5. **影响范围**：这个 bug 影响哪些功能或用户？",
                "6. **优先级**：这个问题的紧急程度？(High/Medium/Low)"
            ],
            "instruction": "请逐个询问用户以上问题。用户回答后，将信息整理成结构化的内容，然后展示给用户确认。用户满意后，使用 update_node 更新节点内容。"
        },
        "requirement": {
            "message": f"已创建需求分析工作流 '{title}'。现在需要收集详细的功能需求。",
            "questions": [
                "1. **功能概述**：这个功能要解决什么问题？目标是什么？",
                "2. **目标用户**：谁会使用这个功能？",
                "3. **核心功能**：需要哪些核心功能？请列出主要功能点。",
                "4. **使用场景**：用户在什么情况下会使用？请描述2-3个典型场景。",
                "5. **约束条件**：有什么技术限制、性能要求或业务约束吗？",
                "6. **验收标准**：如何判断这个功能做好了？"
            ],
            "instruction": "请逐个询问用户以上问题。收集完整后，将需求整理成结构化文档，展示给用户确认。用户满意后，使用 update_node 更新节点内容。"
        },
        "aggregate": {
            "message": f"已创建 DDD 设计工作流 '{title}'。现在需要明确聚合根的业务概念。",
            "questions": [
                "1. **业务概念**：这个聚合根代表什么业务概念？",
                "2. **业务边界**：它负责处理哪些业务逻辑？",
                "3. **核心属性**：有哪些关键的业务属性？",
                "4. **业务规则**：有什么重要的业务规则或约束？",
                "5. **关联关系**：与其他聚合根有什么关系？"
            ],
            "instruction": "请逐个询问用户以上问题。收集完整后，将领域概念整理成结构化文档，展示给用户确认。用户满意后，使用 update_node 更新节点内容。"
        },
        "feature": {
            "message": f"已创建快速功能开发工作流 '{title}'。现在需要了解功能详情。",
            "questions": [
                "1. **功能描述**：这个功能具体要做什么？",
                "2. **核心需求**：最核心的需求是什么？必须实现哪些功能？",
                "3. **使用场景**：用户如何使用这个功能？请描述主要使用流程。",
                "4. **技术要求**：有特定的技术栈或架构要求吗？",
                "5. **时间要求**：有截止日期或里程碑吗？"
            ],
            "instruction": "请逐个询问用户以上问题。收集完整后，将功能需求整理成结构化文档，展示给用户确认。用户满意后，使用 update_node 更新节点内容。"
        },
        "design": {
            "message": f"已创建设计工作流 '{title}'。现在需要收集设计要求。",
            "questions": [
                "1. **设计目标**：这次设计要达到什么目的？",
                "2. **技术选型**：需要使用什么技术栈？",
                "3. **架构考虑**：有什么架构层面的考虑？",
                "4. **接口定义**：需要定义哪些接口或API？",
                "5. **数据模型**：涉及哪些数据模型？"
            ],
            "instruction": "请逐个询问用户以上问题。收集完整后，将设计方案整理成结构化文档，展示给用户确认。用户满意后，使用 update_node 更新节点内容。"
        }
    }
    
    # 如果有预定义的引导，返回
    if node_type in guidance_templates:
        return guidance_templates[node_type]
    
    # 默认引导
    return {
        "message": f"已创建工作流 '{title}'。现在需要收集详细信息。",
        "questions": [
            "1. **背景**：请描述一下背景和上下文？",
            "2. **目标**：要达到什么目标？",
            "3. **详细说明**：请详细说明具体内容。"
        ],
        "instruction": "请询问用户以上问题。收集完整后，将信息整理成文档，展示给用户确认。用户满意后，使用 update_node 更新节点内容。"
    }


async def list_workflow_templates() -> str:
    """
    列出所有工作流模板。

    返回 JSON 格式的模板列表。
    """
    try:
        config = WorkflowRulesConfig()
        templates = config.get_all_workflow_templates()

        result = {
            "templates": [
                {
                    "id": template_id,
                    "name": template.name if hasattr(template, 'name') else template_id,
                    "description": template.description if hasattr(template, 'description') else "",
                    "steps": len(template.steps) if hasattr(template, 'steps') else 0
                }
                for template_id, template in templates.items()
            ]
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


async def get_workflow_template(template_id: str) -> str:
    """
    获取工作流模板详情。

    返回 JSON 格式的完整模板定义。
    """
    try:
        config = WorkflowRulesConfig()
        template = config.get_workflow_template(template_id)

        if not template:
            return json.dumps(
                {"error": f"模板不存在: {template_id}"},
                ensure_ascii=False
            )

        # 返回完整模板 - 将 Pydantic 模型转换为字典
        template_dict = template.model_dump() if hasattr(template, 'model_dump') else template.dict()
        return json.dumps(template_dict, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


async def get_node_type_config(node_type: str) -> str:
    """
    获取节点类型配置。

    返回 JSON 格式的节点类型信息。
    """
    try:
        config = WorkflowRulesConfig()
        node_config = config.get_node_config(node_type)

        if not node_config:
            return json.dumps(
                {"error": f"节点类型不存在: {node_type}"},
                ensure_ascii=False
            )

        # 将 Pydantic 模型转换为字典
        config_dict = node_config.model_dump() if hasattr(node_config, 'model_dump') else node_config.dict()
        return json.dumps(config_dict, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


async def _get_rules_summary(workspace_path: str) -> str:
    """获取项目规则摘要（禁止规则）"""
    try:
        from . import rules as rules_module
        
        # 读取规则内容
        rules_content = await rules_module.read_rules(workspace_path)
        
        if not rules_content or "error" in rules_content:
            return ""
        
        # 提取 "严格禁止规则" 部分
        lines = rules_content.split('\n')
        summary_lines = []
        in_critical_section = False
        
        for line in lines:
            # 检测严格禁止规则章节
            if '严格禁止规则' in line or '🚫' in line:
                in_critical_section = True
                summary_lines.append("⚠️ **严格禁止规则（违反任一条立即停止）**")
                continue
            
            # 如果遇到下一个一级章节，停止
            if in_critical_section and line.startswith('## ') and '禁止' not in line:
                break
            
            # 提取三级标题（具体规则）
            if in_critical_section and line.startswith('### '):
                rule_title = line.replace('### ', '').strip()
                # 移除数字编号
                if '. ' in rule_title:
                    rule_title = rule_title.split('. ', 1)[1]
                summary_lines.append(f"  • {rule_title}")
        
        return '\n'.join(summary_lines) if len(summary_lines) > 1 else ""
    
    except Exception as e:
        # 规则读取失败不应阻塞工作流创建
        return ""


async def create_workflow_from_template(
    template_id: str,
    title: str,
    description: str = "",
    workspace_path: Optional[str] = None
) -> str:
    """
    从工作流模板创建完整的工作流。

    根据模板配置（workflow_rules.yaml）创建一系列相连的节点，
    这些节点将组织在同一个工作流中，并自动同步到文件系统。

    Args:
        template_id: 模板ID（如 standard, bugfix, feature）
        title: 工作流标题
        description: 工作流描述（可选，作为第一个节点的内容）
        workspace_path: 工作空间路径（可选）

    Returns:
        JSON 格式的创建结果，包含所有创建的节点和边，以及文件同步信息
    """
    try:
        import os
        from pathlib import Path
        from pydantic import BaseModel
        from datetime import datetime
        from ...graph.file_manager import WorkflowFileManager
        from ...graph.crud import GraphCRUD
        from ...workspace.detector import WorkspaceDetector

        # 获取模板配置
        config = WorkflowRulesConfig()
        template = config.get_workflow_template(template_id)

        if not template:
            return json.dumps({
                "error": f"工作流模板不存在: {template_id}",
                "available_templates": list(config.get_all_workflow_templates().keys())
            }, ensure_ascii=False)

        # 构建节点配置列表
        class WorkflowNodeConfig(BaseModel):
            node_type: str
            label_suffix: str
            required: bool

        nodes_config = []
        for step in template.steps:
            # 使用默认选项或第一个选项
            default_opt = step.default_option
            if default_opt:
                option = next((opt for opt in step.options if opt.node_type == default_opt), None)
            else:
                option = step.options[0] if step.options else None

            if option and step.required:
                nodes_config.append(WorkflowNodeConfig(
                    node_type=option.node_type,
                    label_suffix=option.label,
                    required=step.required
                ))

        # 创建工作流
        if not workspace_path:
            workspace_path = os.getcwd()

        # 自动附加项目规则摘要到工作流描述
        enhanced_description = description
        if description:
            enhanced_description += "\n\n---\n\n"

        rules_summary = await _get_rules_summary(workspace_path)
        if rules_summary:
            enhanced_description += f"""## 项目规则约束

{rules_summary}

详细规则请查看 `.ads/rules.md`

---

"""

        # 方案 A: 只创建第一个节点，后续通过 finalize 自动流转
        first_node_config = nodes_config[0:1] if nodes_config else []
        
        result = AutoWorkflowEngine.create_workflow_from_config(
            nodes=first_node_config,  # 只创建第一个节点
            root_label=title,
            root_content=enhanced_description,
            position={"x": 100, "y": 100}
        )

        # 获取根节点 ID（第一个节点）
        root_node_id = result["nodes"][0].id if result["nodes"] else None
        if not root_node_id:
            raise ValueError("工作流创建失败：没有节点被创建")

        # 确保所有节点同步到同一个 spec 目录
        workspace = Path(workspace_path) if workspace_path else None
        specs_base_dir = WorkspaceDetector.get_workspace_specs_dir(workspace)
        spec_dir = specs_base_dir / root_node_id
        spec_dir.mkdir(parents=True, exist_ok=True)

        # 获取节点内容模板
        def get_node_content_template(node_type: str, node_config) -> str:
            """获取节点类型的内容模板"""
            # 内容模板字典
            templates = {
                "bug_report": """## 问题描述

（简要描述这个bug是什么）

## 复现步骤

1. （步骤1）
2. （步骤2）
3. ...

## 期望行为

（正常情况下应该怎样？）

## 实际行为

（实际发生了什么？）

## 影响范围

（这个bug影响哪些功能或用户？）

## 优先级

（High / Medium / Low）

## 环境信息

- 系统版本：
- 浏览器/设备：
- 其他相关信息：
""",
                "bug_analysis": """## 问题根因

（分析这个bug的根本原因）

## 影响范围评估

（详细说明影响的功能、用户、数据等）

## 可能的解决方案

### 方案1：

- 描述：
- 优点：
- 缺点：

### 方案2：

- 描述：
- 优点：
- 缺点：

## 推荐方案

（说明推荐哪个方案及原因）

## 风险评估

（修复可能带来的风险）
""",
                "bug_fix": """## 修复方案

（描述具体的修复方案）

## 修改内容

### 代码修改

- 文件：
- 修改点：
- 具体改动：

### 配置调整

（如有配置需要调整）

### 数据迁移

（如有数据需要迁移）

## 回滚预案

（如果修复失败，如何回滚？）

## 注意事项

（修复过程中需要注意的事项）
""",
                "bug_verify": """## 验证步骤

1. （验证步骤1）
2. （验证步骤2）
3. ...

## 回归测试计划

### 测试用例

- 用例1：
- 用例2：
- ...

### 测试环境

（测试环境要求）

## 验收标准

- [ ] 原问题已修复
- [ ] 无新的bug引入
- [ ] 性能无明显下降
- [ ] 所有相关测试通过

## 验证结果

（记录验证结果）
""",
                "aggregate": """## 领域概念

（这个聚合根代表什么业务概念？）

## 业务边界

（它负责哪些业务规则？）

## 核心实体

- 实体1：
- 实体2：
- ...

## 业务规则

1. （规则1）
2. （规则2）
3. ...

## 聚合操作

- 操作1：
- 操作2：
- ...
""",
                "requirement": """## 功能描述

（这个功能做什么？）

## 用户价值

（为什么需要这个功能？）

## 用户故事

- 作为【角色】，我希望【功能】，以便【价值】
- ...

## 验收标准

- [ ] 标准1
- [ ] 标准2
- ...

## 非功能需求

- 性能要求：
- 安全要求：
- 其他：
""",
                "design": """## 技术架构

（整体技术架构设计）

## 核心模块

### 模块1

- 职责：
- 接口：

### 模块2

- 职责：
- 接口：

## API设计

### 接口1

- 路径：
- 方法：
- 参数：
- 返回：

## 数据模型

（数据库表设计或数据结构设计）

## 关键流程

（关键业务流程的流程图或描述）
""",
                "implementation": """## 技术栈

- 语言/框架：
- 数据库：
- 第三方库：

## 文件结构

```
project/
  ├── module1/
  │   ├── file1.py
  │   └── file2.py
  └── module2/
      └── file3.py
```

## 核心代码要点

### 关键类/方法

（关键代码的说明）

## 实现步骤

1. （步骤1）
2. （步骤2）
3. ...

## 测试策略

（如何测试这个实现）
"""
            }

            # 如果有预定义模板，使用模板
            if node_type in templates:
                return templates[node_type]

            # 否则返回基础模板
            node_cfg = config.get_node_config(node_type)
            return f"""## 概述

（待补充内容）

## 详细说明

（待补充内容）
"""

        # 同步所有节点到文件系统
        synced_files = []
        for i, node_response in enumerate(result["nodes"]):
            # 从数据库重新获取节点对象
            node = GraphCRUD.get_node_by_id(node_response.id)
            if node:
                try:
                    # 构建文件路径（使用统一的 spec_dir）
                    file_path = spec_dir / f"{node.type}.md"

                    # 确定节点内容（第一个节点使用用户提供的 description，其他节点使用模板）
                    if i == 0:
                        node_content = enhanced_description if enhanced_description else get_node_content_template(node.type, nodes_config[i])
                    else:
                        node_content = get_node_content_template(node.type, nodes_config[i])

                    # 如果节点在数据库中没有内容，更新内容
                    if not node.content or node.content.strip() == "":
                        GraphCRUD.update_node(node.id, {"content": node_content})
                        node = GraphCRUD.get_node_by_id(node.id)  # 重新获取更新后的节点

                    # 构建文件内容
                    status = "draft" if node.is_draft else "finalized"
                    file_content = f"""---
id: {node.id}
type: {node.type}
title: {node.label}
status: {status}
created_at: {node.created_at.isoformat() if node.created_at else ''}
updated_at: {node.updated_at.isoformat() if node.updated_at else ''}
---

# {node.label}

{node.content if node.content else '(待补充内容)'}
"""

                    # 写入文件
                    with open(file_path, 'w', encoding='utf-8') as f:
                        f.write(file_content)

                    synced_files.append(str(file_path))
                except Exception as e:
                    print(f"Warning: Failed to sync node {node.id} to file: {e}")

        # 生成工作流索引文件（README.md）
        try:
            # 获取所有节点
            workflow_nodes = [GraphCRUD.get_node_by_id(n.id) for n in result["nodes"]]
            workflow_nodes = [n for n in workflow_nodes if n]  # 过滤 None

            # 节点类型中文名称
            type_names = {
                "bug_report": "🐛 Bug 报告",
                "bug_analysis": "🔍 Bug 分析",
                "bug_fix": "🔧 Bug 修复",
                "bug_verify": "✅ Bug 验证",
                "requirement": "📋 需求分析",
                "design": "📐 领域设计",
                "implementation": "💻 代码实现",
                "test": "🧪 测试验证",
                "aggregate": "📦 聚合根",
            }

            index_path = spec_dir / "README.md"
            root_node = workflow_nodes[0] if workflow_nodes else None

            if root_node:
                index_content = f"""# {root_node.label}

> 自动生成于 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

**工作流 ID**: `{root_node_id}`
**模板类型**: {template.name}
**根节点类型**: {type_names.get(root_node.type, root_node.type)}

## 统计

- 节点数: {len(workflow_nodes)}
- 草稿节点: {sum(1 for n in workflow_nodes if n.is_draft)}
- 已定稿节点: {sum(1 for n in workflow_nodes if not n.is_draft)}

## 节点列表

"""

                for node in workflow_nodes:
                    type_name = type_names.get(node.type, node.type)
                    status_icon = "📝" if node.is_draft else "✅"
                    index_content += f"- {status_icon} [{node.label}](./{node.type}.md)\n"

                with open(index_path, 'w', encoding='utf-8') as f:
                    f.write(index_content)

                synced_files.append(str(index_path))
        except Exception as e:
            print(f"Warning: Failed to generate index: {e}")

        # 自动设置为活动工作流（类似 git branch）
        try:
            from ...workspace.context import WorkflowContext

            # 构建步骤映射
            step_mapping = WorkflowContext.STEP_MAPPINGS.get(template_id, {})
            steps = {}
            for step_name, node_type in step_mapping.items():
                # 查找对应类型的节点
                for node_response in result["nodes"]:
                    node = GraphCRUD.get_node_by_id(node_response.id)
                    if node and node.type == node_type:
                        steps[step_name] = node.id
                        break

            # 设置活动工作流
            WorkflowContext.set_active_workflow(
                workflow_root_id=root_node_id,
                template=template_id,
                title=title,
                steps=steps,
                workspace=workspace
            )
        except Exception as e:
            print(f"Warning: Failed to set active workflow: {e}")

        # 获取第一个节点类型，用于生成引导信息
        first_node = result["nodes"][0] if result["nodes"] else None
        first_node_obj = GraphCRUD.get_node_by_id(first_node.id) if first_node else None
        first_node_type = first_node_obj.type if first_node_obj else "requirement"
        
        # 获取引导信息
        guidance = get_guidance_for_node_type(first_node_type, title)
        
        # 格式化问题列表
        questions_text = "\n".join(guidance["questions"])
        
        return json.dumps({
            "success": True,
            "status": "requirements_collection",  # 状态：需求收集中
            "template": {
                "id": template_id,
                "name": template.name,
                "description": template.description
            },
            "workflow": {
                "title": title,
                "root_node_id": root_node_id,
                "spec_dir": str(spec_dir),
                "nodes_created": len(result["nodes"]),
                "edges_created": len(result["edges"]),
                "is_active": True,
                "current_node": {
                    "id": first_node_obj.id if first_node_obj else None,
                    "type": first_node_type,
                    "label": first_node_obj.label if first_node_obj else None
                }
            },
            "nodes": [
                {
                    "id": node.id,
                    "type": node.type,
                    "label": node.data.get("label", node.id) if hasattr(node, 'data') else node.label
                }
                for node in result["nodes"]
            ],
            "files": {
                "synced": len(synced_files),
                "paths": synced_files
            },
            "guidance": {
                "message": guidance["message"],
                "questions": guidance["questions"],
                "instruction": guidance["instruction"],
                "next_step": f"收集完需求后，使用 update_node 工具更新节点 {first_node_obj.id if first_node_obj else 'N/A'}，然后用户可以使用 finalize_node 定稿并进入下一步。"
            },
            "message": f"""✅ 工作流已创建

📋 **工作流信息**
- 标题: {title}
- 模板: {template.name}
- 节点数: {len(result['nodes'])}
- 当前节点: {first_node_obj.label if first_node_obj else 'N/A'} ({first_node_type})

🎯 **下一步：收集详细需求**

{guidance["message"]}

{questions_text}

📝 **操作说明**
{guidance["instruction"]}

💡 **提示**: 收集完成后，你可以要求修改直到满意，然后告诉我 "确认定稿" 即可进入下一步。
"""
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        import traceback
        return json.dumps({
            "error": str(e),
            "traceback": traceback.format_exc()
        }, ensure_ascii=False)
