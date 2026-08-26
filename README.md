# VibeOps

VibeOps is an AI-assisted project knowledge graph platform that connects product,
application UI, service, API, data, code, testing, defect, release, and operations assets.
UI exploration is the current pilot workflow, not the boundary of the platform model.

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

Stop development services started by this project with `pnpm dev:stop`.

## Knowledge Graph

`knowledge_graph/` is the platform knowledge base. The normative model is VibeOps Project
Graph 1.0. The existing UIKG 3.x graph remains exploration-stage source material until
the new model and workbench are ready for publication.

```bash
pnpm graph:vibeops:validate
pnpm graph:validate
pnpm graph:query -- --from messages.root --to messages.special_follow.settings --profile shortest --pretty
```

## Workbench

`apps/uikg-workbench/` maintains graph drafts from a connected Android device. It supports live device interaction, frozen-frame recognition evidence, editable annotations, consistency validation, AI review, staging, and publication. Page recognition uses the configured single model. Repeated list rows are projected as abstract templates with stable field roles and per-frame instance regions; concrete row values remain observation evidence rather than page elements.
