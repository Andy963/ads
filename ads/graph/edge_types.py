"""
边类型定义

定义图谱中支持的边类型及其用途。
"""
from enum import Enum
from typing import List


class EdgeType(str, Enum):
    """边类型枚举"""

    NEXT = "next"           # 工作流顺序边（requirement → design → implementation）
    CONTAIN = "contain"      # 包含关系（aggregate 包含 子实体/子需求）
    REFERENCE = "reference"  # 引用关系（跨工作流引用）


class EdgeTypeConfig:
    """边类型配置"""

    @staticmethod
    def get_all_edge_types() -> List[str]:
        """获取所有边类型"""
        return [e.value for e in EdgeType]

    @staticmethod
    def get_edge_type_description(edge_type: str) -> str:
        """获取边类型描述"""
        descriptions = {
            EdgeType.NEXT.value: "工作流顺序边，表示节点之间的前后关系",
            EdgeType.CONTAIN.value: "包含关系，用于聚合根包含子实体或子需求",
            EdgeType.REFERENCE.value: "引用关系，用于跨工作流的节点引用"
        }
        return descriptions.get(edge_type, "")

    @staticmethod
    def get_default_edge_type() -> str:
        """获取默认边类型（用于工作流）"""
        return EdgeType.NEXT.value


def get_edge_types() -> List[str]:
    """便捷函数：获取所有边类型"""
    return EdgeTypeConfig.get_all_edge_types()


def get_default_edge_type() -> str:
    """便捷函数：获取默认边类型"""
    return EdgeTypeConfig.get_default_edge_type()
