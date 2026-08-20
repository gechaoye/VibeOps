# VibeOps Project Graph 1.0

| Item | Value |
| --- | --- |
| Specification | VibeOps Project Graph 1.0 |
| Model version | `1.0.0` |
| Compatibility | Intentionally incompatible with UIKG 3.x |
| Canonical boundary | One project |

## 1. Purpose

VibeOps maintains one canonical knowledge graph for each project. UI, product, service,
API, data, code and quality assets are typed entities in the same graph. Communities
organize those entities; they do not create isolated subgraphs.

The model separates four kinds of records:

- `Entity`: a stable project asset or semantic object;
- `Relation`: one directed, typed fact between two entities;
- `Observation`: one actual runtime or document observation;
- `Evidence`: an optional artifact supporting an entity, field or relation.

## 2. Canonical hierarchy

```text
Project
|- ApplicationCommunity -> Application -> Function -> Page -> Element
|- ServiceCommunity     -> Service -> API -> APIDoc
|- DatabaseCommunity    -> Database -> Schema -> Table -> Field
|- PRDCommunity         -> PRD -> Requirement -> BusinessRule
`- QualityCommunity     -> TestSuite -> TestCase -> TestRun / Defect
```

The tree is a reading projection. Canonical ownership and dependency are stored as
`Relation` records. An entity is stored once and may belong to multiple communities.

## 3. Stable entities and actual observations

`Page` is a stable, observable page identity. It is not split by Android, iOS or device.
The client, build, device, viewport, screenshot and actual visible elements belong to an
`Observation`. VibeOps 1.0 does not define `PageInstance`.

An advertising banner therefore remains one optional `Element`. One observation can
record it as `present`; a later observation records it as `absent` with reason
`dismissed`. Neither the Page nor the Element is duplicated.

Dialogs, sheets and overlays may be Pages when they have an independently observable
interaction boundary. A transient tooltip or help bubble normally remains an Element
state on its host Page.

## 4. UI interaction and API causality

An `Interaction` describes a stable UI action. Its facts are expressed by relations:

```text
Element     --triggers------> Interaction
Interaction --starts_from---> Page
Interaction --navigates_to--> Page
Interaction --calls---------> API   # the interaction directly calls it
Page        --loads_from----> API   # page entry/loading calls it
```

The last two relations must not be conflated. Actual requests belong to a runtime
Observation or trace. An inferred API call is allowed only with `origin: ai_inferred`
and may not be marked `runtime_verified` without runtime evidence.

Element `capabilities` describe only the physical interaction performed by the user,
such as `tap`, `long_press`, `input`, `swipe` or `drag`. A business result such as
delete, submit, navigate, enable or disable is not an element action. It is recorded in
the matching `actionEffects` entry and may additionally be modeled through an
`Interaction` and typed relations when it needs an independent graph identity.

```yaml
capabilities: [tap]
actionEffects:
- action: tap
  effect: 删除该成员
```

## 5. Core record envelope

Every Entity has immutable core identity fields and configurable `attributes`. Relation
and Observation have their own fixed graph fields. User-defined fields must be declared
in the active ModelDefinition before they are written to `attributes`.

```yaml
recordKind: Entity
modelVersion: 1.0.0
id: page:messages.special_follow
entityType: Page
projectRef: project:baohe
key: messages.special_follow
label: 特别关注
summary: 展示特别关注成员及会话
lifecycleStatus: active
attributes: {}
knowledge:
  origin: ai_inferred
  reviewStatus: confirmed
  validationStatus: observed
  confidence: 0.94
  evidenceRefs: []
```

## 6. Configurable model

The active model is composed from the platform core model and one project model. It can
configure entity types, relation types, fields, option sets, form presentation and query
indexes. It cannot redefine record identity, references or graph invariants.

Supported field types are `string`, `text`, `integer`, `number`, `boolean`, `date`,
`datetime`, `option`, `multi_option`, `entity_ref`, `entity_ref_list`, `object` and
`object_list`. An option may be made inactive but must not be removed while stored data
still uses it.

Model changes create a new `modelVersion`. Published graph records continue to resolve
against the version with which they were validated. Required-field additions and value
type changes require an explicit data migration before publication.

## 7. Knowledge status

`origin`, human review and runtime validation are independent dimensions:

- `origin`: `manual`, `ai_inferred`, `imported`, `system_generated`;
- `reviewStatus`: `pending`, `confirmed`, `rejected`;
- `validationStatus`: `unverified`, `observed`, `runtime_verified`, `contradicted`.

Record-level knowledge is the default. A field whose source differs may add an entry to
`fieldKnowledge`; this avoids turning every ordinary field into a separate Claim node.
Relations always carry their own knowledge status.

## 8. Graph invariants

1. IDs are unique inside a Project Graph and references resolve inside that graph unless
   a relation type explicitly allows an external reference.
2. A canonical fact is stored once. Reverse lists and community trees are projections.
3. Element containment is acyclic; an Element has at most one direct structural parent.
4. Only an actionable Element may trigger an Interaction.
5. A Relation must satisfy the configured source and target type constraints.
6. Rejected knowledge cannot participate in canonical queries or route planning.
7. `runtime_verified` requires at least one resolvable evidence or observation reference.
8. Unknown knowledge remains absent or explicitly `unverified`; it is never guessed into
   a confirmed value.

## 9. UIKG 3.x decisions intentionally removed

- `Application.platform`: runtime client data moves to Observation;
- `featurePath`: replaced by Community membership and derived reading paths;
- embedded Page/Element observations: normalized into Observation records;
- `elementRefs` and inbound/outbound edge arrays: derived from Relations;
- `Transition`: replaced by Interaction plus typed Relations;
- `AuthorityContract`: replaced by Relation knowledge status;
- unrestricted `additionalProperties`: replaced by declared configurable attributes.
