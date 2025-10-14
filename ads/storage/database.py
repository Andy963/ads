"""
数据库引擎和会话管理 (SQLAlchemy)
"""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.engine import Engine
from contextlib import contextmanager
from typing import Generator, Optional
# settings 已移到 server，ads 核心不需要它
from ..workspace.detector import WorkspaceDetector

# 全局变量
_engine: Optional[Engine] = None
_SessionLocal: Optional[sessionmaker] = None


def get_engine() -> Engine:
    """
    获取数据库引擎（惰性初始化）

    数据库路径优先级：
    1. 如果是 ads 项目本身（检测 pyproject.toml），使用根目录的 ads.db
    2. 如果配置了 DATABASE_URL，使用配置的路径
    3. 否则使用工作空间数据库 {workspace}/.ads/ads.db

    Returns:
        SQLAlchemy Engine 实例

    Raises:
        RuntimeError: 如果工作空间未初始化
    """
    global _engine
    import os
    from pathlib import Path

    if _engine is None:
        database_url = None

        # 1. 检测是否是 ads 项目本身
        cwd = Path.cwd()
        pyproject_file = cwd / "pyproject.toml"
        if pyproject_file.exists():
            try:
                import tomli
                with open(pyproject_file, 'rb') as f:
                    pyproject = tomli.load(f)
                    project_name = pyproject.get('project', {}).get('name', '')
                    if project_name == 'ads':
                        # 是 ads 项目本身，使用根目录的 ads.db
                        db_path = cwd / "ads.db"
                        database_url = f"sqlite:///{db_path}"
            except:
                pass

        # 2. 尝试使用工作空间数据库
        if not database_url:
            try:
                workspace_db_path = WorkspaceDetector.get_workspace_db_path()
                database_url = f"sqlite:///{workspace_db_path}"
            except RuntimeError:
                # 工作空间未初始化，回退到当前目录的 ads.db
                db_path = cwd / "ads.db"
                database_url = f"sqlite:///{db_path}"

        # 创建数据库引擎
        _engine = create_engine(
            database_url,
            echo=False,  # 开发环境显示 SQL 日志
            connect_args={"check_same_thread": False}
        )

        # SQLite 启用外键支持
        @event.listens_for(_engine, "connect")
        def set_sqlite_pragma(dbapi_conn, connection_record):
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return _engine


def get_session_local() -> sessionmaker:
    """
    获取会话工厂（惰性初始化）

    Returns:
        SQLAlchemy sessionmaker 实例
    """
    global _SessionLocal

    if _SessionLocal is None:
        engine = get_engine()
        _SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)

    return _SessionLocal


@contextmanager
def get_db() -> Generator[Session, None, None]:
    """
    获取数据库会话上下文管理器

    使用示例:
        with get_db() as db:
            user = db.query(User).first()
    """
    SessionLocal = get_session_local()
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db():
    """
    初始化数据库
    创建所有表
    """
    from .base import Base

    # 导入 ads 核心模型
    from ..graph.models import Node, NodeVersion, Edge
    # GlobalRule, WorkspaceRule, WorkspaceConfig 已移到 server

    # 获取引擎并创建所有表
    engine = get_engine()
    Base.metadata.create_all(bind=engine)

    # 初始化预设数据
    init_preset_data()


def init_preset_data():
    """初始化 Provider 和 Model 预设数据（临时保留，后续迁移到单独的模块）"""
    # TODO: 将预设数据迁移到 providers 模块
    pass


# ==================== 向后兼容导出 ====================
# 保持旧的导入方式可用，避免大量代码修改
def SessionLocal():
    """
    向后兼容函数，模拟旧的 SessionLocal 调用

    Returns:
        SQLAlchemy Session 实例
    """
    return get_session_local()()


def engine():
    """
    向后兼容函数，获取引擎

    Returns:
        SQLAlchemy Engine 实例
    """
    return get_engine()
