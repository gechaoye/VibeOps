# APP UI Knowledge Graph 3.0.1

| 属性 | 值 |
| --- | --- |
| 规范版本 | UIKG 3.0.1 |
| Schema 版本 | 3.0.0 |
| 状态 | Current Normative Standard |
| 生效日期 | 2026-07-31 |
| 事实源 | `knowledge_graph/spec/` |

## 1. 目标

UIKG 描述 App 中稳定、可复用、可追溯的页面、元素、交互和产品行为。它服务于 UI 探索、路径规划、测试设计、知识查询和人工阅读，但不是截图目录、UI Tree 镜像、OCR 文本库或坐标定位器集合。

UIKG 3.0 的核心目标是：

- 稳定知识与运行观测分离，但在同一 Page/Element 阅读实体中聚合展示。
- 页面、元素、容器和共享组件拥有唯一且无歧义的归属关系。
- 已执行行为与用户认证的产品契约分开保存。
- 每条知识都可以追溯到用户上下文、设备帧、定位、动作、断言或迁移审核。
- Canonical 是机器事实源，Obsidian 是可重建的阅读投影，路线是按需查询结果。

## 2. 三个数据平面

### 2.1 Canonical 图谱

`apps/<app-key>/` 是发布后的权威机器图谱，包含：

- 一个 Application；
- Page；
- Element；
- 已执行并闭合的 Transition；
- AuthorityContract；
- Manifest；
- 非 Canonical 实体的迁移和审计辅助记录。

Canonical 不创建独立的 PageInstance、ElementInstance、坐标节点、截图节点或预生成路线节点。每次页面与元素观测以内嵌 `observations` 保存，并引用不可变探索证据。

### 2.2 Exploration Evidence

`explorations/<exploration-id>/` 保存任务范围、冻结全帧、Worker A/B 原始答卷、字段合并决策、实时 locator、动作 Trace、断言、Coverage 和报告。证据可以支持或反驳 Canonical 知识，但不能仅因某帧缺失就删除稳定实体。

### 2.3 Obsidian 投影

`obsidian/<app-key>/` 是从同一 Graph Revision 确定性生成的阅读视图。每个 Canonical Page 和 Element 各有且仅有一张卡片；帧、定位和状态作为卡片内观测，不生成实例卡片。

## 3. 知识类型

### 3.1 运行事实

冻结截图、设备上下文、元素几何、动作结果和断言属于运行事实。运行事实必须绑定明确的帧、时间和来源，不得被模型总结覆盖。

### 3.2 稳定知识

页面业务身份、元素语义身份、能力、owner、容器结构和已验证 Transition 属于稳定知识。稳定身份不得由坐标、颜色、角标数字、临时文案、采集顺序或截图哈希决定。

### 3.3 用户权威知识

用户明确认证的产品行为属于权威知识，使用 AuthorityContract 保存。权威状态和运行证据状态正交：

- `authorityStatus: authority_certified` 表示产品定义已确认；
- `runtimeEvidenceStatus: pending` 表示尚未实测；
- `verified` 表示存在语义一致的闭合 Transition；
- `contradicted` 表示当前构建的实测结果与契约冲突，并必须关联产品缺陷。

运行反例不能静默删除或降级用户认证的产品契约。

## 4. Canonical 实体

UIKG 3.0 只定义五类 Canonical 实体：

| 实体 | 含义 | 是否参与导航 |
| --- | --- | --- |
| Application | 被探索 App 的稳定身份 | 否 |
| Page | 稳定可到达的业务 UI 表面 | 作为节点 |
| Element | 控件、状态指示、结构容器或稳定内容锚点 | 可作为触发器 |
| Transition | 一次真实执行并验证的原子动作边 | 是 |
| AuthorityContract | 用户认证的预期行为边 | 是 |

Page 的稳定状态定义嵌入 `states`。共享导航抽屉、菜单展开和类似覆盖呈现如果没有独立业务身份、标题和返回语义，应建为 Element 状态，不建 Page。通用选人器、会话等具有独立业务表面的 App 级组件可以建边界 Page，但未探索内部不得标记为完整。

完整字段定义见 [ontology.md](ontology.md)。

## 5. Element 归属与容器模型

每个 Element 必须且只能有一个 owner：

| `owner.kind` | 适用对象 | `owner.ref` |
| --- | --- | --- |
| `application` | 顶层共享 Element | Application ID |
| `page` | Page 直接持有的顶层页面内 Element | Page ID |
| `component` | 页面内容器的后代 Element | 父 Element ID |
| `shared_component` | 共享容器的后代 Element | 父共享 Element ID |

`component` 与 `shared_component` 使用完全相同的父子结构规则。二者的唯一区别是作用域：前者最终归属于一个 Page，后者最终归属于 Application 持有的共享根。

页面只直接引用自身顶层 Element 和在该页面可用的顶层共享 Element。页面禁止直接引用容器的子孙 Element。容器和子元素必须通过 `childElementRefs`、`owner.ref`、`parentElementRef` 和关系引用形成双向闭合。

统一容器模型同样强制适用于设置页。一个视觉上稳定的设置行只要包含两个或更多可区分的语义部分，例如名称、当前值、帮助图标、帮助气泡、开关或箭头，就必须建立一个顶层行容器，再把各语义部分建为其子 Element。行容器必须通过 `composition.profile` 分类为：

- `toggle_row`：名称和设置控件；
- `selector_row`：名称、当前值和实际选择触发器，可包含独立 affordance；
- `help_toggle_row`：名称、帮助触发器、帮助内容和设置控件；
- `action_row`：说明内容和独立动作触发器。

