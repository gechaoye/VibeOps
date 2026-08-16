# VibeOps

VibeOps is a visual testing operations platform built around a versioned UI knowledge graph.

## Start

Requirements: Node.js 20+, pnpm 9+, Python 3.10+, and an Android device available through ADB.

```bash
cp .env.example .env
python -m pip install -r requirements.txt
pnpm install
pnpm build
pnpm dev
```

Open `http://127.0.0.1:5173`. The development command starts both the frontend and the Android/workbench service. Use `pnpm dev:server` only when running the backend separately.

## Knowledge Graph

`knowledge_graph/` is the platform knowledge base. It contains the UIKG specification, canonical application graph, evidence, projections, exploration records, and deterministic graph tools.

```bash
pnpm graph:validate
pnpm graph:query -- --from messages.root --to messages.special_follow.settings --profile shortest --pretty
```

## Workbench

`apps/uikg-workbench/` maintains graph drafts from a connected Android device. It supports live device interaction, frozen-frame evidence, Worker A inventory, editable annotations, consistency validation, AI review, staging, and publication.
