# VibeOps Project Knowledge Graph

The normative target model is [VibeOps Project Graph 1.0](spec/VIBEOPS-PROJECT-GRAPH-1.0.md).
It defines one graph per project and connects application, function, UI, service, API,
database, PRD, code and quality assets through configurable typed entities and relations.

## Formal model

- Core model configuration: [`model/core.yaml`](model/core.yaml)
- Record Schema: [`spec/schemas/vibeops-record.schema.json`](spec/schemas/vibeops-record.schema.json)
- Model configuration Schema: [`spec/schemas/vibeops-model.schema.json`](spec/schemas/vibeops-model.schema.json)
- Baohe project configuration: [`projects/baohe/model.yaml`](projects/baohe/model.yaml)
- Special Follow reference graph: [`projects/baohe/graph/special-follow.yaml`](projects/baohe/graph/special-follow.yaml)
- Association review: [`projects/baohe/special-follow-association-review.yaml`](projects/baohe/special-follow-association-review.yaml)

Validate the formal model and reference graph:

```bash
pnpm graph:vibeops:validate
```

## Exploration-stage UIKG material

`apps/zto.connect`, `explorations`, `normalization` and `obsidian/zto.connect` are retained
as source observations and UI exploration results. They use UIKG 3.x and are not the
canonical production model for VibeOps Project Graph 1.0.

The legacy graph can still be checked independently:

```bash
pnpm graph:validate
```

Passing that command means the historical UIKG structure is internally consistent; it
does not promote the data to the VibeOps 1.0 canonical graph.
