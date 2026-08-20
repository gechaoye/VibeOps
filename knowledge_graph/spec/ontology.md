# UIKG 3.0.1 本体与字段

本文定义 UIKG 3.0.1 的 Canonical 实体和值对象。字段标记为“必需”时，任何新建或重新物化的记录都必须提供；历史记录只有在迁移账本明确标记兼容限制时才可以暂缺，并且图谱状态必须为 `incomplete`。机器记录继续使用 `schemaVersion: 3.0.0`。

## 1. 通用约定

### 1.1 通用实体信封

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | string | 是 | 固定为 `3.0.0`。 |
| `entityType` | enum | 是 | `Application`、`Page`、`Element`、`Transition`、`AuthorityContract`。 |
| `id` | ULID string | 是 | 全局稳定身份；引用只使用此值。 |
| `key` | string | 是 | App 内稳定且唯一的语义键。 |
| `applicationRef` | ULID | Page/Element/Transition/AuthorityContract 是 | 所属 Application ID。 |
| `featurePath` | string[1..3] | Application 外是 | 业务或组件阅读路径，不参与身份。 |
| `provenance` | object | 是 | 来源、限制、审核和物化信息。 |

`id`、`key` 和引用不允许使用坐标、截图哈希、显示文字、列表索引或临时数据生成语义身份。确定性物化可以从实体类型和稳定 key 生成 ULID，但同一语义必须持续复用既有 ID。

### 1.2 Provenance

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `sourceType` | string | 是 | 例如 `user_context`、`verified_midscene_evidence`、`legacy_uikg_import`。 |
| `sourceEntityId` | string/null | 否 | 迁移或导入来源。 |
| `materializationSpec` | string/null | 否 | 产生记录的任务规格文件。 |
| `recordedAt` | RFC 3339 string | 否 | 权威知识或人工审核的记录时间。 |
| `reviewedBy` | string | 否 | 审核来源标识。 |
| `limitations` | string[] | 否 | 当前证据限制；不得隐藏缺失证据。 |
| `userContextCertifiedFact` | string | 否 | 用户明确认证且与该实体直接相关的事实。 |

`sourceType` 不代表证据完成度；运行证据完成度必须使用实体自己的状态字段表达。

### 1.3 FeaturePath

`featurePath` 是 1 至 3 个非空稳定名称组成的数组：

```yaml
featurePath: [消息, 特别关注]
```

Page 使用自身业务路径。页面内 Element 与最终归属 Page 使用同一路径。共享 Element 使用其组件路径；共享后代可以保持父路径，或者在父路径后增加必要的稳定分区，但总深度不得超过 3。

## 2. Application

Application 是 App 的稳定身份。构建号、渠道、设备和主题属于观测上下文，不创建独立 Application。

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| 通用信封字段 |  | 是 | `featurePath`、`applicationRef` 不适用。 |
| `label` | string | 是 | App 可读名称。 |
| `packageId` | string | 是 | 当前应用包标识。 |
| `platform` | string | 是 | `android`、`ios` 等。 |
| `status` | string | 是 | Application 当前 Canonical 状态。 |

一个 App 图谱目录必须恰有一个 Application，其他所有实体的 `applicationRef` 必须指向它。

## 3. Page

Page 表示稳定可到达的业务 UI 表面。

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| 通用实体信封 |  | 是 | 包含 `applicationRef` 和 `featurePath`。 |
| `label` | string | 是 | 可读页面名称，使用稳定业务父链消歧。 |
| `surfaceType` | string | 是 | 例如 `page`、`dialog`、`overlay`。 |
| `status` | string | 是 | 页面知识和证据状态。 |
| `summary` | string | 是 | 页面稳定业务职责。 |
| `states` | PageState[] | 是 | 可以为空，但不得缺失。 |
| `elementRefs` | ULID[] | 是 | Page 直接引用的顶层 Element 和顶层共享 Element。 |
| `inboundTransitionRefs` | ULID[] | 是 | 目标为本 Page 的 Transition。 |
| `outboundTransitionRefs` | ULID[] | 是 | 来源为本 Page 的 Transition。 |
| `inboundAuthorityContractRefs` | ULID[] | 否 | 预期目标为本 Page 的契约。 |
| `outboundAuthorityContractRefs` | ULID[] | 否 | 来源范围为本 Page 的契约。 |
| `observations` | PageObservation[] | 是 | 至少一个来源帧；纯权威待探索 Page 例外时必须有明确未解析记录。 |
| `boundaryNote` | string | 否 | 边界 Page 的探索范围说明。 |

### 3.1 PageState

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 是 | Page 内唯一稳定状态 key。 |
| `summary` | string | 是 | 状态语义。 |
| `frameRefs` | string[] | 是 | 支持该状态的冻结帧。 |

