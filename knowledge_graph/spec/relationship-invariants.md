# UIKG 3.0.1 关系不变量

本文定义不能仅依靠单文件 JSON Schema 验证的图级约束。所有约束同时适用于 staging 和活动图谱。

## 1. 引用基础规则

- 所有跨实体引用必须使用稳定 ID，不得使用 key、label、文件名或数组位置。
- 每个引用必须解析到同一 Application 内的正确实体类型。
- `id` 和 `key` 在同一 App 图谱内分别唯一。
- 每个 Element 必须有 owner、至少一个来源 Observation 和至少一条有效关系。
- Canonical 中禁止游离 Element、断裂 Transition 和断裂 AuthorityContract。
- Owner 链和父子链必须无环，并且必须在有限步内终止于 Page 或 Application。

## 2. 统一容器模型

### 2.1 容器身份

任何拥有直接子 Element 的 Element 都是结构意义上的容器，不要求其 `elementType` 必须为 `container`。例如“更多”既是可点击触发器，也可以在 `open` 状态下持有抽屉入口。

`component` 和 `shared_component` 不代表两种容器结构：

- 二者都必须形成完整、双向、无环的父子关系；
- `component` 表示其祖先链最终归属于 Page；
- `shared_component` 表示其祖先链最终归属于 Application 持有的共享根。

任何实现不得通过排除 `shared_component` 来绕过容器完整性校验。

### 2.2 双向父子闭合

若父 Element `P` 直接持有子 Element `C`，必须同时满足：

```text
C.owner.ref == P.id
C.parentElementRef == P.id
P.childElementRefs contains C.id
C.relationshipRefs contains "owner:<P.id>"
C.relationshipRefs contains "parent:<P.id>"
P.relationshipRefs contains "child:<C.id>"
```

Owner kind 按共享作用域决定：

```text
P 最终归属于 Page        => C.owner.kind == component
P 最终归属于 Application => C.owner.kind == shared_component
```

反向也必须成立：`P.childElementRefs` 中的每个 ID 都必须引用 owner 为 P 的直接子元素；所有 owner 为 P 的直接子元素都必须出现在 `P.childElementRefs` 中。

### 2.3 顶层元素

Page 内顶层 Element：

```text
E.owner.kind == page
E.owner.ref == Page.id
E.parentElementRef == null
Page.elementRefs contains E.id
E.relationshipRefs contains "owner:<Page.id>"
```

顶层共享 Element：

```text
E.owner.kind == application
E.owner.ref == Application.id
E.parentElementRef == null
E.availableOnPageRefs contains every directly available Page.id
every available Page.elementRefs contains E.id
```

Application 持有的 Element 没有 `availableOnPageRefs` 时，不得假设它在所有 Page 自动可用。

## 3. Page 引用边界

Page 的 `elementRefs` 是直接可用关系，不是扁平化的所有后代清单。

Page 必须直接引用：

- `owner.kind: page` 且 `owner.ref` 为该 Page 的顶层 Element；
- 在该 Page 上直接可用的 Application 持有共享根 Element。

Page 禁止直接引用：

- `owner.kind: component` 的页面内容器后代；
- `owner.kind: shared_component` 的共享容器后代；
- 其他 Page 持有的 Element；
- 仅由祖先共享 Element 间接可用的后代。

后代在 Page 上的可用性必须通过 owner 链继承计算。算法如下：

```text
elementAvailableOnPage(E, Page):
  if E.owner.kind == page:
    return E.owner.ref == Page.id
  if E.owner.kind == application:
    return Page.id in E.availableOnPageRefs
  if E.owner.kind in {component, shared_component}:
    return elementAvailableOnPage(parent(E), Page)
  return false
```

此算法用于 Transition、AuthorityContract 和查询器，不得为方便查询而把所有后代复制进 Page。

## 4. 复合控件与设置行

### 4.1 通用复合控件

当一块稳定视觉区域包含两个或更多可区分的语义部分时，必须先建立总容器，再分别建立说明内容、状态内容和实际触发控件。是否需要拆分取决于语义与交互边界，不取决于控件 key、业务目录或 `component/shared_component` 作用域。

```text
Page or Shared Ancestor
└── Composite Container
    ├── Explanatory Element: capabilities = [], actionable = false
    └── Trigger Element: actionable = true, owns capability
```

必须遵守：

- 页面或共享祖先只直接引用 Composite Container，不能越过容器引用其后代。
- Container 默认 `capabilities: []` 且 `interactionBoundary.actionable: false`；只有真实证据确认容器本身是命中区域时才可操作。
- Label、当前值、帮助内容和其他说明内容默认 `capabilities: []` 且不可操作。
- Trigger 使用与真实控件一致的类型并承担 capability。
- Transition 与 AuthorityContract 的 `triggerElementRef` 只能指向实际 Trigger。
- `presentation` 或 `composition` 必须表达成员语义和空间关系。
- 不得因文字、箭头、开关或当前值同处一行，就推断文字、整行或相邻成员可点击。

