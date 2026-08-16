# 弹窗提醒间隔选择背景遮罩实时补采

- Exploration: `zto-connect-fat-messages-special-follow-popup-backdrop-repair-20260731-attempt1`
- Build: `android-package:com.zto.connect.fat@10542`
- Device: `sha256:b1485ad4b9da3cb307ec62ea7b5c062bd3753b1875f0897bdbe49cba51e5eb36`
- Frames: 2
- Actions: 2
- Evidence: live Midscene Worker B + independent Worker A on frozen frames
- Scope: complete popup-interval modal backdrop boundary
- Retry artifacts: 0 incomplete frames archived outside canonical coverage

## 规范与修复

- 规范：`UIKG 3.0.1`；Schema：`3.0.0`。
- 规范哈希：`sha256:03904e083f55a42e36b035db877d2bf575f6973426a2abde089326b51833969f`。
- Element：`messages.special_follow.settings.popup_interval_selector.backdrop`；稳定 ID、owner、capability 均保持不变。
- 旧 locator：`500,1452,652,113`，只覆盖面板上方局部空白，与“完整背景遮罩”语义不一致。
- 新 locator：`0,251,1152,1299`，覆盖标题栏下方至白色选择面板上边缘的完整半透明区域。
- 新 Frame：`sha256:6d030f335a32821f0bebfd4c614837258d165747f682a185c6d15bd216d3de90`。

## 发布与门禁

- Graph Revision：`zto-connect-uikg301-20260731.3`。
- Canonical diff：1 个 Element 更新、Manifest 和物化审计更新；Page、Transition、AuthorityContract、共享导航及历史 ID 未改变。
- JSON Schema：173 条记录通过。
- 图级关系与投影：14 Page、105 Element、47 Transition、1 AuthorityContract、122 份 Obsidian 文档通过。
- 视觉门禁：新红框位于 1152x2376 全帧边界内，与实时 locator 一致，未包含标题栏或白色选择面板。
- 测试：9 个容器/profile 单测和 4 个导航查询测试通过。
- 查询：`messages.root` 到 `messages.special_follow.settings.popup_interval_selector` 的 3 步路径可按需确定性计算。
- 幂等性：发布前两次物化一致；发布后活动 App、Obsidian、Normalization 与独立物化结果逐字节一致。
- 回滚：`knowledge_graph/.rollback/before-popup-backdrop-redbox-repair-20260731`。
- 图谱总体状态仍为 `incomplete`，仅因为其他历史特别关注状态保留 仅 Worker B 证据；本次背景遮罩修复范围已闭合。
