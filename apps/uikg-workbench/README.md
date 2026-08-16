# UIKG Workbench

第一阶段提供本地 Android 单设备连接、实时画面操作、冻结帧、Worker A 页面解析、可编辑标注、元素归属关系、草稿保存与实时校验。

## 启动

环境要求：Node.js 20+、pnpm，以及可通过 ADB 访问的 Android 设备。模型配置位于平台根目录 `.env`，Worker A 使用独立的 `MIDSCENE_WORKER_A_MODEL_*` 配置。

```bash
pnpm install
pnpm build
pnpm start
```

开发时运行 `pnpm dev` 会同时启动前端和 Android/Workbench 服务，打开 `http://127.0.0.1:5173`。生产构建后运行 `pnpm start`，打开 `http://127.0.0.1:5800`。

## Worker A 模型设置

Workbench 的“模型”页读取并更新平台根目录 `.env` 中的 `MIDSCENE_WORKER_A_MODEL_*` 配置。保存后会刷新当前进程的 Worker A 模型配置；API Key 仅在服务端读取，页面只显示脱敏末四位。

推荐的低成本配置如下：

```bash
MIDSCENE_WORKER_A_MODEL_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
MIDSCENE_WORKER_A_MODEL_API_KEY="..."
MIDSCENE_WORKER_A_MODEL_NAME="qwen3.7-flash"
MIDSCENE_WORKER_A_MODEL_FAMILY="qwen3"
MIDSCENE_WORKER_A_MODEL_TIMEOUT="120000"
MIDSCENE_WORKER_A_MODEL_TEMPERATURE="0"
MIDSCENE_WORKER_A_MODEL_REASONING_ENABLED="false"
```

Realtime 模型使用独立实时接口，不能通过当前 Worker A 的 OpenAI 兼容 HTTP 链路调用。

## 数据边界

- 冻结截图按内容哈希保存，作为当时设备状态的原始证据，不被后续操作覆盖。
- Worker A 原始响应按次保存，保留模型当时实际返回的内容，便于审计、比较和重放。
- 人工修改发生在 Draft 草稿层；元素名称、类型、作用、操作能力、状态、边框和归属关系均可修改。
- 再次运行 Worker A 时，已经确认或人工修订的字段不会被覆盖，新识别结果记录在模型建议中。
- 第一阶段不会写入 `knowledge_graph/apps` 下的 Canonical 知识图谱。

原始证据“不可变”不等于识别结果“不可纠正”。它的含义是保留错误发生时的原始输入和输出；正确结果由可编辑草稿承载。这样既能完成纠错，又能追溯人工修改前后的差异。

## 校验

```bash
pnpm typecheck
pnpm test
pnpm build
```