如果整行和尾部箭头都能触发同一行为，应分别建立实际可操作 Element；如果整行是唯一 Trigger，则箭头建为不可操作 affordance；如果仅箭头可点，则容器与文字都不可操作。选择必须由运行证据或用户权威事实决定。

### 4.2 设置行适用性

满足以下任一条件的稳定视觉行属于设置行候选：

- 同时包含设置名称与开关、单选、选择器或其他设置控件；
- 同时包含设置名称、当前值与箭头等 affordance；
- 包含帮助图标或点击后显示的帮助内容；
- 同时包含说明内容和独立动作入口；
- 双 Worker 答卷、字段合并或用户认证事实明确指出该行存在多个语义成员或多个交互边界。

每个设置行候选必须产生以下两种结果之一：

1. 物化为一个设置行容器，并按 [ontology.md](ontology.md) 第 4.3 节使用 `toggle_row`、`selector_row`、`help_toggle_row` 或 `action_row` 分类。
2. 在 Exploration Coverage 中标记 `unresolved_setting_row`，记录缺失的 profile 或交互边界证据，并保持任务 `incomplete`。

禁止用单个 Page-owned `list_entry`、`toggle` 或其他扁平 Element 代表证据已经识别出的复合设置行。控件在视觉上位于同一行、只有一个主要动作或历史数据采用扁平建模，都不能豁免此规则。

### 4.3 设置行结构闭合

对每个已物化设置行：

- 行容器是该行的最外层语义 Element；如果它直接位于 Page 上，则使用 `owner.kind: page`，Page 的 `elementRefs` 只引用该容器。如果它位于另一容器内，则按第 2 节使用 `component` 或 `shared_component`，Page 仍不得直接引用行内成员。
- `composition.profile` 必须是四个规范 profile 之一，`composition.roles` 必须包含该 profile 的全部必需角色，只能按该 profile 校验角色集合，禁止统一要求所有设置行具有四个成员。
- 每个角色引用和 `childElementRefs`、子 owner/parent、`relationshipRefs` 必须闭合。除 `selector_row.settingTrigger` 经证据指向容器自身外，角色引用必须是直接子 Element。
- 每个可见的稳定语义成员都必须有独立角色或位于角色所指的嵌套容器内；同一物理 Element 只有在 `selector_row` 的 affordance 同时就是实际 Trigger 时，才可同时承担 `affordance` 与 `settingTrigger`。
- 角色的 capability 和 `interactionBoundary.actionable` 必须符合本体定义。Label、当前值、帮助内容或说明内容成为 Trigger 时，必须有独立动作证据并调整结构，不能仅把其 `actionable` 改为 true。
- Transition 与 AuthorityContract 必须引用 profile 定义的实际触发角色。`help_toggle_row` 的帮助动作引用 `helpTrigger`，设置动作引用 `settingControl`；二者不能互相替代。
- 设置行容器与全部角色必须有各自对应的 locator/redbox，且框选范围与同一来源帧中的实际语义边界一致；不得复用同一个局部框伪装成多个不同子 Element。

### 4.4 图级拒绝条件

图级校验器必须拒绝：

- 双 Worker 证据及字段合并已识别为复合设置行，却仍由 Page 直接持有单个扁平 `list_entry`、`toggle` 或同义控件；
- 设置行容器缺少 profile、缺少必需角色、使用其他 profile 的必需角色集合，或角色引用不满足父子闭合；
- Page 直接引用设置行子元素；
- 说明内容、当前值或帮助内容在无独立证据时拥有 capability 或成为 Transition/AuthorityContract Trigger；
- 实际 Trigger 没有对应 capability、actionable 边界或运行/权威证据；
- 同一 locator/redbox 被无证据地重复用于多个语义不同的设置行成员；
- Manifest 或探索报告标记 `complete`，但仍有未分类的可见设置行或 `unresolved_setting_row`。

## 5. FeaturePath 与可读名称

### 5.1 Page 和页面内 Element

- Page 使用自身业务功能路径。
- `owner.kind: page` 或 `component` 的 Element 必须与最终归属 Page 的 `featurePath` 完全一致。
- 页面内层级通过 label、owner 和 parent 表达，不通过继续增加目录深度表达。

### 5.2 共享 Element

- Application 持有的共享根使用唯一组件功能路径，例如 `[底部导航]`。
- 共享后代可以与父 Element 使用相同路径，也可以在父路径末尾增加一个稳定组件分区。
- 子路径必须等于父路径或以父路径为前缀，且总长度为 1 至 3。
- 示例：底部导航 Tab 使用 `[底部导航]`；“更多”的抽屉入口使用 `[底部导航, 更多]`。

因此，统一容器模型不等于强制所有共享父子使用完全相同的 `featurePath`。

### 5.3 文件与 label

- 机器 YAML 文件名使用稳定 key；目录由 `featurePath` 决定。
- Obsidian 卡片文件名使用稳定可读 label。
- 页面内 Element label 应使用稳定业务父链消歧。
- 共享 Element label 使用最近的人类可理解容器链；当目录已经表达上层组件时，不要求重复完整祖先 label。
- 命名规则不得替代 owner、parent 或 child 关系校验。

## 6. Page 关系闭合

对每个 Page：

