# UIKG 3.0.1 证据与阅读投影

## 1. 证据原则

Canonical 知识必须可追溯，但证据本身不升格为阅读实体。冻结帧、Scout 输出、GPT 查询、locator、动作 Trace、断言和红框图通过引用进入 Page、Element、Transition 或 AuthorityContract。

证据等级不能混写：

- 用户认证事实使用 `sourceType: user_context` 和 AuthorityContract。
- 设备真实执行使用 Frame、locator、Trace 和 assertion。
- 模型理解必须注明模型角色和证据限制。
- 历史导入必须明确标记历史来源、缺失项和待对账状态。

## 2. 探索证据包

每次探索目录至少包含：

```text
explorations/<exploration-id>/
  scope.yaml
  frames/
  model-results/
  actions/
  coverage.yaml
  report.md
```

`scope.yaml` 必须记录 App、构建、环境、入口、范围、用户事实、权威契约、风险边界、共享组件边界和目标图谱路径。

每个稳定页面状态必须有：

1. 动画稳定后的全分辨率冻结截图。
2. 由截图字节确定的 `frameId`。
3. 独立 Scout 对全部可见候选的结构化清点。
4. GPT 对 Scout、用户事实和既有图谱的逐项对账。
5. 每个纳入 Canonical 的可见 Element 的 locator 或明确 unresolved。
6. 每个候选的归类结果和 Coverage 结论。

对每个可见设置行，Scout 必须分别清点最外层行容器、Label、当前值、帮助图标、帮助内容、设置控件、箭头/affordance 和其他稳定语义成员；未出现的角色不得凭 profile 猜造。GPT reconciliation 必须把该行分类为 `toggle_row`、`selector_row`、`help_toggle_row`、`action_row` 或 `unresolved_setting_row`，并逐项记录角色映射与预期交互边界。

设置行容器和每个纳入 Canonical 的子 Element 都必须独立定位。不同语义 Element 只有在视觉与命中区域确实相同且规范允许同一物理 Element 承担两个角色时才可复用 locator；不能把帮助图标、帮助气泡、Label 或开关重复框选为同一对象。

## 3. 动作证据

UI 识别、定位、操作和断言必须通过受控视觉 Agent 链路完成。禁止使用 OCR、UI Tree、Poco、XPath、固定坐标或 ADB 点击作为降级方式。ADB 只可以承担设备常亮等任务级守卫，不承担 UI 动作。

每次动作必须串行，并保存：

- 来源 Page/state；
- before Frame；
- before Frame 上的实时 locator；
- trigger Element；
- 动作类型与参数；
- action Trace；
- after Frame；
- 明确 postcondition；
- GPT 查询或断言结果；
- 风险、结果和返回 checkpoint。

动作结果只能使用：

- `executed_verified`；
- `executed_contract_contradicted`；
- `observed_boundary`；
- `blocked_external`；
- `blocked_permission`；
- `unresolved`。

每个非成功结果必须保留原因。契约冲突必须同时保留 expected、actual、构建、设备上下文和产品缺陷引用。

对“整行可点击还是仅尾部控件可点击”等边界歧义，证据包还必须保存：

- 候选命中区域及其各自 locator；
- Scout 与 GPT 的判定及置信限制；
- 用户认证事实，或风险允许时针对候选边界执行的判别动作；
- 每次判别动作的 before/after Frame、Trace 和 postcondition；
- 最终 `interactionBoundary` 结论，或明确的 unresolved 原因。

仅成功点击箭头不能自动证明文字或整行不可点击；仅成功点击整行某一点也不能自动证明所有子区域都可点击。没有用户认证事实时，交互边界结论必须与实际测试过的区域严格一致，未测试部分保持 unresolved。

帮助图标打开帮助气泡时，帮助图标和帮助内容必须分别拥有 locator。帮助内容的打开/关闭呈现使用 Element state 或 Observation 表达，不得把同一截图裁框重复登记为两个 Element。

## 4. Observation

Page 与 Element 的 `observations` 是运行实例的内嵌投影：

- 一个 Observation 对应一个冻结帧中的实际呈现。
- 同一稳定实体可以有多个 Observation。
- Observation 中允许保存坐标、当前文本、选中态、角标和设备差异。
- Observation 不能改变实体稳定身份。
- 当前帧未出现实体不代表实体失效。

