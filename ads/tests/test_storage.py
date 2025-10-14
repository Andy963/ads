"""
测试数据库存储和会话管理
"""
import pytest
import tempfile
from pathlib import Path
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from ads.storage.base import Base
from ads.storage.database import get_db, init_db


class TestDatabaseConnection:
    """测试数据库连接和初始化"""

    def test_database_engine_creation(self):
        """测试数据库引擎创建"""
        from ads.storage import database
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            test_engine = create_engine(f"sqlite:///{db_path}")
            
            # 临时替换引擎
            original_engine = database._engine
            database._engine = test_engine
            
            try:
                engine = database.get_engine()
                assert engine is not None
                assert engine.url.database == str(db_path)
            finally:
                database._engine = original_engine

    def test_session_factory_creation(self):
        """测试会话工厂创建"""
        from ads.storage import database
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            test_engine = create_engine(f"sqlite:///{db_path}")
            
            original_engine = database._engine
            original_session = database._SessionLocal
            database._engine = test_engine
            database._SessionLocal = None
            
            try:
                session_factory = database.get_session_local()
                assert session_factory is not None
                
                # 创建会话实例
                session = session_factory()
                assert session is not None
                session.close()
            finally:
                database._engine = original_engine
                database._SessionLocal = original_session

    def test_get_db_context_manager(self):
        """测试数据库会话上下文管理器"""
        from ads.storage import database
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            test_engine = create_engine(f"sqlite:///{db_path}")
            Base.metadata.create_all(test_engine)
            
            original_engine = database._engine
            original_session = database._SessionLocal
            database._engine = test_engine
            database._SessionLocal = sessionmaker(
                autocommit=False, 
                autoflush=False, 
                bind=test_engine,
                expire_on_commit=False
            )
            
            try:
                # 测试正常使用
                with get_db() as db:
                    assert db is not None
                    result = db.execute(text("SELECT 1"))
                    assert result is not None
            finally:
                database._engine = original_engine
                database._SessionLocal = original_session
                test_engine.dispose()  # 关闭所有连接

    def test_db_session_rollback_on_error(self):
        """测试数据库会话错误时回滚"""
        from ads.storage import database
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            test_engine = create_engine(f"sqlite:///{db_path}")
            Base.metadata.create_all(test_engine)
            
            original_engine = database._engine
            original_session = database._SessionLocal
            database._engine = test_engine
            database._SessionLocal = sessionmaker(
                autocommit=False,
                autoflush=False,
                bind=test_engine,
                expire_on_commit=False
            )
            
            try:
                # 测试异常回滚
                with pytest.raises(Exception):
                    with get_db() as db:
                        # 执行一个会失败的操作
                        raise Exception("Test error")
            finally:
                database._engine = original_engine
                database._SessionLocal = original_session
                test_engine.dispose()

    def test_sqlite_foreign_keys_enabled(self):
        """测试SQLite外键约束已启用"""
        from ads.storage import database
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            test_engine = create_engine(
                f"sqlite:///{db_path}",
                connect_args={"check_same_thread": False}
            )
            
            # 注册外键启用事件
            from sqlalchemy import event
            @event.listens_for(test_engine, "connect")
            def set_sqlite_pragma(dbapi_conn, connection_record):
                cursor = dbapi_conn.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()
            
            original_engine = database._engine
            original_session = database._SessionLocal
            database._engine = test_engine
            database._SessionLocal = sessionmaker(
                autocommit=False,
                autoflush=False,
                bind=test_engine,
                expire_on_commit=False
            )
            
            try:
                with get_db() as db:
                    # 检查外键是否启用
                    result = db.execute(text("PRAGMA foreign_keys"))
                    foreign_keys_on = result.scalar()
                    assert foreign_keys_on == 1
            finally:
                database._engine = original_engine
                database._SessionLocal = original_session
                test_engine.dispose()


class TestDatabaseInitialization:
    """测试数据库初始化"""

    def test_init_db_creates_tables(self):
        """测试init_db创建所有表"""
        from ads.storage import database
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            test_engine = create_engine(f"sqlite:///{db_path}")
            
            original_engine = database._engine
            original_session = database._SessionLocal
            database._engine = test_engine
            database._SessionLocal = None
            
            try:
                # 初始化数据库
                init_db()
                
                # 检查表是否创建
                from sqlalchemy import inspect
                inspector = inspect(test_engine)
                tables = inspector.get_table_names()
                
                # 验证核心表存在
                assert "nodes" in tables
                assert "edges" in tables
                assert "node_versions" in tables
            finally:
                database._engine = original_engine
                database._SessionLocal = original_session
                Base.metadata.drop_all(test_engine)
                test_engine.dispose()

    def test_multiple_db_initializations(self):
        """测试多次初始化数据库不会出错"""
        from ads.storage import database
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            test_engine = create_engine(f"sqlite:///{db_path}")
            
            original_engine = database._engine
            original_session = database._SessionLocal
            database._engine = test_engine
            database._SessionLocal = None
            
            try:
                # 多次初始化
                init_db()
                init_db()  # 不应该出错
                
                from sqlalchemy import inspect
                inspector = inspect(test_engine)
                tables = inspector.get_table_names()
                
                assert "nodes" in tables
            finally:
                database._engine = original_engine
                database._SessionLocal = original_session
                Base.metadata.drop_all(test_engine)
                test_engine.dispose()


class TestDatabaseTransactions:
    """测试数据库事务"""

    def test_transaction_commit(self):
        """测试事务提交"""
        from ads.storage import database
        from ads.graph.models import Node
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            test_engine = create_engine(f"sqlite:///{db_path}")
            Base.metadata.create_all(test_engine)
            
            original_engine = database._engine
            original_session = database._SessionLocal
            database._engine = test_engine
            database._SessionLocal = sessionmaker(
                autocommit=False,
                autoflush=False,
                bind=test_engine,
                expire_on_commit=False
            )
            
            try:
                # 创建节点
                with get_db() as db:
                    node = Node(
                        id="test_node",
                        type="aggregate",
                        label="Test",
                        content="Test content"
                    )
                    db.add(node)
                
                # 验证节点已保存
                with get_db() as db:
                    saved_node = db.query(Node).filter(Node.id == "test_node").first()
                    assert saved_node is not None
                    assert saved_node.label == "Test"
            finally:
                database._engine = original_engine
                database._SessionLocal = original_session
                test_engine.dispose()

    def test_transaction_rollback(self):
        """测试事务回滚"""
        from ads.storage import database
        from ads.graph.models import Node
        
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            test_engine = create_engine(f"sqlite:///{db_path}")
            Base.metadata.create_all(test_engine)
            
            original_engine = database._engine
            original_session = database._SessionLocal
            database._engine = test_engine
            database._SessionLocal = sessionmaker(
                autocommit=False,
                autoflush=False,
                bind=test_engine,
                expire_on_commit=False
            )
            
            try:
                # 尝试创建节点但失败
                with pytest.raises(Exception):
                    with get_db() as db:
                        node = Node(
                            id="test_rollback",
                            type="aggregate",
                            label="Test",
                            content="Test"
                        )
                        db.add(node)
                        raise Exception("Rollback test")
                
                # 验证节点未保存
                with get_db() as db:
                    saved_node = db.query(Node).filter(Node.id == "test_rollback").first()
                    assert saved_node is None
            finally:
                database._engine = original_engine
                database._SessionLocal = original_session
                test_engine.dispose()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