- `elementRefs` 必须满足第 3 节的直接引用规则。
- `inboundTransitionRefs` 必须等于所有 `targetRef == Page.id` 的 Transition ID 集合。
- `outboundTransitionRefs` 必须等于所有 `sourceRef == Page.id` 的 Transition ID 集合。
- `inboundAuthorityContractRefs` 必须等于所有预期目标为该 Page 的 AuthorityContract ID 集合。
- `outboundAuthorityContractRefs` 必须等于所有精确来源为该 Page 的 AuthorityContract ID 集合。
- Page 卡片必须显示相同的元素、入边、出边和契约关系。

共享可用范围契约不应复制成每个 Page 的独立契约；是否将同一契约 ID列入多个 Page 的派生引用，由投影器确定，但 Canonical 契约本体只能有一份。

## 7. Transition 闭合

每个成功 Transition 必须满足：

- `sourceRef`、`targetRef` 解析到 Page。
- `triggerElementRef` 解析到 Element。
- Trigger 根据第 3 节算法在 Source Page 可用。
- Trigger 拥有与 `capability` 一致的能力。
- Trigger 的 `relationshipRefs` 包含 `transition:<Transition.id>`。
- before Frame 与动作前实时 locator 属于同一冻结状态。
- after Frame 在动作完成后采集。
- `evidence.actionTraceRef` 可解析。
- `evidence.postcondition == pass` 且至少有一个语义断言。
- Source/Target Page 的入出边引用与 Transition 互为反向关系。

同一页面内的开关、滚动、选择或展开动作可以使用相同的 source/target Page，并用状态、帧和 postcondition 表达变化。不能为了表示状态变化而复制 Page。

## 8. AuthorityContract 闭合

每个 AuthorityContract 必须满足：

- `edgeKind == authority_contract`。
- `sourceType == user_context`。
- `authorityStatus == authority_certified`。
- Source Selector 和 Expected Target 可解析。
- Trigger 在来源范围内可用，并拥有相应 capability。
- Trigger 的 `relationshipRefs` 包含 `authority_contract:<Contract.id>`。
- `runtimeEvidenceStatus` 只允许 `pending`、`verified`、`contradicted`。

状态约束：

| 状态 | 必须 | 禁止 |
| --- | --- | --- |
| `pending` | `verifiedTransitionRef: null` | 冒充已执行边 |
| `verified` | 引用语义一致的闭合 Transition | 缺少 Transition |
| `contradicted` | `defectRef`、expected/actual、构建和完整反例证据 | 删除或降级契约 |

语义一致要求 Contract 和 Transition 的来源、Trigger、Capability 和目标相同；状态选择器存在时也必须一致。

## 9. 共享导航

- 底部导航、顶栏导航等跨 Page 复用结构建为 Application 持有的共享 Element。
- Page 通过 `elementRefs` 与共享根的 `availableOnPageRefs` 双向引用同一个共享根。
- Tab、菜单项和“更多”使用 `owner.kind: shared_component` 由共享父 Element 持有。
- “更多”抽屉如果只是同一触发器的展开呈现，必须建为“更多”Element 的状态，不另建 Page 或包装 Element。
- 抽屉入口由“更多”直接持有；其目标业务 Page 按自身业务路径归类。
- 共享容器必须完整维护 `childElementRefs`，不能只让子元素单向指向父元素。
- 共享导航是受保护知识；增量探索不得因当前范围未出现而删除或截断。

## 10. 观测与状态引用

- 每个 PageState 的 `frameRefs` 必须引用该 Page 的 Observation 帧。
- Element Observation 的 frame 必须对应一个可解析的全页截图资产。
- Element locator、redbox、viewport 和截图必须属于同一坐标空间。
- `dynamicValue`、颜色、坐标、角标数字和列表业务数据不得出现在稳定 key、owner、capability 或 identity 中。
- 未执行动作不得出现成功 Transition 引用。

## 11. 目录和投影关系

- Canonical Page/Element 文件路径必须与其 `featurePath` 一致。
- 每个 Canonical Page/Element 在 Obsidian 中恰有一张同 ID 卡片，路径使用相同 `featurePath`。
- 类型根目录不能平铺实体文件。
- 迁移后不得残留空功能目录或同 ID 文件副本。
- Obsidian 卡片关系、图片和 Wikilink 必须在 `knowledge_graph/obsidian/` 范围内可解析。

## 12. 校验器职责边界

JSON Schema 负责单文件字段、类型、枚举和条件约束。图级校验器负责：

- ID/key 唯一和引用解析；
- owner 链、容器双向关系和无环性；
- Page 直接引用边界；
- 复合设置行识别结果、profile、角色集合、实际 Trigger 和交互边界；
- 复合设置行 locator/redbox 的语义边界与无依据重复框选；
- `featurePath` 继承或合法扩展；
- Transition 和 AuthorityContract 闭合；
- Manifest 集合与内容哈希；
- Obsidian 一一投影、链接和资产；
- 公共知识保留、迁移可解析和幂等性。

业务专属契约可以增加更严格规则，但不得修改或放宽本文件的通用不变量。
