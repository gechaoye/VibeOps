# UIKG 3.0 统一容器闭包修正报告

本次按 UIKG 3.0 修正了活动图谱、物化器、校验器和 Obsidian 投影。没有新增、删除或迁移 Canonical 实体，也没有修改历史证据。

## 图谱变化

- `shared.bottom_navigation` 现在双向持有 5 个底部 Tab。
- `shared.bottom_tab.more` 现在双向持有 15 个更多抽屉入口。
- 每个子元素继续使用既有 `owner.kind: shared_component`、`owner.ref` 和 `parentElementRef`。
- 两个父容器的 `childElementRefs`、`child:<id>` 和 Obsidian 子元素区块已经同步。
- “我的特别关注”仍保持 Page -> 总容器 -> 说明文案/右侧箭头模型，Transition 与 AuthorityContract 继续只引用箭头。

## 实现变化

- 物化器从 canonical owner 边统一派生页面容器和共享容器的双向关系。
- 校验器反向检查所有 `component/shared_component` 子元素，验证 owner 终止点、无环性、Manifest root hash 和 Graph Revision。
- 路径查询结果输出同一 Graph Revision 和 root hash。

## 验收

- UIKG 3.0 Schema：149 条记录全部通过。
- 图级校验：15 Page、80 Element、48 Transition、1 AuthorityContract 全部通过。
- Obsidian：98 个文档的卡片、链接、资产和子元素展示通过。
- 路径查询：`messages.special_follow.settings` 到 `messages.special_follow.people` 为 1 步 verified Transition，触发元素是右侧箭头。
- 幂等性：第一次 staging 与发布后第二次物化的 Canonical、Obsidian 逐文件一致。

活动图谱仍为 `incomplete`，唯一原因是既有探索证据缺少独立 worker_a，并仍有明确待补项；该状态不再包含结构违规。

