"""
工作流节点文件管理器

负责将工作流节点持久化到文件系统。
"""

import os
from pathlib import Path
from typing import Optional
from datetime import datetime

from .models import Node
from .crud import GraphCRUD
from ..workspace.detector import WorkspaceDetector


class WorkflowFileManager:
    """
    工作流文件管理器

    将节点内容持久化到文件系统，使其可以：
    1. 版本控制（git）
    2. 直接编辑
    3. AI 工具读取

    目录结构：
    docs/specs/
        {workflow_root_id}/          # 每个工作流/aggregate 一个目录
            metadata.json             # 工作流元数据
            {node_type}.md            # 节点文件（按类型命名）
            images/                   # 图片目录
    """

    @staticmethod
    def _get_workflow_root_id(node: Node) -> str:
        """
        获取节点所属的工作流根节点 ID。

        如果有 aggregate 父节点，返回 aggregate ID；
        否则返回最顶层的根节点 ID。

        Args:
            node: 节点对象

        Returns:
            工作流根节点 ID
        """
        # 如果节点本身是 aggregate，返回自己的 ID
        if node.type == 'aggregate':
            return node.id

        # 查找所有父节点
        parents = GraphCRUD.get_parent_nodes(node.id, recursive=True)

        # 优先查找 aggregate 节点
        for parent in parents:
            if parent.type == 'aggregate':
                return parent.id

        # 如果没有 aggregate，返回最远的父节点（根节点）
        if parents:
            return parents[-1].id

        # 如果没有父节点，说明当前节点就是根节点
        return node.id

    @staticmethod
    def get_spec_dir(node: Node, workspace_path: Optional[str] = None) -> Path:
        """
        获取节点所属的 spec 目录路径。

        Args:
            node: 节点对象
            workspace_path: 工作空间路径（可选，将自动检测）

        Returns:
            docs/specs/{workflow_root_id}/
        """
        # 使用 WorkspaceDetector 获取 specs 目录
        workspace = Path(workspace_path) if workspace_path else None
        specs_base_dir = WorkspaceDetector.get_workspace_specs_dir(workspace)

        workflow_root_id = WorkflowFileManager._get_workflow_root_id(node)
        spec_dir = specs_base_dir / workflow_root_id
        spec_dir.mkdir(parents=True, exist_ok=True)
        return spec_dir

    @staticmethod
    def get_node_file_path(node: Node, workspace_path: Optional[str] = None) -> Path:
        """
        获取节点文件路径。

        Args:
            node: 节点对象
            workspace_path: 工作空间路径

        Returns:
            docs/specs/{workflow_root_id}/{序号:02d}-{node_type}.md
        """
        spec_dir = WorkflowFileManager.get_spec_dir(node, workspace_path)
        
        # 获取节点在工作流中的序号
        sequence_number = WorkflowFileManager._get_node_sequence(node)
        
        # 获取节点类型的 prefix（用于文件命名）
        from .workflow_config import WorkflowRulesConfig
        config = WorkflowRulesConfig()
        node_config = config.get_node_type_config(node.type)
        prefix = node_config.prefix if node_config else node.type
        
        # 文件名格式：序号-prefix.md
        filename = f"{sequence_number:02d}-{prefix}.md"
        return spec_dir / filename
    
    @staticmethod
    def _get_node_sequence(node: Node) -> int:
        """
        获取节点在工作流中的序号（从1开始）。
        
        通过遍历从根节点开始的所有节点，按创建时间排序确定序号。
        
        Args:
            node: 节点对象
            
        Returns:
            节点序号（1-based）
        """
        # 获取工作流根节点
        root_id = WorkflowFileManager._get_workflow_root_id(node)
        
        # 获取工作流中的所有节点（按创建时间排序）
        def get_all_workflow_nodes(root_id: str) -> list:
            """递归获取工作流中的所有节点"""
            nodes = []
            visited = set()
            
            def traverse(node_id: str):
                if node_id in visited:
                    return
                visited.add(node_id)
                
                current_node = GraphCRUD.get_node_by_id(node_id)
                if current_node:
                    nodes.append(current_node)
                    
                    # 获取所有子节点
                    edges = GraphCRUD.get_edges_from_node(node_id)
                    for edge in edges:
                        traverse(edge.target)
            
            traverse(root_id)
            return nodes
        
        # 获取所有节点并排序
        all_nodes = get_all_workflow_nodes(root_id)
        all_nodes.sort(key=lambda n: n.created_at)
        
        # 找到当前节点的位置
        for i, n in enumerate(all_nodes, 1):
            if n.id == node.id:
                return i
        
        # 如果没找到，返回1（不应该发生）
        return 1

    @staticmethod
    def save_node_to_file(node: Node, workspace_path: Optional[str] = None) -> Path:
        """
        将节点保存到文件。

        文件格式:
        ---
        id: node_id
        type: node_type
        title: node_title
        status: draft|finalized
        created_at: 2025-01-10T10:00:00
        updated_at: 2025-01-10T12:00:00
        ---

        # Node Title

        Node content here...

        Args:
            node: 节点对象
            workspace_path: 工作空间路径

        Returns:
            文件路径 (docs/specs/{workflow_root_id}/{node_type}.md)
        """
        file_path = WorkflowFileManager.get_node_file_path(node, workspace_path)

        # 构建文件内容
        status = "draft" if node.is_draft else "finalized"

        content = f"""---
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
            f.write(content)

        return file_path

    @staticmethod
    def delete_node_file(node_id: str, workspace_path: Optional[str] = None) -> bool:
        """
        删除节点文件。

        Args:
            node_id: 节点 ID
            workspace_path: 工作空间路径

        Returns:
            是否成功删除
        """
        # 查找节点
        node = GraphCRUD.get_node_by_id(node_id)
        if not node:
            return False

        file_path = WorkflowFileManager.get_node_file_path(node, workspace_path)

        if file_path.exists():
            file_path.unlink()
            return True

        return False

    @staticmethod
    def generate_index(workspace_path: Optional[str] = None) -> list[Path]:
        """
        为每个工作流生成索引文件。

        在每个 spec 目录中生成 README.md。

        Args:
            workspace_path: 工作空间路径

        Returns:
            生成的索引文件路径列表
        """
        from .crud import GraphCRUD

        # 获取所有节点
        nodes = GraphCRUD.get_all_nodes()

        # 按工作流分组
        workflows = {}
        for node in nodes:
            root_id = WorkflowFileManager._get_workflow_root_id(node)
            if root_id not in workflows:
                workflows[root_id] = []
            workflows[root_id].append(node)

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

        generated_indices = []

        # 为每个工作流生成索引
        for root_id, workflow_nodes in workflows.items():
            # 找到根节点
            root_node = next((n for n in workflow_nodes if n.id == root_id), None)
            if not root_node:
                continue

            spec_dir = WorkflowFileManager.get_spec_dir(root_node, workspace_path)
            index_path = spec_dir / "README.md"

            # 按类型分组
            nodes_by_type = {}
            for node in workflow_nodes:
                node_type = node.type
                if node_type not in nodes_by_type:
                    nodes_by_type[node_type] = []
                nodes_by_type[node_type].append(node)

            # 生成索引内容
            content = f"""# {root_node.label}

