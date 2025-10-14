# 数据库迁移说明

## 历史迁移已清理

所有历史迁移文件已删除，项目现在从干净的初始状态开始。

## 首次使用

首次使用时，数据库表会自动创建：

```python
from ads.storage.database import init_db
init_db()
```

或者使用 alembic 创建初始迁移：

```bash
# 创建初始迁移
alembic revision --autogenerate -m "initial tables"

# 应用迁移
alembic upgrade head
```

## 表结构

核心表包括：
- `nodes` - 工作流节点
- `edges` - 节点关系
- `node_versions` - 节点版本历史