全页截图是视觉证据基准。Element 红框图必须从对应全页截图确定性生成，红框不能超出图像边界，并与 locator 的 rect 一致。

## 5. 双模型职责

| 角色 | 职责 | 不得承担 |
| --- | --- | --- |
| Scout | 对冻结全帧清点全部可见控件、状态、容器和内容锚点 | 决定动作或直接创建 Canonical 身份 |
| GPT | 对账用户事实、现有图谱和 Scout 结果；规划、定位、操作和验证 | 用猜测替代缺失证据 |

Scout 和 GPT 冲突时保留双方结果，用户明确事实优先；必要时采集新帧或实际执行验证，不能投票猜测。

## 6. Coverage

Coverage 必须回答：

- 每个 Scout 候选如何归类；
- 每个可见控件、状态、菜单、滚动区域和动作是否处理；
- 每个 Page/state 是否完成清点；
- 每个可见设置行采用了哪个规范 profile，各 profile 角色如何映射，实际 Trigger 和不可操作成员如何确定；
- 每个允许目标的最终结果；
- 每个共享边界为何停止；
- 递归队列是否为空。

每个可见设置行必须已归入一个规范 profile；暂时无法分类或无法确定命中边界时必须记录 `unresolved_setting_row`。只交付截图、只描述页面、仅记录入口、存在未处理队列、遗漏设置行分类或存在 `unresolved_setting_row` 时，任务不能标记 `complete`。

## 7. Obsidian 投影

Obsidian 是派生阅读视图，不是第二份 Canonical。

允许的主类：

- App 首页；
- Page 卡片；
- Element 卡片；
- 紧凑导航路网索引；
- 探索报告；
- 待确认知识。

禁止创建独立的 PageInstance、ElementInstance、Frame、Transition 副本或预生成路径卡片。

### 7.1 Page 卡片

每个 Canonical Page 恰有一张 Page 卡片，必须展示：

- frontmatter 中的 ID、key 和 type；
- summary、状态和业务边界；
- 直接 Element；
- 入边、出边和 AuthorityContract；
- 每个 Page Observation 的独立 `frameId` 区块；
- 每个区块正文中的全页截图；
- 构建、设备/视口、时间、状态属性和证据等级。

### 7.2 Element 卡片

每个 Canonical Element 恰有一张 Element 卡片，必须展示：

- owner、parent 和 child；
- role、controlType、capabilities、状态和交互边界；设置行容器还必须展示 profile 与具名角色；
- Transition 和 AuthorityContract；
- 每个 Observation 的全页红框图；
- rect、center、dpr、当前状态、动态值、构建和来源帧。

### 7.3 导航索引

导航索引只保存共享导航范围、路网分区、统计、Graph Revision 和查询入口。它不得逐条复制全部 Canonical 边，不得保存任意起终点路线。查询结果必须逐步标明 `verified_transition` 或 `authority_contract` 及其运行证据状态。

## 8. 链接与资产

- Obsidian 完整性检查边界固定为 `knowledge_graph/obsidian/`。
- 该子树中的 Wikilink、图片和反向关系必须可解析。
- 每份 Markdown 至少有一条可解析入链或出链。
- Canonical 与 Obsidian 的 `featurePath` 必须一致。
- 不允许链接到 staging、rollback 或临时目录。
- 全页截图和红框图必须可读取且内容非空。

## 9. 隐私与真实性

禁止持久化：

- API Key、Base URL 和完整 `.env`；
- 明文设备 serial；
- UI Tree、Poco Tree、XPath、DOM/Page Source；
- 为整洁而改写的虚假截图或动作结果。

设备使用不可逆哈希引用。业务数据按项目策略保存或脱敏，但不得修改证据含义。模型配置诊断只能记录非敏感的模型名、family、intent 和 slot。

## 10. 发布门禁

发布前后都必须验证：

- Frame 内容引用、尺寸和坐标空间；
- locator 与 before Frame 绑定；
- redbox 与全页截图一致；
- 成功 Transition 的 before/action/after/postcondition 闭合；
- AuthorityContract 的权威状态与运行状态分离；
- Coverage 和递归队列闭合；
- Obsidian 卡片数量、链接、资产和关系；
- 不存在敏感配置和禁止证据来源。
