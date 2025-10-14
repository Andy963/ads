"""
规则相关的 MCP 工具

提供读取和管理项目规则的功能。
"""

import json
from pathlib import Path
from typing import Optional, Dict, Any, List

from ...workspace.detector import WorkspaceDetector


async def read_rules(workspace_path: Optional[str] = None) -> str:
    """
    读取合并后的规则（模板规则 + 工作空间自定义规则）。

    Args:
        workspace_path: 工作空间路径，默认为当前目录

    Returns:
        Markdown 格式的完整规则内容
    """
    try:
        # 获取工作空间路径
        if workspace_path:
            ws_path = Path(workspace_path)
        else:
            ws_path = WorkspaceDetector.detect()

        # 1. 读取工作空间规则（如果存在）
        workspace_rules_file = ws_path / ".ads" / "rules.md"
        
        if workspace_rules_file.exists():
            # 工作空间已有规则文件，直接读取
            content = workspace_rules_file.read_text(encoding='utf-8')
            
            result = {
                "source": "workspace",
                "path": str(workspace_rules_file),
                "content": content,
                "note": "工作空间自定义规则（可编辑 .ads/rules.md）"
            }
        else:
            # 工作空间未初始化，读取模板规则
            template_rules_file = Path(__file__).parent.parent.parent / "templates" / "rules.md"
            
            if template_rules_file.exists():
                content = template_rules_file.read_text(encoding='utf-8')
                
                result = {
                    "source": "template",
                    "path": str(template_rules_file),
                    "content": content,
                    "note": "默认模板规则（运行 'ads init' 来创建可编辑的工作空间规则）"
                }
            else:
                # 模板也不存在，返回错误
                return json.dumps({
                    "error": "规则文件不存在",
                    "message": "请运行 'ads init' 初始化工作空间，或检查 ADS 安装是否完整"
                }, ensure_ascii=False, indent=2)

        # 格式化返回
        return f"""# 项目规则

**来源**: {result['source']}
**路径**: {result['path']}
**说明**: {result['note']}

---

{result['content']}
"""

    except Exception as e:
        return json.dumps({
            "error": str(e),
            "workspace_path": str(workspace_path) if workspace_path else "auto-detect"
        }, ensure_ascii=False, indent=2)


async def list_rules(
    workspace_path: Optional[str] = None,
    category: Optional[str] = None
) -> str:
    """
    列出所有规则项（解析规则文档中的规则）。

    Args:
        workspace_path: 工作空间路径
        category: 规则分类筛选（如 "禁止规则"）

    Returns:
        JSON 格式的规则列表
    """
    try:
        # 读取规则内容
        rules_content = await read_rules(workspace_path)
        
        # 如果是错误，直接返回
        if rules_content.startswith('{') and '"error"' in rules_content:
            return rules_content

        # 解析规则（简单解析 Markdown 标题）
        rules = []
        lines = rules_content.split('\n')
        
        current_category = None
        current_rule = None
        
        for line in lines:
            # 一级标题：分类
            if line.startswith('## '):
                current_category = line[3:].strip()
                
            # 三级标题：规则
            elif line.startswith('### '):
                if current_rule:
                    rules.append(current_rule)
                
                rule_title = line[4:].strip()
                current_rule = {
                    "title": rule_title,
                    "category": current_category,
                    "priority": "critical" if "禁止" in (current_category or "") else "normal",
                    "description": ""
                }
                
            # 规则描述内容
            elif current_rule and line.startswith('**规则**:'):
                current_rule["description"] = line[8:].strip()
        
        # 添加最后一个规则
        if current_rule:
            rules.append(current_rule)
        
        # 按分类筛选
        if category:
            rules = [r for r in rules if category.lower() in (r.get("category") or "").lower()]
        
        result = {
            "total": len(rules),
            "rules": rules
        }
        
        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "error": str(e)
        }, ensure_ascii=False, indent=2)


async def check_rule_violation(
    operation: str,
    details: Dict[str, Any],
    workspace_path: Optional[str] = None
) -> str:
    """
    检查操作是否违反规则。

    Args:
        operation: 操作类型（如 "delete_database", "git_commit", "create_doc"）
        details: 操作详情
        workspace_path: 工作空间路径

    Returns:
        JSON 格式的检查结果
    """
    try:
        # 定义规则检查逻辑
        violations = []
        
        # 规则 1: 禁止删除数据库文件
        if operation == "delete_file":
            file_path = details.get("file_path", "")
            if any(ext in file_path for ext in [".db", ".sqlite", ".sqlite3", "index.json"]):
                violations.append({
                    "rule": "禁止删除数据库文件",
                    "severity": "critical",
                    "message": f"不得删除数据库文件: {file_path}",
                    "action": "stop"
                })
        
        # 规则 2: 禁止自动提交
        if operation == "git_commit":
            if not details.get("user_explicit_request", False):
                violations.append({
                    "rule": "禁止自动提交",
                    "severity": "critical",
                    "message": "Git 提交需要用户明确授权",
                    "action": "ask_user"
                })
        
        # 规则 3: 禁止 Co-authored-by
        if operation == "git_commit":
            commit_message = details.get("message", "")
            if "Co-authored-by" in commit_message:
                violations.append({
                    "rule": "禁止写入 Co-authored-by 标签",
                    "severity": "critical",
                    "message": "Git commit message 不得包含 Co-authored-by",
                    "action": "remove"
                })
        
        # 规则 4: 禁止在 docs/ 外创建文档
        if operation == "create_file" and details.get("is_documentation", False):
            file_path = Path(details.get("file_path", ""))
            if not str(file_path).startswith("docs/") and file_path.name != "README.md":
                violations.append({
                    "rule": "禁止在 docs/ 目录外创建文档",
                    "severity": "warning",
                    "message": f"文档应放在 docs/ 目录下，而不是 {file_path}",
                    "action": "suggest_move"
                })
        
        # 规则 5: 禁止在根目录创建脚本
        if operation == "create_file":
            file_path = Path(details.get("file_path", ""))
            if (
                file_path.parent == Path(".") and
                file_path.suffix in [".py", ".js", ".sh"] and
                file_path.name not in ["README.md", "setup.py", "pyproject.toml"]
            ):
                violations.append({
                    "rule": "禁止在根目录下随意创建脚本",
                    "severity": "warning",
                    "message": f"脚本文件应放在 scripts/ 或 tests/ 目录，而不是根目录: {file_path}",
                    "action": "suggest_move"
                })
        
        # 返回结果
        result = {
            "operation": operation,
            "allowed": len(violations) == 0,
            "violations": violations,
            "details": details
        }
        
        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "error": str(e)
        }, ensure_ascii=False, indent=2)
