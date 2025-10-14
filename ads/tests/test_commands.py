"""
测试命令系统功能
"""
import pytest
import tempfile
from pathlib import Path
from ads.commands.loader import CommandLoader
from ads.commands.executor import CommandExecutor


class TestCommandLoader:
    """测试命令加载器"""

    def test_load_simple_command(self):
        """测试加载简单命令"""
        with tempfile.TemporaryDirectory() as tmpdir:
            commands_dir = Path(tmpdir)
            
            # 创建命令文件
            command_content = """# Quick Bug Analysis

Analyze the following bug:

**Bug Description**: {{description}}

Provide:
1. Root cause analysis
2. Suggested fix
3. Test cases
"""
            (commands_dir / "quick-bug.md").write_text(command_content)

            # 加载命令
            loader = CommandLoader(str(commands_dir))
            commands = loader.load_all_commands()

            assert len(commands) > 0
            assert "quick-bug" in [cmd.name for cmd in commands]

    def test_extract_command_variables(self):
        """测试提取命令变量"""
        with tempfile.TemporaryDirectory() as tmpdir:
            commands_dir = Path(tmpdir)
            
            command_content = """# Template with Variables

Feature: {{feature_name}}
Priority: {{priority}}
Owner: {{owner}}
"""
            (commands_dir / "test-cmd.md").write_text(command_content)

            loader = CommandLoader(str(commands_dir))
            commands = loader.load_all_commands()

            cmd = next(c for c in commands if c.name == "test-cmd")
            assert "feature_name" in cmd.variables
            assert "priority" in cmd.variables
            assert "owner" in cmd.variables

    def test_load_command_with_frontmatter(self):
        """测试加载带 frontmatter 的命令"""
        with tempfile.TemporaryDirectory() as tmpdir:
            commands_dir = Path(tmpdir)
            
            command_content = """---
name: feature-spec
description: Generate feature specification
variables:
  - feature_name
  - description
---

# Feature Specification

## Feature: {{feature_name}}

{{description}}
"""
            (commands_dir / "feature-spec.md").write_text(command_content)

            loader = CommandLoader(str(commands_dir))
            commands = loader.load_all_commands()

            cmd = next((c for c in commands if c.name == "feature-spec"), None)
            assert cmd is not None
            assert cmd.description == "Generate feature specification"

    def test_list_available_commands(self):
        """测试列出可用命令"""
        with tempfile.TemporaryDirectory() as tmpdir:
            commands_dir = Path(tmpdir)
            
            # 创建多个命令
            (commands_dir / "cmd1.md").write_text("# Command 1\n{{var1}}")
            (commands_dir / "cmd2.md").write_text("# Command 2\n{{var2}}")
            (commands_dir / "cmd3.md").write_text("# Command 3\n{{var3}}")

            loader = CommandLoader(str(commands_dir))
            commands = loader.load_all_commands()

            assert len(commands) == 3
            command_names = [cmd.name for cmd in commands]
            assert "cmd1" in command_names
            assert "cmd2" in command_names
            assert "cmd3" in command_names

    def test_command_not_found(self):
        """测试命令不存在"""
        with tempfile.TemporaryDirectory() as tmpdir:
            loader = CommandLoader(tmpdir)
            cmd = loader.load_command("nonexistent")
            assert cmd is None


class TestCommandExecutor:
    """测试命令执行器"""

    def test_execute_command_with_variables(self):
        """测试执行带变量的命令"""
        with tempfile.TemporaryDirectory() as tmpdir:
            commands_dir = Path(tmpdir)
            
            command_content = """# Bug Report

**Title**: {{title}}
**Description**: {{description}}
**Priority**: {{priority}}
"""
            (commands_dir / "bug-report.md").write_text(command_content)

            loader = CommandLoader(str(commands_dir))
            executor = CommandExecutor(loader)

            result = executor.execute(
                "bug-report",
                {
                    "title": "Login Error",
                    "description": "Users cannot login",
                    "priority": "High"
                }
            )

            assert "**Title**: Login Error" in result
            assert "**Description**: Users cannot login" in result
            assert "**Priority**: High" in result

    def test_execute_command_missing_variables(self):
        """测试执行缺少变量的命令"""
        with tempfile.TemporaryDirectory() as tmpdir:
            commands_dir = Path(tmpdir)
            
            command_content = "Name: {{name}}, Age: {{age}}"
            (commands_dir / "test.md").write_text(command_content)

            loader = CommandLoader(str(commands_dir))
            executor = CommandExecutor(loader)

            # 只提供部分变量
            result = executor.execute("test", {"name": "Alice"})

            assert "Name: Alice" in result
            # age 应该保留或替换为空

    def test_validate_command_variables(self):
        """测试验证命令变量"""
        with tempfile.TemporaryDirectory() as tmpdir:
            commands_dir = Path(tmpdir)
            
            command_content = "Required: {{field1}}, {{field2}}"
            (commands_dir / "validate.md").write_text(command_content)

            loader = CommandLoader(str(commands_dir))
            cmd = loader.load_command("validate")

            # 验证缺少的变量
            provided_vars = {"field1": "value1"}
            missing = set(cmd.variables) - set(provided_vars.keys())

            assert "field2" in missing

    def test_execute_command_not_found(self):
        """测试执行不存在的命令"""
        with tempfile.TemporaryDirectory() as tmpdir:
            loader = CommandLoader(tmpdir)
            executor = CommandExecutor(loader)

            result = executor.execute("nonexistent", {})
            assert result is None or "not found" in result.lower()


class TestCommandIntegration:
    """测试命令系统集成"""

    def test_full_command_workflow(self):
        """测试完整命令工作流"""
        with tempfile.TemporaryDirectory() as tmpdir:
            commands_dir = Path(tmpdir)
            
            # 创建命令
            bugfix_command = """# Bugfix Workflow

## Bug: {{bug_title}}

### Description
{{bug_description}}

### Steps to Reproduce
{{steps}}

### Expected Behavior
{{expected}}

### Actual Behavior
{{actual}}

### Priority
{{priority}}
"""
            (commands_dir / "bugfix.md").write_text(bugfix_command)

            # 加载命令
            loader = CommandLoader(str(commands_dir))
            commands = loader.load_all_commands()
            assert len(commands) > 0

            # 获取命令
            bugfix_cmd = loader.load_command("bugfix")
            assert bugfix_cmd is not None
            assert "bug_title" in bugfix_cmd.variables

            # 执行命令
            executor = CommandExecutor(loader)
            result = executor.execute(
                "bugfix",
                {
                    "bug_title": "Login Timeout",
                    "bug_description": "Login times out after 30s",
                    "steps": "1. Go to login\n2. Wait 30s",
                    "expected": "Login succeeds",
                    "actual": "Timeout error",
                    "priority": "Critical"
                }
            )

            assert "## Bug: Login Timeout" in result
            assert "Login times out after 30s" in result
            assert "Critical" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
