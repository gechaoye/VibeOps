# UIKG 3.0.1 当前 JSON Schema

这些 Schema 使用 JSON Schema Draft 2020-12。Canonical YAML 必须先通过安全 YAML 解析器转换为普通数据对象，再应用 Schema。UIKG 3.0.1 继续使用 `schemaVersion: 3.0.0`，因为本次规范更新只明确既有字段的图级语义，不增加单文件结构。

## 映射

| 文件 | 适用记录 |
| --- | --- |
| `application.schema.json` | `entityType: Application` |
| `page.schema.json` | `entityType: Page` |
| `element.schema.json` | `entityType: Element` |
| `transition.schema.json` | `entityType: Transition` |
| `authority-contract.schema.json` | `entityType: AuthorityContract` |
| `manifest.schema.json` | `manifestType: NormalizedUiKnowledgeGraph` |
| `supporting-record.schema.json` | 迁移、物化审计和历史动作辅助记录 |
| `common.schema.json` | 共用值对象，只被其他 Schema 引用 |

Schema 只负责单文件结构。以下内容必须由图级校验器依据 [`../relationship-invariants.md`](../relationship-invariants.md) 验证：

- ID 和 key 唯一性；
- 引用存在性与实体类型；
- owner 祖先链、无环性和共享作用域；
- `childElementRefs`、`owner.ref`、`parentElementRef` 的双向闭合；
- Page 只直接引用顶层 Element；
- 复合设置行的识别结果、`composition.profile`、profile 专属角色、实际 Trigger 与交互边界；
- 已识别复合设置行不得继续使用扁平 Page-owned `list_entry`/`toggle`，且不同语义子元素不得无证据重复使用 locator/redbox；
- Page/Transition/AuthorityContract 反向引用；
- `featurePath` 继承与共享子路径扩展；
- Manifest 集合、内容哈希、Obsidian 投影和资产。

不得因为某项约束无法用 JSON Schema 表达，就省略对应图级校验。
