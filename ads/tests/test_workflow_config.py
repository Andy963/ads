"""
测试工作流配置功能
"""
import pytest
from ads.graph.workflow_config import (
    WorkflowRulesConfig,
    NodeTypeConfig,
    WorkflowTemplateConfig,
    generate_node_id,
    get_node_type_label
)


class TestWorkflowRulesConfig:
    """测试工作流规则配置"""

    def test_load_config_from_yaml(self):
        """测试从 YAML 加载配置"""
        config = WorkflowRulesConfig()
        assert config is not None
        assert config.node_types is not None
        assert config.workflow_templates is not None

    def test_get_node_type_config(self):
        """测试获取节点类型配置"""
        config = WorkflowRulesConfig()
        
        # 测试聚合根配置
        aggregate_config = config.get_node_type_config("aggregate")
        assert aggregate_config is not None
        assert aggregate_config.key == "aggregate"
        assert aggregate_config.label == "聚合根"
        assert aggregate_config.prefix == "agg"
        assert "requirement" in aggregate_config.next_types

    def test_get_all_node_types(self):
        """测试获取所有节点类型"""
        config = WorkflowRulesConfig()
        node_types = config.get_all_node_types()
        
        assert len(node_types) > 0
        # node_types 是 NodeTypeConfig 对象列表
        type_keys = [nt.key for nt in node_types]
        assert "aggregate" in type_keys
        assert "requirement" in type_keys
        assert "design" in type_keys
        assert "bug_report" in type_keys

    def test_get_workflow_template(self):
        """测试获取工作流模板"""
        config = WorkflowRulesConfig()
        
        # 测试标准工作流
        standard_template = config.get_workflow_template("standard")
        assert standard_template is not None
        assert standard_template.key == "standard"
        assert standard_template.name == "标准开发流程"
        assert len(standard_template.steps) > 0

        # 测试 bugfix 工作流
        bugfix_template = config.get_workflow_template("bugfix")
        assert bugfix_template is not None
        assert bugfix_template.key == "bugfix"
        assert len(bugfix_template.steps) > 0

    def test_get_all_workflow_templates(self):
        """测试获取所有工作流模板"""
        config = WorkflowRulesConfig()
        templates = config.get_all_workflow_templates()
        
        assert len(templates) >= 3
        assert "standard" in templates
        assert "bugfix" in templates
        assert "feature" in templates

    def test_workflow_template_steps(self):
        """测试工作流模板步骤"""
        config = WorkflowRulesConfig()
        standard_template = config.get_workflow_template("standard")
        
        assert len(standard_template.steps) > 0
        
        # 验证第一个步骤
        first_step = standard_template.steps[0]
        assert first_step.step_number == 1
        assert first_step.label is not None
        assert first_step.required is not None
        assert len(first_step.options) > 0

        # 验证步骤有选项
        first_option = first_step.options[0]
        assert first_option.node_type is not None
        assert first_option.label is not None

    def test_get_connection_rules(self):
        """测试获取连接规则"""
        config = WorkflowRulesConfig()
        
        # 获取 aggregate 的连接规则
        rules = config.get_connection_rules("aggregate")
        assert rules is not None
        assert len(rules) > 0
        assert "requirement" in rules

    def test_get_downstream_types(self):
        """测试获取下游节点类型"""
        config = WorkflowRulesConfig()
        
        # requirement -> design
        req_config = config.get_node_type_config("requirement")
        assert "design" in req_config.next_types

        # design -> implementation
        design_config = config.get_node_type_config("design")
        assert "implementation" in design_config.next_types

    def test_node_type_not_found(self):
        """测试节点类型不存在"""
        config = WorkflowRulesConfig()
        result = config.get_node_type_config("nonexistent_type")
        assert result is None

    def test_workflow_template_not_found(self):
        """测试工作流模板不存在"""
        config = WorkflowRulesConfig()
        result = config.get_workflow_template("nonexistent_template")
        assert result is None


class TestNodeTypeConfig:
    """测试节点类型配置模型"""

    def test_node_type_config_validation(self):
        """测试节点类型配置验证"""
        config = NodeTypeConfig(
            key="test_type",
            label="测试类型",
            prefix="test",
            next_types=["next_type"],
            color="#409eff",
            icon="📝",
            description="测试节点"
        )
        
        assert config.key == "test_type"
        assert config.label == "测试类型"
        assert config.prefix == "test"
        assert len(config.next_types) == 1
        assert config.color == "#409eff"
        assert config.icon == "📝"

    def test_node_type_config_defaults(self):
        """测试节点类型配置默认值"""
        config = NodeTypeConfig(
            key="minimal",
            label="最小配置",
            prefix="min",
            color="#000000",
            icon="🔷",
        )
        
        assert config.next_types == []
        assert config.description is None


class TestWorkflowHelpers:
    """测试工作流辅助函数"""

    def test_generate_node_id(self):
        """测试生成节点 ID"""
        node_id = generate_node_id("bug_report")
        
        assert node_id.startswith("bug_")
        assert len(node_id) > 4  # prefix + random string

    def test_generate_node_id_consistency(self):
        """测试节点 ID 生成的一致性"""
        id1 = generate_node_id("aggregate")
        id2 = generate_node_id("aggregate")
        
        # 应该生成不同的 ID
        assert id1 != id2
        assert id1.startswith("agg_")
        assert id2.startswith("agg_")

    def test_get_node_type_label(self):
        """测试获取节点类型标签"""
        label = get_node_type_label("requirement")
        assert label == "需求"

        label = get_node_type_label("design")
        assert label == "设计"

    def test_get_node_type_label_not_found(self):
        """测试获取不存在的节点类型标签"""
        label = get_node_type_label("nonexistent")
        assert label is None


class TestWorkflowTemplateConfig:
    """测试工作流模板配置模型"""

    def test_workflow_template_config_creation(self):
        """测试创建工作流模板配置"""
        from ads.graph.workflow_config import WorkflowStep, WorkflowStepOption
        
        option = WorkflowStepOption(
            node_type="requirement",
            label="需求",
            description="需求分析"
        )
        
        step = WorkflowStep(
            step_number=1,
            label="需求分析",
            required=True,
            options=[option],
            default_option="requirement"
        )
        
        template = WorkflowTemplateConfig(
            key="test_workflow",
            name="测试工作流",
            description="测试用工作流",
            icon="🔧",
            steps=[step]
        )
        
        assert template.key == "test_workflow"
        assert template.name == "测试工作流"
        assert len(template.steps) == 1
        assert template.steps[0].step_number == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