状态只表达影响能力、呈现或规划的稳定组合。单次数据值不应固化为状态身份。

### 3.2 PageObservation

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `frameRef` | string | 是 | 冻结全帧稳定引用。 |
| `observedAt` | RFC 3339 string | 是 | 观测时间。 |
| `buildRef` | string | 是 | App 构建上下文值。 |
| `deviceRef` | hash/string | 是 | 脱敏设备引用。 |
| `viewport` | Viewport | 是 | 宽、高和方向。 |
| `stateProperties` | object | 是 | 当帧实际状态，不进入稳定身份。 |
| `screenshotRef` | content ref | 是 | 全页截图内容引用。 |
| `rawEvidenceRef` | path/null | 否 | 原始探索证据目录。 |
| `evidenceStatus` | string | 是 | 双模型和运行证据状态。 |

## 4. Element

Element 表示稳定 UI 控件、状态指示、结构容器或稳定内容锚点。

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| 通用实体信封 |  | 是 | 包含 `applicationRef` 和 `featurePath`。 |
| `label` | string | 是 | 稳定可读名称。 |
| `aliases` | string[] | 否 | 检索别名，不承担身份。 |
| `owner` | Owner | 是 | 唯一直接 owner。 |
| `parentElementRef` | ULID/null | 是 | 嵌套 Element 必须为父 Element ID；顶层必须为 null。 |
| `elementType` | string | 是 | 例如 `container`、`icon_button`、`text_label`、`toggle`。 |
| `role` | string | 是 | 语义角色。 |
| `capabilities` | string[] | 是 | 用户实际执行的物理交互动作；纯说明或结构元素为空。 |
| `actionEffects` | ActionEffect[] | 否 | 各物理交互产生的业务结果，例如点击后删除成员或进入页面。 |
| `summary` | string | 是 | 稳定职责及必要交互边界。 |
| `relationshipRefs` | string[] | 是 | owner、parent、child、Transition、Contract 等规范关系引用。 |
| `childElementRefs` | ULID[] | 否 | 直接子 Element；有子元素时必须提供。 |
| `availableOnPageRefs` | ULID[] | 否 | 顶层共享 Element 的可用 Page。 |
| `states` | ElementState[] | 否 | 共享抽屉打开等稳定呈现状态。 |
| `observations` | ElementObservation[] | 是 | 至少一个帧及 locator 或明确 unresolved。 |
| `coverage` | string | 是 | 探索动作覆盖状态。 |
| `status` | string | 是 | Canonical 证据状态。 |
| `risk` | enum/string | 是 | `safe`、`low`、`medium`、`high` 等。 |
| `presentation` | object | 否 | 标签、图标和空间关系等稳定呈现语义。 |
| `interactionBoundary` | object | 否 | 可点击区域、不可点击文字等明确边界。 |
| `composition` | object | 条件必需 | 复合组件中标签、触发器等具名成员；稳定设置行必须按 4.3 节声明 profile 和角色。 |

### 4.1 Owner

```yaml
owner:
  kind: page | application | component | shared_component
  ref: <stable-id>
```

- `page` 和 `application` 表示顶层归属，`parentElementRef` 必须为 null。
- `component` 和 `shared_component` 表示嵌套归属，`owner.ref` 必须等于 `parentElementRef`。
- `component` 的祖先链必须终止于 Page。
- `shared_component` 的祖先链必须终止于 Application 持有的共享 Element。

`capabilities` 不记录删除、提交、跳转、启用或关闭等业务结果。例如删除成员按钮应使用
`capabilities: [tap]`，并以 `actionEffects: [{ action: tap, effect: 删除该成员 }]` 描述点击结果。
每条 `actionEffects.action` 必须对应一个已声明的 capability。

### 4.2 InteractionBoundary

`interactionBoundary` 记录 Element 自身是否是实际交互命中区域，而不是对相邻控件交互性的推断。至少使用：

```yaml
interactionBoundary:
  actionable: true | false
  function: <stable-semantic-description>
```

- `actionable: true` 的 Element 必须拥有与其实际行为一致的 capability；作为导航或状态变更触发器时，Transition/AuthorityContract 必须直接引用它。
- `actionable: false` 的 Element 必须使用空 `capabilities`，并且不能成为 Transition/AuthorityContract 的 Trigger。
- 文字与控件同处一个容器、位于控件左侧或视觉上组成一行，都不能证明文字或容器可点击。
- 整行命中区域、仅开关命中、仅箭头命中等边界必须来自运行定位与实际动作证据，或用户认证事实。

### 4.3 Composition 与设置行 profile

