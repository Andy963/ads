"""
测试插件系统功能
"""

import pytest
from pathlib import Path
from ads.plugins.loader import PluginLoader
from ads.plugins.registry import PluginRegistry
from ads.plugins.interface import Plugin, PluginMetadata


class TestPluginLoader:
    """测试插件加载器"""

    def test_load_plugin_from_path(self):
        """测试从路径加载插件"""
        loader = PluginLoader()
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        plugin = loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        assert plugin is not None
        assert isinstance(plugin, Plugin)
        
        metadata = plugin.get_metadata()
        assert metadata.name == "fastapi-crud"
        assert metadata.version == "0.1.0"
        assert "fastapi_crud" in metadata.scenes
        assert "api_design" in metadata.node_types

    def test_get_plugin_by_name(self):
        """测试根据名称获取插件"""
        loader = PluginLoader()
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        plugin = loader.get_plugin("fastapi-crud")
        assert plugin is not None

    def test_get_nonexistent_plugin(self):
        """测试获取不存在的插件"""
        loader = PluginLoader()
        
        plugin = loader.get_plugin("nonexistent")
        assert plugin is None

    def test_list_plugins_empty(self):
        """测试列出插件（无插件）"""
        loader = PluginLoader()
        
        plugins = loader.list_plugins()
        assert plugins == []

    def test_list_plugins_with_plugin(self):
        """测试列出插件（有插件）"""
        loader = PluginLoader()
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        plugins = loader.list_plugins()
        assert len(plugins) == 1
        assert plugins[0].name == "fastapi-crud"

    def test_get_plugin_by_scene(self):
        """测试根据场景查找插件"""
        loader = PluginLoader()
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        plugin = loader.get_plugin_by_scene("fastapi_crud")
        assert plugin is not None
        assert plugin.get_metadata().name == "fastapi-crud"

    def test_get_plugin_by_scene_not_found(self):
        """测试场景不存在"""
        loader = PluginLoader()
        
        plugin = loader.get_plugin_by_scene("nonexistent_scene")
        assert plugin is None

    def test_get_plugin_by_node_type(self):
        """测试根据节点类型查找插件"""
        loader = PluginLoader()
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        plugin = loader.get_plugin_by_node_type("api_design")
        assert plugin is not None
        assert plugin.get_metadata().name == "fastapi-crud"

    def test_get_plugin_by_node_type_not_found(self):
        """测试节点类型不存在"""
        loader = PluginLoader()
        
        plugin = loader.get_plugin_by_node_type("nonexistent_type")
        assert plugin is None


class TestPluginRegistry:
    """测试插件注册表"""

    def test_get_workflow_template(self):
        """测试获取工作流模板"""
        loader = PluginLoader()
        registry = PluginRegistry()
        registry.loader = loader
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        template = registry.get_workflow_template("fastapi_crud")
        assert template is not None
        assert template.name == "FastAPI CRUD 开发"
        assert len(template.steps) == 3

    def test_get_workflow_template_not_found(self):
        """测试获取不存在的模板"""
        registry = PluginRegistry()
        registry.loader = PluginLoader()
        
        template = registry.get_workflow_template("nonexistent")
        assert template is None

    def test_list_workflow_templates(self):
        """测试列出工作流模板"""
        loader = PluginLoader()
        registry = PluginRegistry()
        registry.loader = loader
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        templates = registry.list_workflow_templates()
        assert len(templates) == 1
        assert templates[0]['id'] == "fastapi_crud"
        assert templates[0]['plugin'] == "fastapi-crud"

    def test_list_workflow_templates_empty(self):
        """测试列出模板（无插件）"""
        registry = PluginRegistry()
        registry.loader = PluginLoader()
        
        templates = registry.list_workflow_templates()
        assert templates == []

    def test_get_node_template(self):
        """测试获取节点模板"""
        loader = PluginLoader()
        registry = PluginRegistry()
        registry.loader = loader
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        template = registry.get_node_template("api_design")
        assert template is not None
        assert isinstance(template, str)
        assert "# API 设计" in template

    def test_get_node_template_not_found(self):
        """测试获取不存在的节点模板"""
        registry = PluginRegistry()
        registry.loader = PluginLoader()
        
        template = registry.get_node_template("nonexistent_type")
        assert template is None

    def test_get_references(self):
        """测试获取参照示例"""
        loader = PluginLoader()
        registry = PluginRegistry()
        registry.loader = loader
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        refs = registry.get_references("fastapi_crud")
        assert len(refs) == 2
        assert "user_crud_example.py" in refs
        assert "best_practices.md" in refs

    def test_get_references_not_found(self):
        """测试获取不存在的参照示例"""
        registry = PluginRegistry()
        registry.loader = PluginLoader()
        
        refs = registry.get_references("nonexistent_scene")
        assert refs == {}

    def test_list_plugins(self):
        """测试列出所有插件"""
        loader = PluginLoader()
        registry = PluginRegistry()
        registry.loader = loader
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        plugins = registry.list_plugins()
        assert len(plugins) == 1
        assert isinstance(plugins[0], PluginMetadata)


class TestFastAPIPlugin:
    """测试 FastAPI 插件具体功能"""

    def test_plugin_metadata(self):
        """测试插件元数据"""
        loader = PluginLoader()
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        plugin = loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        metadata = plugin.get_metadata()
        assert metadata.name == "fastapi-crud"
        assert metadata.version == "0.1.0"
        assert metadata.author == "ADS Team"
        assert len(metadata.scenes) == 1
        assert len(metadata.node_types) == 3

    def test_workflow_template_structure(self):
        """测试工作流模板结构"""
        loader = PluginLoader()
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        plugin = loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        templates = plugin.get_workflow_templates()
        assert "fastapi_crud" in templates
        
        template = templates["fastapi_crud"]
        assert template.name == "FastAPI CRUD 开发"
        assert len(template.steps) == 3
        
        # 验证步骤顺序和依赖
        step_ids = [step['id'] for step in template.steps]
        assert step_ids == ['api_design', 'data_model', 'router_impl']
        
        # 验证依赖关系
        assert 'depends_on' not in template.steps[0]
        assert template.steps[1]['depends_on'] == ['api_design']
        assert template.steps[2]['depends_on'] == ['data_model']

    def test_all_node_templates_exist(self):
        """测试所有节点模板都存在"""
        loader = PluginLoader()
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        plugin = loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        metadata = plugin.get_metadata()
        
        for node_type in metadata.node_types:
            template = plugin.get_node_templates(node_type)
            assert template is not None, f"Template for {node_type} not found"
            assert isinstance(template, str)
            assert len(template) > 0

    def test_references_content(self):
        """测试参照示例内容"""
        loader = PluginLoader()
        
        plugin_path = Path(__file__).parent.parent.parent / "ads-plugin-fastapi"
        
        if not plugin_path.exists():
            pytest.skip("FastAPI plugin not found")
        
        plugin = loader.load_plugin_from_path(plugin_path, "ads-plugin-fastapi")
        
        refs = plugin.get_references("fastapi_crud")
        
        # 验证 user_crud_example.py
        assert "user_crud_example.py" in refs
        user_example = refs["user_crud_example.py"]
        assert "UserCreate" in user_example
        assert "UserResponse" in user_example
        assert "@router.post" in user_example
        
        # 验证 best_practices.md
        assert "best_practices.md" in refs
        best_practices = refs["best_practices.md"]
        assert "最佳实践" in best_practices
        assert "Pydantic" in best_practices


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
