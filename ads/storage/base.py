"""
SQLAlchemy Base 和基础模型
"""
from datetime import datetime
from sqlalchemy import Column, DateTime
from sqlalchemy.orm import declarative_base

# 创建 declarative base
Base = declarative_base()


class BaseModel(Base):
    """
    所有数据模型的基类
    自动添加 created_at 和 updated_at 字段
    """
    __abstract__ = True

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