`composition` 对容器的稳定语义成员进行具名映射。视觉上稳定的设置行只要包含两个或更多可区分的语义部分，就必须在顶层行容器上提供：

```yaml
composition:
  profile: <setting-row-profile>
  roles:
    <profile-role>: <element-id>
```

设置行 profile 及其角色如下：

| `profile` | 必需角色 | 可选角色 | 交互规则 |
| --- | --- | --- | --- |
| `toggle_row` | `label`、`settingControl` | `secondaryText` | `settingControl` 是实际设置控件；Label/次要说明不可操作。 |
| `selector_row` | `label`、`currentValue`、`settingTrigger` | `affordance`、`secondaryText` | `settingTrigger` 是经证据确认的实际选择入口；当前值默认不可操作。 |
| `help_toggle_row` | `label`、`helpTrigger`、`helpPopover`、`settingControl` | `secondaryText` | 帮助入口和设置控件是两个独立交互边界；帮助内容不可操作。 |
| `action_row` | `explanatoryContent`、`actionTrigger` | `secondaryText` | 说明内容不可操作；独立 Trigger 承担动作。 |

Profile 角色规则：

- 每个必需角色都必须存在；不能把所有设置行硬编码为同一组四个子元素。
- 除 `selector_row.settingTrigger` 外，角色引用必须解析到该容器的直接子 Element。`selector_row.settingTrigger` 在证据确认整行可点击时可以引用容器自身，否则必须引用直接子 Element。
- `selector_row.affordance` 表示箭头等视觉提示。若该提示自身就是实际入口，`affordance` 和 `settingTrigger` 可以引用同一个子 Element；若整行才是入口，affordance 必须保持不可操作。
- Label、`currentValue`、`secondaryText`、`helpPopover` 和 `explanatoryContent` 必须为 `actionable: false` 且 `capabilities: []`，除非用户事实或运行证据明确证明该 Element 还承担独立动作；出现这种独立动作时必须选择能表达该动作的 profile 或嵌套复合容器，不能只修改文案。
- `helpTrigger`、`settingControl`、`actionTrigger` 以及非容器型 `settingTrigger` 必须为 `actionable: true`，并拥有各自 capability。
- 行容器默认 `actionable: false` 且 `capabilities: []`。只有 `selector_row.settingTrigger` 指向容器自身并具备整行交互证据时，容器才可以操作。
- `roles` 必须覆盖该设置行全部稳定语义成员；装饰性图形可以留在 presentation，但不得把实际可操作控件降格为装饰。

无法确定设置行 profile 或实际命中边界时，不得猜测。该候选必须在 Exploration Coverage 中标记 `unresolved_setting_row`，并阻断本次范围标记为 `complete`；不得以扁平 Page-owned `list_entry` 或 `toggle` 替代。

### 4.4 ElementObservation

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `frameRef` | string | 是 | locator 所属冻结帧。 |
| `observedAt` | RFC 3339 string | 是 | 观测时间。 |
| `buildRef` | string | 是 | 构建上下文。 |
| `deviceRef` | string | 应该 | 脱敏设备引用。 |
| `viewport` | Viewport | 应该 | 几何所在视口。 |
| `locator` | Locator | 是 | rect、center、dpr、状态和证据引用。 |
| `state` | string | 是 | 当帧可见、可操作等状态。 |
| `stateProperties` | object | 是 | enabled、selected、checked、actionable 等。 |
| `dynamicValue` | any/null | 是 | 角标数字、当前文字等动态值。 |
| `screenshotRef` | content ref | 是 | 来源全帧。 |
| `redboxRef` | path | 是 | 从同一全帧生成的红框图。 |
| `actionTraceRef` | string/null | 是 | 当次观测直接关联的动作；未执行时为 null。 |
| `rawEvidenceRef` | path/null | 否 | 原始证据。 |
| `evidenceStatus` | string | 是 | 证据状态。 |

Locator 的 `rect` 使用 `left/top/width/height`，`center` 为两个数值，`dpr` 为正数。几何只属于该 Observation。

## 5. Transition

Transition 表示一次真实执行并验证的原子动作。

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| 通用实体信封 |  | 是 | 包含 `applicationRef` 和 `featurePath`。 |
| `sourceRef` | Page ULID | 是 | 来源 Page。 |
| `sourceStateKey` | string/null | 否 | 已明确时指定来源状态。 |
| `triggerElementRef` | Element ULID | 是 | 实际触发控件，不是说明文字或容器。 |
| `action` | string | 是 | 真实执行接口，例如 `aiTap`、`aiAct`。 |
| `capability` | string | 是 | 业务能力。 |
| `targetRef` | Page ULID | 是 | 目标 Page；同页状态变化时可等于 source。 |
| `targetStateKey` | string/null | 否 | 已明确时指定目标状态。 |
| `reversible` | boolean | 是 | 是否存在安全回退。 |
| `risk` | string | 是 | 动作风险。 |
| `verificationStatus` | string | 是 | 成功状态必须反映证据等级。 |
| `evidence` | TransitionEvidence | 是 | 闭合动作证据。 |
| `provenance` | object | 是 | 动作来源与限制。 |

