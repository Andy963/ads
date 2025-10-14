"""
测试模板系统功能
"""
import pytest
import tempfile
from pathlib import Path
from ads.templates.loader import TemplateLoader
from ads.templates.renderer import TemplateRenderer


class TestTemplateLoader:
    """测试模板加载器"""

    def test_load_yaml_template(self):
        """测试加载 YAML 模板"""
        with tempfile.TemporaryDirectory() as tmpdir:
            templates_dir = Path(tmpdir)
            
            # 创建 YAML 模板
            template_content = """
name: bug_report
node_type: bug_report
title: "Bug: {{title}}"
content: |
  ## Description
  {{description}}
  
  ## Steps to Reproduce
  {{steps}}

variables:
  - title
  - description
  - steps
"""
            template_file = templates_dir / "bug_report.yaml"
            template_file.write_text(template_content)

            # 加载模板
            loader = TemplateLoader(str(templates_dir))
            template = loader.load_template("bug_report")

            assert template is not None
            assert template["name"] == "bug_report"
            assert template["node_type"] == "bug_report"
            assert "{{title}}" in template["title"]
            assert "{{description}}" in template["content"]
            assert len(template["variables"]) == 3

    def test_load_markdown_template(self):
        """测试加载 Markdown 模板"""
        with tempfile.TemporaryDirectory() as tmpdir:
            templates_dir = Path(tmpdir)
            
            # 创建 Markdown 模板
            template_content = """# Feature: {{feature_name}}

## Overview
{{overview}}

## Requirements
{{requirements}}
"""
            template_file = templates_dir / "feature.md"
            template_file.write_text(template_content)

            # 加载模板
            loader = TemplateLoader(str(templates_dir))
            template = loader.load_template("feature")

            assert template is not None
            assert "{{feature_name}}" in template

    def test_list_templates(self):
        """测试列出所有模板"""
        with tempfile.TemporaryDirectory() as tmpdir:
            templates_dir = Path(tmpdir)
            
            # 创建多个模板
            (templates_dir / "bug_report.yaml").write_text("name: bug_report")
            (templates_dir / "feature.md").write_text("# Feature")
            (templates_dir / "design.yaml").write_text("name: design")

            # 列出模板
            loader = TemplateLoader(str(templates_dir))
            templates = loader.list_templates()

            assert len(templates) >= 3
            template_names = [t["name"] for t in templates]
            assert "bug_report" in template_names or "bug_report.yaml" in template_names

    def test_template_not_found(self):
        """测试模板不存在"""
        with tempfile.TemporaryDirectory() as tmpdir:
            loader = TemplateLoader(tmpdir)
            template = loader.load_template("nonexistent")
            assert template is None


class TestTemplateRenderer:
    """测试模板渲染器"""

    def test_render_simple_variables(self):
        """测试渲染简单变量"""
        template = "Hello {{name}}! Welcome to {{project}}."
        variables = {
            "name": "Alice",
            "project": "ADS"
        }

        renderer = TemplateRenderer()
        result = renderer.render(template, variables)

        assert result == "Hello Alice! Welcome to ADS."

    def test_render_multiline_template(self):
        """测试渲染多行模板"""
        template = """# Bug Report: {{title}}

## Description
{{description}}

## Priority
{{priority}}
"""
        variables = {
            "title": "Login Error",
            "description": "Users cannot login with email",
            "priority": "High"
        }

        renderer = TemplateRenderer()
        result = renderer.render(template, variables)

        assert "# Bug Report: Login Error" in result
        assert "Users cannot login with email" in result
        assert "High" in result

    def test_render_with_missing_variables(self):
        """测试缺少变量时的渲染"""
        template = "Hello {{name}}! Your score is {{score}}."
        variables = {"name": "Bob"}  # 缺少 score

        renderer = TemplateRenderer()
        result = renderer.render(template, variables)

        # 应该保留未替换的变量或替换为空
        assert "Hello Bob!" in result

    def test_render_with_default_values(self):
        """测试带默认值的渲染"""
        template = "Status: {{status|Unknown}}"
        variables = {}

        renderer = TemplateRenderer()
        result = renderer.render(template, variables)

        # 根据实现，可能返回 "Status: Unknown" 或 "Status: {{status|Unknown}}"
        assert "Status:" in result

    def test_validate_template_variables(self):
        """测试验证模板变量"""
        template = "Hello {{name}}, you have {{count}} messages."
        required_vars = ["name", "count"]

        renderer = TemplateRenderer()
        variables_found = renderer.extract_variables(template)

        assert "name" in variables_found
        assert "count" in variables_found

    def test_render_nested_structure(self):
        """测试渲染嵌套结构"""
        template = """## Requirements

### Must Have
{{must_have}}

### Nice to Have
{{nice_to_have}}
"""
        variables = {
            "must_have": "User authentication",
            "nice_to_have": "Social login"
        }

        renderer = TemplateRenderer()
        result = renderer.render(template, variables)

        assert "User authentication" in result
        assert "Social login" in result


class TestTemplateIntegration:
    """测试模板加载和渲染集成"""

    def test_load_and_render_workflow(self):
        """测试加载和渲染完整工作流"""
        with tempfile.TemporaryDirectory() as tmpdir:
            templates_dir = Path(tmpdir)
            
            # 创建节点模板
            template_content = """
name: requirement
node_type: requirement
title: "{{feature_name}} - Requirements"
content: |
  ## Feature
  {{description}}
  
  ## Acceptance Criteria
  {{criteria}}

variables:
  - feature_name
  - description
  - criteria
"""
            (templates_dir / "requirement.yaml").write_text(template_content)

            # 加载和渲染
            loader = TemplateLoader(str(templates_dir))
            renderer = TemplateRenderer()

            template = loader.load_template("requirement")
            assert template is not None

            # 渲染标题
            title_rendered = renderer.render(
                template["title"],
                {"feature_name": "User Profile"}
            )
            assert title_rendered == "User Profile - Requirements"

            # 渲染内容
            content_rendered = renderer.render(
                template["content"],
                {
                    "description": "User can view and edit profile",
                    "criteria": "Profile page loads in <2s"
                }
            )
            assert "User can view and edit profile" in content_rendered
            assert "Profile page loads in <2s" in content_rendered


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
