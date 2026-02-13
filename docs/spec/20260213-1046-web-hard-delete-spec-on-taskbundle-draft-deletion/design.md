# 删除 TaskBundle 草稿时，硬删除对应 Spec - 设计文档

## 总体思路
- spec 的关联关系以草稿记录中的 `bundle.specRef` 为准（该字段由 planner 生成 spec 后回填到 bundle）。
- 删除草稿（DELETE）时：
  1) 读取 draft
  2) 校验 draft 状态必须为 `draft`
  3) 若存在 `bundle.specRef`，将其解析为绝对路径并校验位于 `docs/spec/**`
  4) 递归删除该目录
  5) 将草稿状态更新为 `deleted`

## 关键约束
- 必须加入状态机护栏：`approved` 草稿不允许被 DELETE 标记为 `deleted`（避免误删已生效 spec）。
- 删除 spec 的路径校验需要与 `specRecording` 的安全策略一致（仅允许 `docs/spec/**`）。

## 失败处理
- 若 spec 删除失败（权限/IO 错误等），应返回错误并提示（避免“草稿已删但 spec 未删”的静默不一致）。
- 若 spec 目录不存在，可视为已清理，继续完成草稿删除。