TransitionEvidence 必须包含：

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `actionTraceRef` | string | 是 | 动作 Trace。 |
| `beforeFrameRef` | string | 是 | 动作前冻结帧。 |
| `afterFrameRef` | string | 是 | 动作后冻结帧。 |
| `postcondition` | `pass` | 是 | 成功 Transition 固定为 pass。 |
| `semanticAssertions` | string[] | 是 | 后置语义断言证据。 |

失败动作不建立成功 Transition，应保存在探索证据或契约反例中。

## 6. AuthorityContract

AuthorityContract 表示用户认证的产品行为，和运行 Transition 独立存在。

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| 通用实体信封 |  | 是 | 包含 `applicationRef` 和 `featurePath`。 |
| `edgeKind` | `authority_contract` | 是 | 固定值。 |
| `sourceSelector` | SourceSelector | 是 | 来源 Page/state 或共享可用范围。 |
| `triggerElementRef` | Element ULID | 是 | 用户确认的实际触发控件。 |
| `action` | string | 是 | 预期动作。 |
| `capability` | string | 是 | 预期业务能力。 |
| `expectedTarget` | ExpectedTarget | 是 | 预期 Page/state。 |
| `risk` | string | 是 | 规划风险。 |
| `sourceType` | `user_context` | 是 | 固定值。 |
| `authorityStatus` | `authority_certified` | 是 | 固定值。 |
| `planningEligible` | boolean | 是 | 是否允许进入规划。 |
| `runtimeEvidenceStatus` | enum | 是 | `pending`、`verified`、`contradicted`。 |
| `verifiedTransitionRef` | ULID/null | 是 | verified 时必须引用闭合 Transition。 |
| `defectRef` | string/null | 是 | contradicted 时必须引用产品缺陷。 |
| `certifiedFact` | object | 是 | 用户确认的可见文字、实际控件、容器和边界。 |
| `contradictionPolicy` | string | 是 | 必须保留契约并记录缺陷。 |
| `provenance` | object | 是 | 必须包含用户上下文及审核信息。 |

SourceSelector 当前支持：

```yaml
sourceSelector:
  kind: exact_page
  ref: <page-id>
  stateKey: null
```

共享导航扩展可以使用 `shared_availability`，其 `ref` 指向顶层共享 Element，由 `availableOnPageRefs` 解析来源 Page。不得将同一共享动作展开为多份契约。

ExpectedTarget：

```yaml
expectedTarget:
  kind: page
  ref: <page-id>
  stateKey: null
```

## 7. Manifest

每个 App 目录必须有一个 Manifest：

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | `3.0.0` | 是 | Schema 版本。 |
| `manifestType` | `NormalizedUiKnowledgeGraph` | 是 | 固定值。 |
| `applicationRef` | ULID | 是 | Application ID。 |
| `generatedAt` | RFC 3339 string | 是 | 发布时间。 |
| `graphRevision` | string | 应该 | 本次图谱修订标识。 |
| `status` | `complete`/`incomplete` | 是 | 图谱完成状态。 |
| `entries` | path[] | 是 | Canonical 与辅助记录相对路径，排序确定。 |
| `entityIds` | ULID[] | 是 | 所有 Canonical 实体 ID，排序确定。 |
| `rootHash` | content hash | 应该 | Canonical 内容根哈希。 |

Manifest 不得列入 staging、rollback、临时文件或 Obsidian 派生文件。

## 8. 辅助记录

辅助记录位于 `apps/<app-key>/observations/`，不是 Canonical 导航节点。

### 8.1 UiGraphMigrationLedger

保存退出 Canonical 的旧 ID、旧 key、旧类型、目标 ID/key/类型/状态、原因和审核来源。旧 ID 必须可通过账本解析，不得被静默遗忘。

### 8.2 UiGraphMaterializationAudit

保存物化输入、证据数量、输出数量、未覆盖项、限制和完成状态。数量必须从当前输入计算，不能写死在通用规范或校验器中。

### 8.3 LegacyTransitionLedger

只保存无法在当前证据下闭合的历史动作知识。此类记录不能进入可执行路网，也不能冒充 Transition 或 AuthorityContract。

辅助记录结构见 [supporting-record.schema.json](schemas/supporting-record.schema.json)。
