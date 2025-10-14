"""
测试CLI命令行功能
"""
import pytest
import tempfile
import json
from pathlib import Path
from typer.testing import CliRunner
from ads.cli.main import app
from ads.cli.init import init_workspace


runner = CliRunner()


class TestCLIVersion:
    """测试版本命令"""

    def test_version_command(self):
        """测试版本命令输出"""
        result = runner.invoke(app, ["version"])
        assert result.exit_code == 0
        assert "ADS" in result.stdout
        assert "v0.1.0" in result.stdout

    def test_help_command(self):
        """测试帮助命令"""
        result = runner.invoke(app, ["--help"])
        assert result.exit_code == 0
        assert "ADS" in result.stdout
        assert "init" in result.stdout


class TestInitCommand:
    """测试初始化命令"""

    def test_init_workspace_basic(self):
        """测试基本工作空间初始化"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir) / "test_workspace"
            
            result_path = init_workspace(
                name="test_project",
                path=workspace
            )
            
            assert result_path == workspace
            assert workspace.exists()
            assert (workspace / ".ads").exists()

    def test_init_workspace_creates_config(self):
        """测试初始化创建配置文件"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            
            init_workspace(name="config_test", path=workspace)
            
            config_file = workspace / ".ads" / "config.json"
            assert config_file.exists()
            
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
            
            assert config["name"] == "config_test"
            assert config["version"] == "1.0"
            assert "created_at" in config

    def test_init_workspace_creates_directories(self):
        """测试初始化创建必需目录"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            
            init_workspace(path=workspace)
            
            # 检查核心目录
            assert (workspace / ".ads").is_dir()
            assert (workspace / ".ads" / "templates").is_dir()
            assert (workspace / ".ads" / "templates" / "workflows").is_dir()
            assert (workspace / ".ads" / "templates" / "nodes").is_dir()
            assert (workspace / ".ads" / "commands").is_dir()
            assert (workspace / "docs" / "specs").is_dir()

    def test_init_workspace_creates_database(self):
        """测试初始化创建数据库文件"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            
            init_workspace(path=workspace)
            
            db_file = workspace / ".ads" / "ads.db"
            assert db_file.exists()
            assert db_file.is_file()

    def test_init_workspace_in_current_dir(self):
        """测试在当前目录初始化"""
        with tempfile.TemporaryDirectory() as tmpdir:
            import os
            original_cwd = os.getcwd()
            
            try:
                os.chdir(tmpdir)
                workspace = init_workspace(name="current_dir_test")
                
                assert workspace == Path(tmpdir)
                assert (Path(tmpdir) / ".ads").exists()
            finally:
                os.chdir(original_cwd)

    def test_init_workspace_default_name(self):
        """测试默认工作空间名称"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir) / "my_project"
            
            init_workspace(path=workspace)
            
            config_file = workspace / ".ads" / "config.json"
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
            
            # 应该使用目录名作为默认名称
            assert config["name"] == "my_project"

    def test_init_existing_workspace(self):
        """测试重新初始化已存在的工作空间"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            
            # 第一次初始化
            init_workspace(name="first", path=workspace)
            
            # 第二次初始化（应该不出错）
            init_workspace(name="second", path=workspace)
            
            # 配置应该被更新
            config_file = workspace / ".ads" / "config.json"
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
            
            assert config["name"] == "second"

    def test_init_workspace_with_special_characters(self):
        """测试特殊字符的工作空间名称"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            
            # 使用包含特殊字符的名称
            special_name = "project-2024_测试"
            init_workspace(name=special_name, path=workspace)
            
            config_file = workspace / ".ads" / "config.json"
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
            
            assert config["name"] == special_name

    def test_init_creates_nested_path(self):
        """测试创建嵌套路径"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir) / "deep" / "nested" / "path"
            
            init_workspace(path=workspace)
            
            assert workspace.exists()
            assert (workspace / ".ads").exists()


class TestCLIIntegration:
    """测试CLI集成功能"""

    def test_cli_init_command_via_runner(self):
        """测试通过runner调用init命令"""
        with tempfile.TemporaryDirectory() as tmpdir:
            # 注意：这个测试可能需要根据实际的CLI实现调整
            # 如果init命令需要交互式输入，可能需要使用input参数
            pass  # 占位，实际实现取决于CLI的具体参数

    def test_no_args_shows_help(self):
        """测试无参数显示帮助"""
        result = runner.invoke(app, [])
        # no_args_is_help=True 时应该显示帮助
        assert "ADS" in result.stdout or result.exit_code == 0

    def test_invalid_command(self):
        """测试无效命令"""
        result = runner.invoke(app, ["invalid_command"])
        assert result.exit_code != 0


class TestWorkspaceStructure:
    """测试工作空间结构"""

    def test_workspace_has_all_required_files(self):
        """测试工作空间包含所有必需文件"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            init_workspace(path=workspace)
            
            required_paths = [
                ".ads/config.json",
                ".ads/ads.db",
                ".ads/templates",
                ".ads/templates/workflows",
                ".ads/templates/nodes",
                ".ads/commands",
                "docs/specs"
            ]
            
            for required_path in required_paths:
                full_path = workspace / required_path
                assert full_path.exists(), f"Missing: {required_path}"

    def test_config_json_structure(self):
        """测试config.json结构正确"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            init_workspace(name="test_config", path=workspace)
            
            config_file = workspace / ".ads" / "config.json"
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
            
            # 验证必需字段
            assert "name" in config
            assert "version" in config
            assert "created_at" in config
            
            # 验证类型
            assert isinstance(config["name"], str)
            assert isinstance(config["version"], str)
            assert isinstance(config["created_at"], str)

    def test_template_directories_exist(self):
        """测试模板目录存在"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            init_workspace(path=workspace)
            
            templates_dir = workspace / ".ads" / "templates"
            assert templates_dir.is_dir()
            
            workflows_dir = templates_dir / "workflows"
            assert workflows_dir.is_dir()
            
            nodes_dir = templates_dir / "nodes"
            assert nodes_dir.is_dir()

    def test_commands_directory_exists(self):
        """测试命令目录存在"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            init_workspace(path=workspace)
            
            commands_dir = workspace / ".ads" / "commands"
            assert commands_dir.is_dir()

    def test_docs_specs_directory_exists(self):
        """测试文档规格目录存在"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            init_workspace(path=workspace)
            
            specs_dir = workspace / "docs" / "specs"
            assert specs_dir.is_dir()


class TestCLIErrorHandling:
    """测试CLI错误处理"""

    def test_init_with_invalid_path_characters(self):
        """测试使用无效路径字符"""
        # 这个测试取决于操作系统
        # 在某些系统上某些字符是无效的
        pass  # 占位，根据需要实现

    def test_init_without_permissions(self):
        """测试没有权限时的初始化"""
        # 这个测试需要模拟权限问题
        pass  # 占位，根据需要实现


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
