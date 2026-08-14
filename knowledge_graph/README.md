# UI Knowledge Graph

本知识库使用 UIKG 3.0.1。唯一权威规范入口是 [`spec/README.md`](spec/README.md)；活动图谱、物化策略、探索报告、迁移账本、Obsidian 卡片和工具代码都不能替代或覆盖该规范。

活动机器图谱位于 `apps/zto.connect`，Obsidian 阅读投影位于 `obsidian/zto.connect`。业务 Page 按自身功能组织；普通容器与共享容器遵守相同的双向父子完整性规则，`shared_component` 只表示跨页面共享作用域。Page 只直接引用顶层页面 Element 和直接可用的共享根，不直接引用容器后代。

## 规范

- 总体规范：[`spec/UIKG-3.0.1.md`](spec/UIKG-3.0.1.md)
- 本体和字段：[`spec/ontology.md`](spec/ontology.md)
- 关系不变量：[`spec/relationship-invariants.md`](spec/relationship-invariants.md)
- 证据与投影：[`spec/evidence-and-projection.md`](spec/evidence-and-projection.md)
- 迁移策略：[`spec/migrations/UIKG-3.0.1-migration-policy.md`](spec/migrations/UIKG-3.0.1-migration-policy.md)
- 结构 Schema：[`spec/schemas/README.md`](spec/schemas/README.md)

仓库不再保留并行的旧版本规范。`observations/` 中的迁移账本和历史限制记录仅用于追溯；`materialization/` 和 `tools/` 中的任务输入只用于确定性物化或兼容处理，均不是规范来源。

## 验证

运行当前结构检查：

```bash
uv run python knowledge_graph/tools/validate_normalized_zto_graph.py --root knowledge_graph
```

该检查必须同时覆盖 Schema、跨文件关系、共享容器、导航闭合、Canonical/Obsidian 一一投影、资产、链接、空目录和迁移可解析性。实现规则与 `spec/` 冲突时，以 `spec/` 为准并修正实现。

## 查询

导航只在 Canonical 中保存一次已验证的原子 Transition；Obsidian 的导航路网索引不展开边或路线。给定起点和终点后按需计算路径：

```bash
node knowledge_graph/tools/query_navigation_paths.mjs --from messages.root --to messages.special_follow.settings --profile shortest --pretty
```

Canonical 只保存已验证原子 Transition 和唯一 AuthorityContract；导航索引不复制全量边或路线，具体路径按当前 Graph Revision 查询计算。

## 当前状态

当前特别关注物化、共享导航迁移和检查结果位于 `normalization/zto-connect-fat-messages-special-follow-normalization-20260728`。退出 Canonical 的旧 ID 由 `apps/zto.connect/observations/shared-navigation-model-migrations.yaml` 保持可查询。

当前底部导航的历史导航记录仍缺少完整原子证据，特别关注历史探索也缺少独立 Scout 结果，因此活动图谱保持 `incomplete`。结构正确不等于探索证据完成。
