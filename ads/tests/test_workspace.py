"""
测试工作空间管理功能
"""
import pytest
import json
import tempfile
from pathlib import Path
from ads.workspace.detector import WorkspaceDetector
from ads.workspace.context import WorkflowContext


@pytest.mark.skip(reason="Requires actual workspace initialization")
class TestWorkspaceDetector:
    """测试工作空间检测器"""

    def test_detect_workspace_from_ads_dir(self):
        """测试从 .ads 目录检测工作空间"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            ads_dir = workspace / ".ads"
            ads_dir.mkdir()

            # 创建配置文件
            config = {"name": "test_workspace", "version": "1.0"}
            (ads_dir / "config.json").write_text(json.dumps(config))

            # 检测工作空间
            detector = WorkspaceDetector(str(workspace))
            assert detector.is_workspace() is True
            assert detector.workspace_path == workspace

    def test_detect_workspace_from_subdirectory(self):
        """测试从子目录检测工作空间"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            ads_dir = workspace / ".ads"
            ads_dir.mkdir()

            config = {"name": "test"}
            (ads_dir / "config.json").write_text(json.dumps(config))

            # 从子目录检测
            subdir = workspace / "src" / "components"
            subdir.mkdir(parents=True)

            detector = WorkspaceDetector(str(subdir))
            assert detector.is_workspace() is True
            assert detector.workspace_path == workspace

    def test_not_a_workspace(self):
        """测试非工作空间目录"""
        with tempfile.TemporaryDirectory() as tmpdir:
            detector = WorkspaceDetector(tmpdir)
            assert detector.is_workspace() is False

    def test_get_workspace_config(self):
        """测试获取工作空间配置"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            ads_dir = workspace / ".ads"
            ads_dir.mkdir()

            config = {
                "name": "my_project",
                "version": "1.0",
                "created_at": "2025-01-01"
            }
            (ads_dir / "config.json").write_text(json.dumps(config))

            detector = WorkspaceDetector(str(workspace))
            loaded_config = detector.get_config()

            assert loaded_config["name"] == "my_project"
            assert loaded_config["version"] == "1.0"


class TestWorkflowContext:
    """测试工作流上下文管理"""

    def test_save_and_load_workflow_context(self):
        """测试保存和加载工作流上下文"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            ads_dir = workspace / ".ads"
            ads_dir.mkdir()

            # 保存上下文
            context_data = {
                "active_workflow_id": "wf_001",
                "workflows": {
                    "wf_001": {
                        "title": "Test Workflow",
                        "template": "standard",
                        "steps": {
                            "aggregate": "node_001",
                            "requirement": "node_002"
                        }
                    }
                }
            }

            WorkflowContext.save_context(workspace, context_data)

            # 加载上下文
            loaded = WorkflowContext.load_context(workspace)
            assert loaded["active_workflow_id"] == "wf_001"
            assert loaded["workflows"]["wf_001"]["title"] == "Test Workflow"

    def test_get_active_workflow(self):
        """测试获取活动工作流"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            ads_dir = workspace / ".ads"
            ads_dir.mkdir()

            context_data = {
                "active_workflow_id": "wf_001",
                "workflows": {
                    "wf_001": {
                        "title": "Active Workflow",
                        "template": "bugfix",
                        "workflow_id": "wf_001"
                    }
                }
            }

            WorkflowContext.save_context(workspace, context_data)

            # 获取活动工作流
            active = WorkflowContext.get_active_workflow(workspace)
            assert active is not None
            assert active["title"] == "Active Workflow"
            assert active["template"] == "bugfix"

    def test_set_active_workflow(self):
        """测试设置活动工作流"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            ads_dir = workspace / ".ads"
            ads_dir.mkdir()

            # 初始化上下文
            initial_context = {
                "active_workflow_id": None,
                "workflows": {
                    "wf_001": {"title": "Workflow 1"},
                    "wf_002": {"title": "Workflow 2"}
                }
            }
            WorkflowContext.save_context(workspace, initial_context)

            # 设置活动工作流
            WorkflowContext.set_active_workflow(workspace, "wf_002")

            # 验证
            loaded = WorkflowContext.load_context(workspace)
            assert loaded["active_workflow_id"] == "wf_002"

    def test_empty_context(self):
        """测试空上下文"""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            ads_dir = workspace / ".ads"
            ads_dir.mkdir()

            # 加载不存在的上下文
            context = WorkflowContext.load_context(workspace)
            assert context["active_workflow_id"] is None
            assert context["workflows"] == {}


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