设置行直接位于页面时，页面只引用行容器；设置行嵌套时，页面只引用其顶层祖先，不能越过容器引用行内成员。Label、当前值和帮助内容默认不可点击；帮助图标、开关、箭头或经证据确认的整行命中区域分别承担自己的能力。不能从“文字与箭头同处一行”推断文字或整行可点击，整行可点击还是仅尾部控件可点击必须由运行证据或用户认证事实确定。

例如：

```text
特别关注提醒 Page
└── 我的特别关注总容器 Element          owner.kind: page
    ├── 我的特别关注说明文案 Element    owner.kind: component, 不可点击
    └── 右侧箭头 Element                owner.kind: component, 可点击
```

页面的 `elementRefs` 只包含总容器；Transition 和 AuthorityContract 的 `triggerElementRef` 指向右侧箭头。

完整关系规则见 [relationship-invariants.md](relationship-invariants.md)。

## 6. Page 与状态

Page 表示具有稳定业务身份的可到达表面。以下变化通常只建状态或观测：

- 空态与非空态；
- 开关值和选择值；
- 未读、高亮、角标呈现；
- 滚动位置和可见区域；
- 短暂 Loading；
- 共享菜单、抽屉或展开层的打开与关闭。

只有主要内容集合、业务标题、导航角色或独立返回行为发生稳定变化时才新建 Page。

每个 Page 必须有 1 至 3 段 `featurePath`，按自身业务能力归类，不能按“从哪里进入”归类。例如从“更多”进入的超级表单 Page 仍归入“超级表单”，不归入“底部导航”。

## 7. Transition 与 AuthorityContract

Transition 只保存真实执行且后置条件通过的原子动作：

```text
source Page/state -> trigger Element -> action -> target Page/state
```

Transition 必须有 before Frame、动作前 locator 所属帧、action Trace、after Frame 和通过的 postcondition。仅看见一个控件不能建立成功 Transition。

AuthorityContract 保存产品“应该如何工作”的权威边。`pending` 契约可以参与规划，但查询结果必须标明 `edgeKind: authority_contract`，不能伪装成已验证 Transition。共享导航的同一语义动作只保存一份契约，通过共享 Element 可用范围确定来源，不能按页面笛卡尔积复制。

Canonical 只保存原子边，不保存任意起终点之间的路线。路径必须从同一 Graph Revision 的 Transition 和可规划 AuthorityContract 即时计算。

## 8. 证据与开放世界

UIKG 使用开放世界假设：未观测不等于不存在。模型或设备证据不足时必须使用 `unknown`、`unresolved`、待对账 Coverage 或明确限制，不能制造确定事实。

每个 Element 至少需要一个来源帧及 locator；无法定位时必须保留明确的 unresolved 记录，不能用固定坐标、OCR、UI Tree、Poco 或 XPath 降级。动态数值和业务数据只能进入 `observations.dynamicValue` 或状态属性。

证据与投影细则见 [evidence-and-projection.md](evidence-and-projection.md)。

## 9. 稳定身份

- `id` 是全局稳定 ULID；跨文件引用必须使用 ID。
- `key` 是 App 内唯一的稳定语义键；发布后不得复用于不同语义。
- `label` 是可读名称，可以经审核调整，不承担引用身份。
- `featurePath` 只负责组织，不参与身份。
- 同一稳定语义延续原 ID；只有新语义才创建新 ID。
- 拆分、合并、改型或退出 Canonical 必须写迁移账本，使旧 ID 可查询到目标和原因。

## 10. 目录

```text
knowledge_graph/
  spec/
  apps/<app-key>/
    application.yaml
    manifest.yaml
    pages/<featurePath 1..3>/
    elements/<featurePath 1..3>/
    transitions/<featurePath 1..3>/
    authority-contracts/<featurePath 1..3>/
    observations/
  explorations/<exploration-id>/
  obsidian/<app-key>/
    首页.md
    页面/<featurePath 1..3>/
    元素/<featurePath 1..3>/
    导航/
    探索/
    assets/
```

Page 和 Element 不得平铺在类型根目录。功能树不得保留空目录或同一实体的跨目录副本。机器图谱文件名使用稳定 key；Obsidian 文件名使用稳定可读 label，并由 frontmatter 保存 ID 和 key。

## 11. 发布

任何更新必须：

1. 记录活动图谱基线、实体 ID 集合、公共导航和内容哈希。
2. 在独立 staging 物化候选图谱和 Obsidian 投影。
3. 校验结构 Schema、关系不变量、证据、目录、资产和链接。
4. 审阅语义 diff，区分新增、修改、迁移和意外删除。
5. 原子发布 Canonical、Manifest 和投影。
6. 在活动目录重新校验，并执行至少一次确定性查询与幂等物化检查。

普通探索更新默认只允许 additive upsert。删除或替换稳定实体必须遵守 [UIKG-3.0.1-migration-policy.md](migrations/UIKG-3.0.1-migration-policy.md)。

## 12. 完成状态

`complete` 表示本次范围内递归队列、候选配对与字段合并、允许动作、双 Worker 证据、Canonical、投影和全部门禁都已闭合。

以下任一情况存在时必须使用 `incomplete`：

- 任一 Worker 未覆盖要求的冻结帧且没有明确的失败与续写记录；
- 仍有未处理的候选配对或字段差异；
- 可见设置行未归入规范 profile、存在 `unresolved_setting_row`，或实际交互边界尚未确定；
- 仍有未处理或无原因的队列项；
- 实际经过的 AuthorityContract 仍为 `pending`；
- 存在游离 Element、断裂关系或未闭合成功 Transition；
- Obsidian 存在缺失卡片、断链或游离文档；
- 历史公共知识被意外减少；
- staging 尚未发布或发布后未重新验证。

结构正确但证据不足仍然是 `incomplete`。
