"""
工作空间检测器

负责自动检测当前工作空间的位置。
"""

import os
import json
from pathlib import Path
from typing import Optional


class WorkspaceDetector:
    """工作空间检测器"""

    WORKSPACE_MARKER = ".ads/workspace.json"
    GIT_MARKER = ".git"

    @staticmethod
    def detect() -> Path:
        """
        检测当前工作空间目录。

        检测优先级：
        1. 环境变量 AD_WORKSPACE
        2. 向上查找 .ads/workspace.json
        3. 向上查找 .git 目录（Git 根目录）
        4. 当前工作目录

        Returns:
            工作空间绝对路径
        """
        # 1. 检查环境变量
        env_workspace = os.getenv("AD_WORKSPACE")
        if env_workspace:
            workspace_path = Path(env_workspace)
            if workspace_path.exists():
                return workspace_path.absolute()

        # 2. 向上查找 .ads/workspace.json
        workspace = WorkspaceDetector._find_marker(WorkspaceDetector.WORKSPACE_MARKER)
        if workspace:
            return workspace

        # 3. 向上查找 .git 目录
        git_root = WorkspaceDetector._find_marker(WorkspaceDetector.GIT_MARKER)
        if git_root:
            return git_root

        # 4. 回退到当前目录
        return Path.cwd().absolute()

    @staticmethod
    def _find_marker(marker: str) -> Optional[Path]:
        """
        从当前目录向上查找包含指定标记文件/目录的目录。

        Args:
            marker: 标记文件/目录名（如 ".git" 或 ".ads/workspace.json"）

        Returns:
            包含标记的目录路径，如果未找到返回 None
        """
        current = Path.cwd().absolute()

        # 最多向上查找 10 层
        for _ in range(10):
            marker_path = current / marker
            if marker_path.exists():
                return current

            # 到达文件系统根目录
            parent = current.parent
            if parent == current:
                break

            current = parent

        return None

    @staticmethod
    def get_workspace_db_path(workspace: Optional[Path] = None) -> Path:
        """
        获取工作空间数据库路径。

        Args:
            workspace: 工作空间路径，None 则自动检测

        Returns:
            数据库文件路径 {workspace}/.ads/ads.db

        Raises:
            RuntimeError: 如果工作空间未初始化
        """
        if workspace is None:
            workspace = WorkspaceDetector.detect()

        db_path = workspace / ".ads" / "ads.db"

        # 不自动创建目录，如果不存在则抛出错误
        if not db_path.parent.exists():
            raise RuntimeError(
                f"工作空间未初始化: {workspace}\n"
                f"请先运行 'ads init' 初始化工作空间"
            )

        return db_path

    @staticmethod
    def get_workspace_rules_dir(workspace: Optional[Path] = None) -> Path:
        """
        获取工作空间规则目录。

        Args:
            workspace: 工作空间路径，None 则自动检测

        Returns:
            规则目录路径 {workspace}/.ads/rules/

        Raises:
            RuntimeError: 如果工作空间未初始化
        """
        if workspace is None:
            workspace = WorkspaceDetector.detect()

        rules_dir = workspace / ".ads" / "rules"

        # 不自动创建目录，如果不存在则抛出错误
        if not rules_dir.exists():
            raise RuntimeError(
                f"工作空间未初始化: {workspace}\n"
                f"请先运行 'ads init' 初始化工作空间"
            )

        return rules_dir

    @staticmethod
    def get_workspace_specs_dir(workspace: Optional[Path] = None) -> Path:
        """
        获取工作空间 specs 目录。

        Args:
            workspace: 工作空间路径，None 则自动检测

        Returns:
            Specs 目录路径 {workspace}/docs/specs/

        Raises:
            RuntimeError: 如果工作空间未初始化
        """
        if workspace is None:
            workspace = WorkspaceDetector.detect()

        specs_dir = workspace / "docs" / "specs"

        # 不自动创建目录，如果不存在则抛出错误
        if not specs_dir.exists():
            raise RuntimeError(
                f"工作空间未初始化: {workspace}\n"
                f"请先运行 'ads init' 初始化工作空间"
            )

        return specs_dir

    @staticmethod
    def is_initialized(workspace: Optional[Path] = None) -> bool:
        """
        检查工作空间是否已初始化。

        Args:
            workspace: 工作空间路径，None 则自动检测

        Returns:
            是否已初始化
        """
        if workspace is None:
            workspace = WorkspaceDetector.detect()

        marker_path = workspace / WorkspaceDetector.WORKSPACE_MARKER
        return marker_path.exists()

    @staticmethod
    def initialize(workspace: Optional[Path] = None, name: Optional[str] = None) -> Path:
        """
        初始化工作空间。

        创建：
        - .ads/workspace.json
        - .ads/ads.db (空数据库)
        - .ads/rules/
        - docs/specs/

        Args:
            workspace: 工作空间路径，None 则使用当前目录
            name: 工作空间名称，None 则使用目录名

        Returns:
            工作空间路径
        """
        if workspace is None:
            workspace = Path.cwd().absolute()
        else:
            workspace = Path(workspace).absolute()

        if name is None:
            name = workspace.name

        # 创建目录结构
        ads_dir = workspace / ".ads"
        ads_dir.mkdir(exist_ok=True)

        rules_dir = ads_dir / "rules"
        rules_dir.mkdir(exist_ok=True)

        specs_dir = workspace / "docs" / "specs"
        specs_dir.mkdir(parents=True, exist_ok=True)

        # 创建工作空间配置
        from datetime import datetime

        workspace_config = {
            "name": name,
            "created_at": datetime.now().isoformat(),
            "version": "1.0"
        }

        config_file = ads_dir / "workspace.json"
        with open(config_file, 'w', encoding='utf-8') as f:
            json.dump(workspace_config, f, indent=2, ensure_ascii=False)

        # 初始化数据库
        db_path = ads_dir / "ads.db"
        if not db_path.exists():
            # 创建空数据库（会在首次使用时自动初始化表结构）
            db_path.touch()

        return workspace

    @staticmethod
    def get_workspace_info(workspace: Optional[Path] = None) -> dict:
        """
        获取工作空间信息。

        Args:
            workspace: 工作空间路径，None 则自动检测

        Returns:
            工作空间信息字典
        """
        if workspace is None:
            workspace = WorkspaceDetector.detect()

        config_file = workspace / WorkspaceDetector.WORKSPACE_MARKER

        info = {
            "path": str(workspace),
            "is_initialized": config_file.exists(),
            "db_path": str(WorkspaceDetector.get_workspace_db_path(workspace)),
            "rules_dir": str(WorkspaceDetector.get_workspace_rules_dir(workspace)),
            "specs_dir": str(WorkspaceDetector.get_workspace_specs_dir(workspace))
        }

        # 读取配置
        if config_file.exists():
            try:
                with open(config_file, 'r', encoding='utf-8') as f:
                    config = json.load(f)
                    info.update(config)
            except Exception:
                pass

        return info
