"""
插件接口定义

定义插件必须实现的抽象基类和数据结构。
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Dict, List, Optional
from pathlib import Path


@dataclass
class PluginMetadata:
    """插件元数据"""
    
    name: str
    """插件名称，如 'fastapi-crud'"""
    
    version: str
    """插件版本，如 '0.1.0'"""
    
    description: str
    """插件描述"""
    
    author: str
    """作者"""
    
    scenes: List[str]
    """支持的场景列表，如 ['fastapi_crud', 'fastapi_microservice']"""
    
    node_types: List[str]
    """提供的节点类型列表，如 ['api_design', 'data_model', 'router_impl']"""


@dataclass
class WorkflowTemplate:
    """工作流模板"""
    
    name: str
    """模板名称"""
    
    description: str
    """模板描述"""
    
    steps: List[Dict]
    """步骤列表，每个步骤包含 id, type, title, depends_on 等字段"""


class Plugin(ABC):
    """
    插件抽象基类
    
    所有插件必须继承此类并实现三个核心方法：
    - get_metadata() - 返回插件元数据
    - get_workflow_templates() - 返回工作流模板
    - get_node_templates() - 返回节点模板
    - get_references() - 返回参照示例
    """
    
    @abstractmethod
    def get_metadata(self) -> PluginMetadata:
        """
        获取插件元数据
        
        Returns:
            PluginMetadata: 插件基本信息
        """
        pass
    
    @abstractmethod
    def get_workflow_templates(self) -> Dict[str, WorkflowTemplate]:
        """
        获取工作流模板
        
        Returns:
            Dict[str, WorkflowTemplate]: 工作流模板字典
                key: 模板ID（如 'fastapi_crud'）
                value: WorkflowTemplate 对象
                
        Example:
            {
                'fastapi_crud': WorkflowTemplate(
                    name='FastAPI CRUD 开发',
                    description='标准的 FastAPI CRUD API 开发流程',
                    steps=[
                        {
                            'id': 'api_design',
                            'type': 'api_design',
                            'title': 'API 设计',
                            'description': '定义 REST API 端点和数据格式'
                        },
                        {
                            'id': 'data_model',
                            'type': 'data_model',
                            'title': 'Pydantic 模型',
                            'depends_on': ['api_design']
                        },
                        {
                            'id': 'router_impl',
                            'type': 'router_impl',
                            'title': '路由实现',
                            'depends_on': ['data_model']
                        }
                    ]
                )
            }
        """
        pass
    
    @abstractmethod
    def get_node_templates(self, node_type: str) -> Optional[str]:
        """
        获取节点模板内容
        
        Args:
            node_type: 节点类型（如 'api_design', 'data_model'）
            
        Returns:
            Optional[str]: Markdown 格式的模板内容，如果不存在返回 None
            
        Example:
            返回的内容示例：
            '''
            ## API 端点列表
            
            ### 创建用户
            - 端点：POST /users
            - 请求体：...
            
            ### 获取用户列表
            - 端点：GET /users
            - 查询参数：...
            '''
        """
        pass
    
    @abstractmethod
    def get_references(self, scene: str) -> Dict[str, str]:
        """
        获取参照示例
        
        Args:
            scene: 场景名称（如 'fastapi_crud'）
            
        Returns:
            Dict[str, str]: 参照文件字典
                key: 相对路径（如 'examples/user_crud.py'）
                value: 文件内容
                
        Example:
            {
                'examples/user_crud.py': '# User CRUD 示例\n...',
                'best_practices.md': '# FastAPI 最佳实践\n...'
            }
        """
        pass
    
    def get_plugin_root(self) -> Path:
        """
        获取插件根目录
        
        Returns:
            Path: 插件所在的根目录路径
        """
        return Path(__file__).parent
