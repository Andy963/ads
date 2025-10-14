"""
测试自动工作流引擎功能
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from ads.storage.base import Base
from ads.graph.models import Node, Edge
from ads.graph.auto_workflow import (
    WorkflowTemplate,
    NodeTypeConfig,
    AutoWorkflowEngine
)


@pytest.fixture(scope="function")
def db_session():
    """创建测试数据库会话"""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


class TestNodeTypeConfig:
    """测试节点类型配置"""
    
    def test_flow_rules_structure(self):
        """测试FLOW_RULES包含所有必需的节点类型"""
        expected_types = [
            'aggregate', 'requirement', 'design', 'implementation', 'test',
            'bug_report', 'bug_analysis', 'bug_fix', 'bug_verify'
        ]
        for node_type in expected_types:
            assert node_type in NodeTypeConfig.FLOW_RULES
            config = NodeTypeConfig.FLOW_RULES[node_type]
            assert 'next_type' in config
            assert 'label_template' in config
            assert 'ai_prompt_template' in config


class TestAutoWorkflowEngine:
    """测试自动工作流引擎"""
    
    def test_on_node_finalized_with_content(self, db_session: Session):
        """测试父节点有内容时自动创建下游节点"""
        engine = AutoWorkflowEngine(db_session)
        
        # 创建一个requirement节点并定稿
        req_node = Node(
            id='req_001',
            type='requirement',
            label='用户注册需求',
            content='用户可以通过邮箱注册账号',
            position={'x': 100, 'y': 100}
        )
        db_session.add(req_node)
        db_session.commit()
        
        # 触发定稿事件
        result = engine.on_node_finalized(req_node.id)
        
        # 验证返回了下游节点
        assert result is not None
        assert result['type'] == 'design'
        assert result['label'] == '用户注册需求-设计'
        assert 'ai_prompt' in result
        assert '用户可以通过邮箱注册账号' in result['ai_prompt']
        
        # 验证数据库中创建了节点和边
        design_node = db_session.query(Node).filter_by(id=result['id']).first()
        assert design_node is not None
        assert design_node.type == 'design'
        assert design_node.metadata.get('auto_created') is True
        assert design_node.metadata.get('parent_node_id') == 'req_001'
        
        edge = db_session.query(Edge).filter_by(
            source='req_001',
            target=design_node.id
        ).first()
        assert edge is not None
        assert edge.type == 'references'
    
    def test_on_node_finalized_without_content(self, db_session: Session):
        """测试父节点无内容时只创建空节点"""
        engine = AutoWorkflowEngine(db_session)
        
        # 创建一个requirement节点（无内容）并定稿
        req_node = Node(
            id='req_002',
            type='requirement',
            label='空需求',
            content='',  # 无内容
            position={'x': 100, 'y': 100}
        )
        db_session.add(req_node)
        db_session.commit()
        
        # 触发定稿事件
        result = engine.on_node_finalized(req_node.id)
        
        # 验证返回了下游节点但无AI提示
        assert result is not None
        assert result['type'] == 'design'
        assert result['label'] == '空需求-设计'
        assert result.get('ai_prompt') is None or result['ai_prompt'] == ''
        
        # 验证数据库中创建了节点
        design_node = db_session.query(Node).filter_by(id=result['id']).first()
        assert design_node is not None
        assert design_node.content == ''
        assert design_node.metadata.get('auto_created') is True
    
    def test_on_node_finalized_at_end_of_flow(self, db_session: Session):
        """测试流程终点节点定稿时不创建下游节点"""
        engine = AutoWorkflowEngine(db_session)
        
        # 创建一个test节点（DDD流程的最后一步）
        test_node = Node(
            id='test_001',
            type='test',
            label='测试用例',
            content='测试内容',
            position={'x': 100, 'y': 100}
        )
        db_session.add(test_node)
        db_session.commit()
        
        # 触发定稿事件
        result = engine.on_node_finalized(test_node.id)
        
        # 验证没有创建下游节点
        assert result is None
    
    def test_on_node_finalized_with_existing_downstream(self, db_session: Session):
        """测试已存在下游节点时不重复创建"""
        engine = AutoWorkflowEngine(db_session)
        
        # 创建requirement和design节点
        req_node = Node(
            id='req_003',
            type='requirement',
            label='需求',
            content='需求内容',
            position={'x': 100, 'y': 100}
        )
        design_node = Node(
            id='des_003',
            type='design',
            label='设计',
            content='',
            position={'x': 100, 'y': 200}
        )
        edge = Edge(
            source='req_003',
            target='des_003',
            type='references'
        )
        db_session.add_all([req_node, design_node, edge])
        db_session.commit()
        
        # 触发定稿事件
        result = engine.on_node_finalized(req_node.id)
        
        # 验证没有创建新节点
        assert result is None


@pytest.mark.skip(reason="create_workflow_from_template在API层实现，不作为独立函数导出")
class TestWorkflowTemplates:
    """测试工作流模板创建"""
    
    def test_create_ddd_workflow(self, db_session: Session):
        """测试创建DDD标准流程"""
        result = create_workflow_from_template(
            db_session,
            WorkflowTemplate.DDD_STANDARD,
            start_position={'x': 100, 'y': 100}
        )
        
        assert 'nodes' in result
        assert 'edges' in result
        assert len(result['nodes']) == 5  # aggregate, requirement, design, implementation, test
        assert len(result['edges']) == 4
        
        # 验证节点类型顺序
        node_types = [node['type'] for node in result['nodes']]
        assert node_types == ['aggregate', 'requirement', 'design', 'implementation', 'test']
        
        # 验证所有节点都创建在数据库中
        for node_data in result['nodes']:
            node = db_session.query(Node).filter_by(id=node_data['id']).first()
            assert node is not None
            assert node.type == node_data['type']
    
    def test_create_bugfix_workflow(self, db_session: Session):
        """测试创建Bugfix流程"""
        result = create_workflow_from_template(
            db_session,
            WorkflowTemplate.BUGFIX,
            start_position={'x': 200, 'y': 200}
        )
        
        assert 'nodes' in result
        assert 'edges' in result
        assert len(result['nodes']) == 4  # bug_report, bug_analysis, bug_fix, bug_verify
        assert len(result['edges']) == 3
        
        # 验证节点类型顺序
        node_types = [node['type'] for node in result['nodes']]
        assert node_types == ['bug_report', 'bug_analysis', 'bug_fix', 'bug_verify']
        
        # 验证所有节点都创建在数据库中
        for node_data in result['nodes']:
            node = db_session.query(Node).filter_by(id=node_data['id']).first()
            assert node is not None
            assert node.type == node_data['type']
    
    def test_workflow_node_positions(self, db_session: Session):
        """测试工作流节点位置计算"""
        result = create_workflow_from_template(
            db_session,
            WorkflowTemplate.DDD_STANDARD,
            start_position={'x': 100, 'y': 100}
        )
        
        # 验证节点位置按垂直方向递增
        for i, node_data in enumerate(result['nodes']):
            expected_y = 100 + (i * 200)
            node = db_session.query(Node).filter_by(id=node_data['id']).first()
            assert node.position['x'] == 100
            assert node.position['y'] == expected_y


class TestAIPromptGeneration:
    """测试AI提示词生成"""
    
    def test_build_ai_prompt_with_parent_content(self, db_session: Session):
        """测试包含父节点内容的AI提示词生成"""
        engine = AutoWorkflowEngine(db_session)
        
        # 创建父节点链
        agg_node = Node(
            id='agg_001',
            type='aggregate',
            label='用户聚合根',
            content='用户聚合根管理用户的生命周期',
            position={'x': 0, 'y': 0}
        )
        req_node = Node(
            id='req_001',
            type='requirement',
            label='用户注册需求',
            content='用户可以通过邮箱注册',
            position={'x': 0, 'y': 200}
        )
        edge = Edge(source='agg_001', target='req_001', type='references')
        db_session.add_all([agg_node, req_node, edge])
        db_session.commit()
        
        # 生成AI提示词
        prompt = engine._build_ai_prompt(req_node, 'design')
        
        # 验证提示词包含父节点内容
        assert '用户聚合根管理用户的生命周期' in prompt
        assert '用户可以通过邮箱注册' in prompt
        assert '设计' in prompt
    
    def test_build_ai_prompt_without_parents(self, db_session: Session):
        """测试无父节点时的AI提示词生成"""
        engine = AutoWorkflowEngine(db_session)
        
        # 创建单独节点
        node = Node(
            id='req_001',
            type='requirement',
            label='独立需求',
            content='独立需求内容',
            position={'x': 0, 'y': 0}
        )
        db_session.add(node)
        db_session.commit()
        
        # 生成AI提示词
        prompt = engine._build_ai_prompt(node, 'design')
        
        # 验证提示词只包含当前节点内容
        assert '独立需求内容' in prompt
        assert '设计' in prompt


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