> 自动生成于 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

**工作流 ID**: `{root_id}`
**根节点类型**: {type_names.get(root_node.type, root_node.type)}

## 统计

- 节点数: {len(workflow_nodes)}
- 草稿节点: {sum(1 for n in workflow_nodes if n.is_draft)}
- 已定稿节点: {sum(1 for n in workflow_nodes if not n.is_draft)}

## 节点列表

"""

            for node_type, type_nodes in sorted(nodes_by_type.items()):
                type_name = type_names.get(node_type, node_type)
                content += f"### {type_name}\n\n"

                for node in sorted(type_nodes, key=lambda n: n.created_at or datetime.min):
                    status_icon = "📝" if node.is_draft else "✅"
                    # 链接到同目录下的文件
                    content += f"- {status_icon} [{node.label}](./{node.type}.md)\n"

                content += "\n"

            # 写入索引文件
            with open(index_path, 'w', encoding='utf-8') as f:
                f.write(content)

            generated_indices.append(index_path)

        return generated_indices

    @staticmethod
    def sync_all_nodes(workspace_path: Optional[str] = None) -> dict:
        """
        同步所有节点到文件系统。

        将数据库中的所有节点导出为文件，按工作流分组到各自的 spec 目录。

        Args:
            workspace_path: 工作空间路径

        Returns:
            统计信息 {"synced": 10, "errors": 0, "workflows": 2, "indices": [...]}
        """
        from .crud import GraphCRUD

        nodes = GraphCRUD.get_all_nodes()

        stats = {
            "synced": 0,
            "errors": 0,
            "files": []
        }

        for node in nodes:
            try:
                file_path = WorkflowFileManager.save_node_to_file(node, workspace_path)
                stats["synced"] += 1
                stats["files"].append(str(file_path))
            except Exception as e:
                stats["errors"] += 1
                print(f"Error syncing node {node.id}: {e}")

        # 生成索引
        try:
            index_paths = WorkflowFileManager.generate_index(workspace_path)
            stats["workflows"] = len(index_paths)
            stats["indices"] = [str(p) for p in index_paths]
        except Exception as e:
            print(f"Error generating indices: {e}")
            stats["workflows"] = 0
            stats["indices"] = []

        return stats
