# UIKG 3.0.1 迁移策略

本文只定义当前 UIKG 3.0.1 的迁移行为；本目录不保留任何旧版本迁移策略作为并行规范。

## 1. 基本原则

- 普通探索更新默认是 additive upsert。
- 未在当前帧出现、当前 scope 未覆盖或模型单次漏检都不是删除依据。
- 语义未变时必须沿用既有 ID 和 key。
- `featurePath`、文件名、label 或展示位置变化不得产生新身份。
- 删除、合并、拆分、改型和 owner 修正必须经过明确审核并写入迁移账本。
- 迁移后旧实体可以退出 Canonical，但旧 ID 必须持续可查询到目标和原因。

## 2. 需要迁移账本的变更

以下变更必须建立 `UiGraphMigrationLedger`：

- Page 改型为 Element 或 Element 状态；
- Element 改型为 Page；
- 多个错误重复实体合并为一个；
- 一个错误聚合实体拆分为多个稳定语义实体；
- owner 或组件边界修正导致原实体语义身份变化；
- 同一抽屉、菜单或覆盖层从错误包装实体迁移为已有 Element 状态；
- 稳定 key 被废弃或重定向。

纯目录移动、label 澄清、补充 evidence、补齐反向引用和非身份字段修正不创建新 ID，但仍应出现在语义 diff 中。

## 3. 迁移记录

每条迁移至少包含：

```yaml
- oldId: <stable-id>
  oldKey: <stable-key>
  oldEntityType: Page | Element | Transition | AuthorityContract
  targetRef: <stable-id>
  targetKey: <stable-key>
  targetEntityType: Page | Element | Transition | AuthorityContract
  targetStateKey: null | <state-key>
  reason: <明确的语义修正原因>
  reviewedBy: <审核来源>
```

一对多拆分时使用多个目标并说明各自语义；多对一合并时每个旧 ID 都必须有独立迁移项。无法确定目标时不得静默删除，应保留 tombstone 或 unresolved 迁移记录。

## 4. 复合元素与设置行迁移

把错误聚合的“整行入口”拆分为容器、说明文字和独立触发器时：

1. 先从用户事实和运行证据确定最外层语义容器、全部稳定成员、设置行 profile 和真实交互边界，不能从旧 key 或旧 `controlType` 猜测。
2. 为新增语义实体创建稳定 ID。旧实体如果明确表示实际设置控件或 Trigger，优先保留其 ID 并迁移为相应子 Element；如果明确表示整行语义，优先保留为容器；语义发生拆分或重定向时写迁移账本。
3. 为行容器设置 `composition.profile`，并按 profile 填写必需角色。不能给所有设置行统一补成 `label/helpTrigger/helpPopover/settingControl` 四个角色。
4. Page 的直接引用改为总容器；子元素通过 owner、parent、child 和 relationshipRefs 形成双向关系。
5. Transition 和 AuthorityContract 改为引用实际 Trigger。帮助动作、设置动作和选择动作必须分别指向对应角色。
6. Label、当前值、帮助内容、说明内容和默认 Container 的不可操作性必须显式记录；整行可点击或仅尾部控件可点击必须有用户认证事实或运行证据。
7. 为容器和每个子 Element 重新生成与各自 locator 一致的红框图。不得沿用导致不同语义子元素重复框选的错误标注。
8. 合并或退出重复帮助图标、重复帮助内容和错误聚合实体时，为每个旧 ID 写明目标与原因；不能在 Canonical 或 Obsidian 中留下同义重复。
9. Obsidian 删除退出 Canonical 的旧卡片，只保留新 Canonical 实体的一一投影。

如果现有 Page-owned `list_entry`、`toggle` 或同义 Element 的证据已经显示它实际代表复合设置行，必须按本节迁移后才能声明符合 UIKG 3.0.1。尚未补齐 profile、角色或点击边界证据时，图谱保持 `incomplete`，不得以历史结构兼容为由跳过。

## 5. 共享组件迁移

把错误归属于某个 Page 的公共导航迁移为共享组件时：

1. 共享根由 Application 持有。
2. Page 与共享根建立 `elementRefs/availableOnPageRefs` 双向关系。
3. 所有共享后代使用 `owner.kind: shared_component`。
4. 父共享 Element 补齐 `childElementRefs` 和 child 关系。
5. 抽屉或菜单若只是稳定 Element 的展开呈现，迁移为该 Element 状态。
6. 同一共享动作的 AuthorityContract 只保存一份。
7. 所有受影响 Page 的可用性通过 owner 链计算，不复制后代引用。

## 6. 发布流程

1. 记录迁移前 ID/key/公共关系/文件/哈希基线。
2. 在 staging 应用 upsert、迁移和投影重建。
3. 校验旧 ID 都能通过账本解析。
4. 对比实体集合、关系、目录、卡片和导航语义。
5. 确认没有无迁移依据的实体减少。
6. 原子发布 Canonical、Manifest、迁移账本和 Obsidian。
7. 发布后重新运行结构、关系、链接、查询和幂等性检查。

## 7. 禁止事项

- 禁止为通过校验而排除某一 owner kind 的通用容器规则。
- 禁止把旧错误实体保留在 Canonical 中形成同义重复。
- 禁止保留旧规范作为并行有效模型。
- 禁止修改或伪造原始探索证据。
- 禁止用一次反例撤销用户认证的 AuthorityContract。
- 禁止让迁移后的空目录、旧卡片或旧路网投影继续参与阅读和查询。
