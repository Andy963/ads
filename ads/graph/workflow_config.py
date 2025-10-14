"""
工作流规则配置加载器

从YAML文件加载节点类型、连接规则和工作流模板配置
"""
from pathlib import Path
from typing import Dict, List, Optional
import random
import string
import yaml
from pydantic import BaseModel


class NodeTypeConfig(BaseModel):
    """节点类型配置"""
    key: str
    label: str
    prefix: str
    next_types: List[str] = []
    color: str
    icon: str
    description: Optional[str] = None
    ai_prompt_template: Optional[str] = None


class WorkflowStepOption(BaseModel):
    """工作流步骤选项"""
    node_type: str
    label: str
    description: str


class WorkflowStep(BaseModel):
    """工作流步骤"""
    step_number: int
    label: str
    required: bool
    options: List[WorkflowStepOption]
    default_option: Optional[str] = None


class WorkflowTemplateConfig(BaseModel):
    """工作流模板配置"""
    key: str
    name: str
    description: str
    icon: str
    steps: List[WorkflowStep]


class WorkflowRulesConfig:
    """工作流规则配置管理器"""

    _instance = None
    _config_loaded = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if not self._config_loaded:
            self._load_config()
            self.__class__._config_loaded = True

    def _load_config(self):
        """从YAML文件加载配置"""
        # 从同目录的 config.yaml 加载
        config_file = Path(__file__).parent / "config.yaml"

        if not config_file.exists():
            raise FileNotFoundError(f"配置文件不存在: {config_file}")

        with open(config_file, 'r', encoding='utf-8') as f:
            config_data = yaml.safe_load(f)

        # 加载节点类型配置
        self.node_types: Dict[str, NodeTypeConfig] = {}
        for key, data in config_data.get('node_types', {}).items():
            self.node_types[key] = NodeTypeConfig(**data)

        # 加载前端连接规则
        self.connection_rules: Dict[str, List[str]] = config_data.get('connection_rules', {})

        # 加载工作流模板
        self.workflow_templates: Dict[str, WorkflowTemplateConfig] = {}
        for key, data in config_data.get('workflow_templates', {}).items():
            # 转换steps数据结构
            steps = []
            for step_data in data.get('steps', []):
                options = [WorkflowStepOption(**opt) for opt in step_data.get('options', [])]
                steps.append(WorkflowStep(
                    step_number=step_data['step_number'],
                    label=step_data['label'],
                    required=step_data['required'],
                    options=options,
                    default_option=step_data.get('default_option')
                ))

            self.workflow_templates[key] = WorkflowTemplateConfig(
                key=data['key'],
                name=data['name'],
                description=data['description'],
                icon=data['icon'],
                steps=steps
            )

    # ========== 节点类型配置API ==========

    def get_node_type_config(self, node_type: str) -> Optional[NodeTypeConfig]:
        """获取节点类型配置"""
        return self.node_types.get(node_type)

    def get_all_node_types(self) -> List[NodeTypeConfig]:
        """获取所有节点类型配置"""
        return list(self.node_types.values())

    def get_downstream_types(self, node_type: str) -> List[str]:
        """获取节点的下游节点类型列表（后端用）"""
        config = self.get_node_type_config(node_type)
        return config.next_types if config else []

    # ========== 前端连接规则API ==========

    def get_connection_rules(self, node_type: str) -> List[str]:
        """获取节点的连接规则（前端用）"""
        return self.connection_rules.get(node_type, [])

    def get_all_connection_rules(self) -> Dict[str, List[str]]:
        """获取所有连接规则"""
        return self.connection_rules

    # ========== 工作流模板API ==========

    def get_workflow_template(self, template_key: str) -> Optional[WorkflowTemplateConfig]:
        """获取工作流模板配置"""
        return self.workflow_templates.get(template_key)

    def get_all_workflow_templates(self) -> Dict[str, WorkflowTemplateConfig]:
        """获取所有工作流模板"""
        return self.workflow_templates


# 全局单例实例
_config_instance = None


def get_workflow_config() -> WorkflowRulesConfig:
    """获取工作流配置实例（单例模式）"""
    global _config_instance
    if _config_instance is None:
        _config_instance = WorkflowRulesConfig()
    return _config_instance


# 便捷函数（向后兼容）
def get_node_type_config(node_type: str) -> Optional[NodeTypeConfig]:
    """获取节点类型配置"""
    return get_workflow_config().get_node_type_config(node_type)


def get_all_node_types() -> List[NodeTypeConfig]:
    """获取所有节点类型配置"""
    return get_workflow_config().get_all_node_types()


def get_downstream_types(node_type: str) -> List[str]:
    """获取节点的下游节点类型列表"""
    return get_workflow_config().get_downstream_types(node_type)


def get_workflow_template(template_key: str) -> Optional[WorkflowTemplateConfig]:
    """获取工作流模板配置"""
    return get_workflow_config().get_workflow_template(template_key)


def get_all_workflow_templates() -> Dict[str, WorkflowTemplateConfig]:
    """获取所有工作流模板"""
    return get_workflow_config().get_all_workflow_templates()


def get_connection_rules(node_type: str) -> List[str]:
    """获取节点的连接规则（前端用）"""
    return get_workflow_config().get_connection_rules(node_type)


def get_all_connection_rules() -> Dict[str, List[str]]:
    """获取所有连接规则"""
    return get_workflow_config().get_all_connection_rules()


def generate_node_id(node_type: str) -> str:
    """生成节点ID"""
    config = get_node_type_config(node_type)
    prefix = config.prefix if config else 'node'
    random_str = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{prefix}_{random_str}"


def get_node_type_label(node_type: str) -> Optional[str]:
    """获取节点类型的显示标签"""
    config = get_node_type_config(node_type)
    return config.label if config else None
