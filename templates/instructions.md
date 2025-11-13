## rules:
1. 数据库文件保护：未经明确许可，禁止删除或覆盖任何数据库文件。
2. 提交策略：未经授权不得执行 git commit / push 等提交行为，也不得添加co-author。
3. 文档位置：所有新增文档必须位于 docs/ 目录内，严禁在其外部写文档。
4. 脚本创建：未经允许不得在项目根目录新建脚本或可执行文件。
5. 讨论阶段：方案讨论未结束或未得到批准时，禁止开始编写代码。
- 违反任一条即停止

## work-flow:
1. 文档目录结构
    •  所有规格类文档统一置于 docs/spec/<feature-name>/。
    •  每个功能目录内必须包含
       requirements.md、design.md、implementation.md，命名固定，大小写一致。

  2. 顺序不可跳步骤
    使用docs/template下的模板
    1. 需求 → 先写 requirements.md，需求不清楚时必须先提问，直到确认范围。
    2. 设计 → 完成需求文档后方可撰写 design.md。
    3. 实现计划 → 设计评审通过后再写
       implementation.md（明确任务分解、验证方式、风险）。
    4. 编码 → 仅能依据 implementation.md 执行开发，禁止未记录的临时改动。

  **重要：ADS 工作流集成（严格遵守）**
    •  开始新功能开发时，必须先提醒用户执行 `/ads.new <标题>` 创建工作流。
      这会自动创建文档目录、从模板复制文件并在数据库中创建记录。
    •  **禁止**在用户未执行 `/ads.new` 之前直接创建 docs/spec/<feature-name>/ 目录或文档文件。
    •  只有通过 ADS 命令创建的工作流才会正确同步到数据库。
    •  完成 requirements.md 后，提醒用户执行 `/ads.commit requirement` 标记完成。
    •  完成 design.md 后，提醒用户执行 `/ads.commit design` 标记完成。
    •  完成 implementation.md 后，提醒用户执行 `/ads.commit implementation` 标记完成。
    •  如果用户已经手动创建了文档，需要使用 `/ads.new` 重新创建工作流来同步数据库。
    •  可以使用 `/ads.status` 查看当前工作流状态。

  3. 评审与变更
    •  文档若需修改，必须按“需求 → 设计 → 实施”链条依次更新，避免跳级。
    •  开发阶段如需新增需求，先退回补充 requirements.md，再重跑后续流程。

  4. 开发验证
    •  编码完成后，依据 implementation.md
       的验证清单执行测试；任何遗漏测试视为流程违规。
    •  测试记录不必写入文档，但要在提交说明中引用实施计划对应的任务编号。
