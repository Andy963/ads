"""
Template loader - loads templates from .ads/templates/
"""

import yaml
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass


@dataclass
class NodeTemplate:
    """Node template definition"""
    name: str  # Template name
    node_type: str  # Node type
    title_template: str  # Title template with variables
    content_template: str  # Content template with variables
    variables: List[str]  # Required variables
    metadata: Dict[str, Any]  # Additional metadata
    file_path: Path  # Template file path


@dataclass
class WorkflowTemplate:
    """Workflow template definition"""
    name: str  # Template name
    title: str  # Workflow title
    description: str  # Description
    nodes: List[Dict[str, str]]  # Node definitions
    edges: List[Dict[str, str]]  # Edge definitions
    file_path: Path  # Template file path


class TemplateLoader:
    """Loads and manages templates"""

    @staticmethod
    def load_node_templates(workspace: Path) -> Dict[str, NodeTemplate]:
        """
        Load node templates from .ads/templates/nodes/

        Format (YAML):
        ```yaml
        name: bug_report_template
        node_type: bug_report
        title: "Bug: {{title}}"
        content: |
          ## Description
          {{description}}

          ## Steps to Reproduce
          {{steps}}

          ## Expected Behavior
          {{expected}}

          ## Actual Behavior
          {{actual}}
        variables:
          - title
          - description
          - steps
          - expected
          - actual
        ```

        Args:
            workspace: Workspace root path

        Returns:
            Dictionary mapping template names to NodeTemplate objects
        """
        templates_dir = workspace / ".ads" / "templates" / "nodes"

        if not templates_dir.exists():
            return {}

        templates = {}

        for template_file in templates_dir.glob("*.yaml"):
            try:
                template = TemplateLoader._parse_node_template(template_file)
                templates[template.name] = template
            except Exception as e:
                print(f"Warning: Failed to load node template {template_file}: {e}")
                continue

        # Also load markdown templates
        for template_file in templates_dir.glob("*.md"):
            try:
                template = TemplateLoader._parse_node_template_md(template_file)
                templates[template.name] = template
            except Exception as e:
                print(f"Warning: Failed to load node template {template_file}: {e}")
                continue

        return templates

    @staticmethod
    def _parse_node_template(file_path: Path) -> NodeTemplate:
        """Parse YAML node template"""
        with open(file_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)

        return NodeTemplate(
            name=data.get("name", file_path.stem),
            node_type=data.get("node_type", "default"),
            title_template=data.get("title", "{{title}}"),
            content_template=data.get("content", ""),
            variables=data.get("variables", []),
            metadata=data.get("metadata", {}),
            file_path=file_path
        )

    @staticmethod
    def _parse_node_template_md(file_path: Path) -> NodeTemplate:
        """Parse Markdown node template (simple format)"""
        content = file_path.read_text(encoding='utf-8')

        # Extract variables from {{variable}} patterns
        import re
        variables = re.findall(r'\{\{(\w+)\}\}', content)
        variables = list(dict.fromkeys(variables))  # Remove duplicates

        # Use filename as node type
        node_type = file_path.stem

        return NodeTemplate(
            name=node_type,
            node_type=node_type,
            title_template="{{title}}",
            content_template=content,
            variables=variables,
            metadata={},
            file_path=file_path
        )

    @staticmethod
    def load_workflow_templates(workspace: Path) -> Dict[str, WorkflowTemplate]:
        """
        Load workflow templates from .ads/templates/workflows/

        Format (YAML):
        ```yaml
        name: bugfix_workflow
        title: Bug Fix Workflow
        description: Standard workflow for fixing bugs
        nodes:
          - type: bug_report
            title: Bug Report
          - type: analysis
            title: Root Cause Analysis
          - type: fix
            title: Fix Implementation
        edges:
          - from: bug_report
            to: analysis
          - from: analysis
            to: fix
        ```

        Args:
            workspace: Workspace root path

        Returns:
            Dictionary mapping template names to WorkflowTemplate objects
        """
        templates_dir = workspace / ".ads" / "templates" / "workflows"

        if not templates_dir.exists():
            return {}

        templates = {}

        for template_file in templates_dir.glob("*.yaml"):
            try:
                template = TemplateLoader._parse_workflow_template(template_file)
                templates[template.name] = template
            except Exception as e:
                print(f"Warning: Failed to load workflow template {template_file}: {e}")
                continue

        return templates

    @staticmethod
    def _parse_workflow_template(file_path: Path) -> WorkflowTemplate:
        """Parse workflow template YAML"""
        with open(file_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)

        return WorkflowTemplate(
            name=data.get("name", file_path.stem),
            title=data.get("title", file_path.stem),
            description=data.get("description", ""),
            nodes=data.get("nodes", []),
            edges=data.get("edges", []),
            file_path=file_path
        )

    @staticmethod
    def get_node_template(
        workspace: Path,
        template_name: str
    ) -> Optional[NodeTemplate]:
        """Get a specific node template by name"""
        templates = TemplateLoader.load_node_templates(workspace)
        return templates.get(template_name)

    @staticmethod
    def get_workflow_template(
        workspace: Path,
        template_name: str
    ) -> Optional[WorkflowTemplate]:
        """Get a specific workflow template by name"""
        templates = TemplateLoader.load_workflow_templates(workspace)
        return templates.get(template_name)

    @staticmethod
    def list_templates(workspace: Path) -> Dict[str, List[str]]:
        """List all available templates"""
        node_templates = TemplateLoader.load_node_templates(workspace)
        workflow_templates = TemplateLoader.load_workflow_templates(workspace)

        return {
            "node_templates": list(node_templates.keys()),
            "workflow_templates": list(workflow_templates.keys())
        }
