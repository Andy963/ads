"""
插件加载器

负责发现、加载和管理插件。
"""

import importlib
import sys
from pathlib import Path
from typing import Dict, Optional, List
import logging

from .interface import Plugin, PluginMetadata

logger = logging.getLogger(__name__)


class PluginLoader:
    """
    插件加载器
    
    在验证阶段，手动加载指定路径的插件。
    未来可以扩展为通过 entry_points 自动发现。
    """
    
    def __init__(self):
        self.plugins: Dict[str, Plugin] = {}
    
    def load_plugin_from_path(self, plugin_path: Path, module_name: str) -> Optional[Plugin]:
        """
        从指定路径加载插件
        
        Args:
            plugin_path: 插件目录路径
            module_name: 插件模块名（如 'ads_plugin_fastapi'）
            
        Returns:
            Optional[Plugin]: 加载成功返回插件实例，失败返回 None
        """
        try:
            # 将插件路径添加到 sys.path
            plugin_parent = plugin_path.parent
            if str(plugin_parent) not in sys.path:
                sys.path.insert(0, str(plugin_parent))
            
            # 动态导入插件模块
            module = importlib.import_module(module_name)
            
            # 查找插件实例（假设模块中有 get_plugin() 函数）
            if hasattr(module, 'get_plugin'):
                plugin = module.get_plugin()
                
                if not isinstance(plugin, Plugin):
                    logger.error(f"Plugin {module_name} does not return a Plugin instance")
                    return None
                
                # 注册插件
                metadata = plugin.get_metadata()
                self.plugins[metadata.name] = plugin
                
                logger.info(f"Successfully loaded plugin: {metadata.name} v{metadata.version}")
                return plugin
            else:
                logger.error(f"Plugin {module_name} does not have get_plugin() function")
                return None
                
        except Exception as e:
            logger.error(f"Failed to load plugin from {plugin_path}: {e}")
            return None
    
    def load_plugin_from_class(self, plugin_class: type) -> Optional[Plugin]:
        """
        直接从插件类加载（用于测试）
        
        Args:
            plugin_class: 插件类
            
        Returns:
            Optional[Plugin]: 插件实例
        """
        try:
            plugin = plugin_class()
            
            if not isinstance(plugin, Plugin):
                logger.error(f"Plugin class {plugin_class.__name__} is not a Plugin subclass")
                return None
            
            metadata = plugin.get_metadata()
            self.plugins[metadata.name] = plugin
            
            logger.info(f"Successfully loaded plugin: {metadata.name} v{metadata.version}")
            return plugin
            
        except Exception as e:
            logger.error(f"Failed to load plugin class {plugin_class.__name__}: {e}")
            return None
    
    def get_plugin(self, name: str) -> Optional[Plugin]:
        """
        获取已加载的插件
        
        Args:
            name: 插件名称
            
        Returns:
            Optional[Plugin]: 插件实例，不存在返回 None
        """
        return self.plugins.get(name)
    
    def list_plugins(self) -> List[PluginMetadata]:
        """
        列出所有已加载的插件
        
        Returns:
            List[PluginMetadata]: 插件元数据列表
        """
        return [plugin.get_metadata() for plugin in self.plugins.values()]
    
    def get_plugin_by_scene(self, scene: str) -> Optional[Plugin]:
        """
        根据场景名称查找插件
        
        Args:
            scene: 场景名称（如 'fastapi_crud'）
            
        Returns:
            Optional[Plugin]: 支持该场景的插件，找不到返回 None
        """
        for plugin in self.plugins.values():
            metadata = plugin.get_metadata()
            if scene in metadata.scenes:
                return plugin
        return None
    
    def get_plugin_by_node_type(self, node_type: str) -> Optional[Plugin]:
        """
        根据节点类型查找插件
        
        Args:
            node_type: 节点类型（如 'api_design'）
            
        Returns:
            Optional[Plugin]: 提供该节点类型的插件，找不到返回 None
        """
        for plugin in self.plugins.values():
            metadata = plugin.get_metadata()
            if node_type in metadata.node_types:
                return plugin
        return None


# 全局单例
_plugin_loader: Optional[PluginLoader] = None


def get_plugin_loader() -> PluginLoader:
    """
    获取全局插件加载器实例
    
    Returns:
        PluginLoader: 插件加载器
    """
    global _plugin_loader
    if _plugin_loader is None:
        _plugin_loader = PluginLoader()
    return _plugin_loader
