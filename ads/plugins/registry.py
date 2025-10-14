"""
插件注册表

提供便捷的插件查询接口。
"""

import logging
from typing import Optional, List, Dict
from .interface import Plugin, PluginMetadata, WorkflowTemplate
from .loader import get_plugin_loader

logger = logging.getLogger(__name__)


class PluginRegistry:
    """
    插件注册表
    
    提供高层次的插件查询和访问接口，封装 PluginLoader 的细节。
    """
    
    def __init__(self):
        self.loader = get_plugin_loader()
    
    def get_workflow_template(self, template_id: str) -> Optional[WorkflowTemplate]:
        """
        获取工作流模板
        
        Args:
            template_id: 模板ID（如 'fastapi_crud'）
            
        Returns:
            Optional[WorkflowTemplate]: 工作流模板，不存在返回 None
        """
        # 查找支持该场景的插件
        plugin = self.loader.get_plugin_by_scene(template_id)
        if not plugin:
            logger.warning(
                f"No plugin provides workflow template '{template_id}'. "
                f"Available plugins: {len(self.loader.plugins)}"
            )
            return None
        
        # 获取该插件的所有模板
        templates = plugin.get_workflow_templates()
        template = templates.get(template_id)
        
        if not template:
            logger.warning(
                f"Plugin '{plugin.get_metadata().name}' does not provide template '{template_id}'"
            )
        
        return template
    
    def list_workflow_templates(self) -> List[Dict]:
        """
        列出所有可用的工作流模板
        
        Returns:
            List[Dict]: 模板信息列表
                [{
                    'id': 'fastapi_crud',
                    'name': 'FastAPI CRUD 开发',
                    'description': '...',
                    'plugin': 'ads-plugin-fastapi'
                }, ...]
        """
        if not self.loader.plugins:
            logger.info("No plugins loaded. Workflow templates list is empty.")
        
        result = []
        
        for plugin in self.loader.plugins.values():
            metadata = plugin.get_metadata()
            templates = plugin.get_workflow_templates()
            
            for template_id, template in templates.items():
                result.append({
                    'id': template_id,
                    'name': template.name,
                    'description': template.description,
                    'plugin': metadata.name,
                    'plugin_version': metadata.version
                })
        
        return result
    
    def get_node_template(self, node_type: str) -> Optional[str]:
        """
        获取节点模板内容
        
        Args:
            node_type: 节点类型（如 'api_design'）
            
        Returns:
            Optional[str]: 模板内容，不存在返回 None
        """
        plugin = self.loader.get_plugin_by_node_type(node_type)
        if not plugin:
            logger.debug(
                f"No plugin provides node template for type '{node_type}'. "
                f"Will use default node creation."
            )
            return None
        
        template = plugin.get_node_templates(node_type)
        
        if not template:
            logger.warning(
                f"Plugin '{plugin.get_metadata().name}' does not provide template for '{node_type}'"
            )
        
        return template
    
    def get_references(self, scene: str) -> Dict[str, str]:
        """
        获取场景的参照示例
        
        Args:
            scene: 场景名称（如 'fastapi_crud'）
            
        Returns:
            Dict[str, str]: 参照文件字典，场景不存在返回空字典
        """
        plugin = self.loader.get_plugin_by_scene(scene)
        if not plugin:
            logger.debug(
                f"No plugin provides references for scene '{scene}'. "
                f"AI will generate without reference examples."
            )
            return {}
        
        references = plugin.get_references(scene)
        
        if not references:
            logger.info(
                f"Plugin '{plugin.get_metadata().name}' has no references for scene '{scene}'"
            )
        else:
            logger.debug(
                f"Found {len(references)} reference files for scene '{scene}' "
                f"from plugin '{plugin.get_metadata().name}'"
            )
        
        return references
    
    def list_plugins(self) -> List[PluginMetadata]:
        """
        列出所有已加载的插件
        
        Returns:
            List[PluginMetadata]: 插件元数据列表
        """
        plugins = self.loader.list_plugins()
        
        if not plugins:
            logger.info("No plugins loaded. ADS will work with default behavior.")
        else:
            logger.debug(f"Loaded {len(plugins)} plugin(s): {[p.name for p in plugins]}")
        
        return plugins
    
    def get_plugin_for_node_type(self, node_type: str) -> Optional[Plugin]:
        """
        获取提供指定节点类型的插件
        
        Args:
            node_type: 节点类型
            
        Returns:
            Optional[Plugin]: 插件实例
        """
        return self.loader.get_plugin_by_node_type(node_type)


# 全局单例
_registry: Optional[PluginRegistry] = None


def get_plugin_registry() -> PluginRegistry:
    """
    获取全局插件注册表实例
    
    Returns:
        PluginRegistry: 插件注册表
    """
    global _registry
    if _registry is None:
        _registry = PluginRegistry()
    return _registry
