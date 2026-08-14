# UIKG 3.0.1 规范索引

本目录是本知识库唯一的 UI 知识图谱规范来源。规范版本为 `UIKG 3.0.1`，适用于 `knowledge_graph/apps/*` 的 Canonical 图谱、`knowledge_graph/explorations/*` 的探索证据以及 `knowledge_graph/obsidian/*` 的阅读投影。机器记录继续使用 `schemaVersion: 3.0.0`；本次 Patch 没有增加实体类型、字段或结构枚举。

UIKG 3.0.1 明确收紧了 UIKG 3.0 已有的统一容器模型：任何由多个稳定语义部分组成的设置行都必须建立行总容器，并使用 `toggle_row`、`selector_row`、`help_toggle_row` 或 `action_row` 之一描述其成员角色。设置行直接位于页面时，页面只引用该行容器；设置行嵌套在其他容器时，页面只引用其顶层祖先，始终禁止越过容器引用行内成员。说明文字、帮助内容和当前值默认不可操作，Transition 与 AuthorityContract 只能指向证据确认的实际触发 Element。缺少设置行分类或交互边界证据时不得标记为 `complete`。

## 规范优先级

发生冲突时按以下顺序处理：

1. 本目录的 UIKG 3.0.1 规范与 Schema 3.0.0。
2. 与规范一致的图级语义校验器。
3. 物化器和查询器实现。
4. 探索报告、任务策略、迁移账本和历史证据。

业务物化 YAML、探索报告、代码注释、历史账本和 Obsidian 卡片都不是规范来源。实现与本目录不一致时，应修正实现或明确升级规范，不能以既有数据反向定义模型。

## 文档组成

- [UIKG-3.0.1.md](UIKG-3.0.1.md)：规范范围、架构、实体边界、发布与一致性等级。
- [ontology.md](ontology.md)：Canonical 实体、字段和值对象的完整定义。
- [relationship-invariants.md](relationship-invariants.md)：owner、容器、页面引用、导航、契约及目录关系不变量。
- [evidence-and-projection.md](evidence-and-projection.md)：运行证据、覆盖状态、Obsidian 投影和隐私规则。
- [migrations/UIKG-3.0.1-migration-policy.md](migrations/UIKG-3.0.1-migration-policy.md)：身份保留、拆分、合并、退出 Canonical 和发布迁移规则。
- [schemas/](schemas/)：解析 YAML 后适用的 JSON Schema Draft 2020-12 结构约束。

## 规范性术语

“必须”“禁止”表示强制要求；“应该”“不应该”表示除非有记录充分理由否则必须遵守；“可以”表示可选能力。

## 版本规则

- `schemaVersion` 使用语义版本。
- 规范文档版本与机器 `schemaVersion` 分别管理；仅澄清图级语义且不改变单文件结构时，规范 Patch 可以沿用当前 Schema 版本。
- Patch 版本只能澄清文字或收紧不改变有效数据集合的检查。
- Minor 版本可以增加向后兼容的可选字段和值。
- Major 版本允许不兼容变更，但必须提供迁移策略和原子发布方案。
- Canonical 实体、Manifest 与所用 Schema 必须属于同一 Major 版本。

## 规范内容哈希

规范哈希覆盖本目录下全部普通文件，包括 Markdown 与 JSON Schema。计算时使用相对于 `knowledge_graph/spec/` 的 POSIX 路径，按路径 UTF-8 字节升序排列；每个文件依次写入 `relative-path`、一个 NUL 字节、原始文件字节和一个 NUL 字节，最后对完整字节流计算 SHA-256。不得进行换行、Unicode 或 YAML/JSON 语义归一化。输出格式为 `sha256:<lowercase-hex>`。

## 一致性要求

一个发布版本只有同时满足以下条件才能标记为 `complete`：

- 所有 Canonical 文件通过对应结构 Schema。
- 所有跨文件关系通过图级不变量检查。
- 探索范围、候选对账、动作队列和证据门禁闭合。
- Obsidian 投影与同一 Graph Revision 的 Canonical 一一对应。
- 迁移账本可解析所有退出 Canonical 的稳定 ID。
- 没有丢失历史公共导航或其他受保护知识。

结构合法但证据或覆盖尚未闭合的图谱必须标记为 `incomplete`，不能用结构校验通过代替探索完成。
