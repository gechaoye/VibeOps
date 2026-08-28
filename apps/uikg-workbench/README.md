# UIKG Workbench

第一阶段提供本地 Android 单设备连接、实时画面操作、冻结帧页面识别、可编辑标注、元素归属关系、草稿保存与实时校验。

## 启动

环境要求：Node.js 20+、pnpm，以及可通过 ADB 访问的 Android 设备。模型网关与模型指派在 Workbench 设置界面维护。

```bash
pnpm install
pnpm build
pnpm start
```

开发时运行 `pnpm dev` 会同时启动前端和 Android/Workbench 服务，打开 `http://127.0.0.1:5173`。生产构建后运行 `pnpm start`，打开 `http://127.0.0.1:5800`。

## OCR 辅助定位

Workbench 会用 OCR 文字框校准模型生成的元素 bbox。默认 `UIKG_OCR_ENGINE=auto`：macOS 优先使用系统 Apple Vision，失败时回退 PaddleOCR；Linux 和 Windows 使用 PaddleOCR。PaddleOCR 是可选依赖，建议使用 Python 3.10-3.12 的独立虚拟环境安装：

```bash
python3.12 -m venv .venv-paddleocr
.venv-paddleocr/bin/python -m pip install -r requirements-paddleocr.txt
```

然后在项目 `.env` 中指定该解释器。Windows 路径可指向 `.venv-paddleocr\\Scripts\\python.exe`。

```dotenv
UIKG_OCR_ENGINE=paddleocr
UIKG_OCR_PYTHON=/absolute/path/to/.venv-paddleocr/bin/python
UIKG_OCR_TIMEOUT_MS=120000
UIKG_PADDLE_OCR_LANG=ch
# UIKG_PADDLE_OCR_DEVICE=gpu:0
```

`UIKG_OCR_ENGINE` 可取 `auto`、`apple-vision`、`paddleocr` 或 `disabled`。OCR 仅作为截图坐标系中的几何辅助，不替代 Midscene 的页面语义识别；图标、开关和无文字控件仍依赖模型视觉框、UI Tree 或 DOM。

## 模型配置

Workbench 的“模式配置”页从本地 SQLite 数据库 `.data/model-settings.sqlite` 读取网关与模型指派。正式模型槽位为 `manual`、`auto`、`ultra_a`、`ultra_b` 和 `midscene`，五者独立保存。Manual 与 Auto 分别使用自己的页面识别模型；Auto 另用 Midscene 完成设备理解和交互；Model A 与 Model B 仅属于 Ultra，二者并列识别。API Key 仅在服务端读取，页面只显示脱敏末四位。

数据库包含两张核心表：

- `model_gateways`：网关名称、Base URL 和 API Key。
- `model_assignments`：五个正式模型槽位的模型、Family、超时、Temperature 和推理强度。

旧数据库中的双模型指派只执行一次结构迁移；正式运行时不接受旧目标名称或 `.env` 模型别名。只有 `midscene` 槽位会在运行时转换成 Midscene SDK 所需配置。Realtime 模型使用独立实时接口，不会出现在当前 OpenAI 兼容 HTTP 模型目录中。

## 数据边界

- 冻结截图按内容哈希保存，作为当时设备状态的原始证据，不被后续操作覆盖。
- 页面识别原始响应按次保存，保留模型当时实际返回的内容，便于审计、比较和重放。
- 人工修改发生在 Draft 草稿层；元素名称、类型、作用、操作能力、状态、边框和归属关系均可修改。
- 再次运行页面识别时，已经确认或人工修订的字段不会被覆盖，新识别结果记录在模型建议中。
- 第一阶段不会写入 `knowledge_graph/apps` 下的 Canonical 知识图谱。

原始证据“不可变”不等于识别结果“不可纠正”。它的含义是保留错误发生时的原始输入和输出；正确结果由可编辑草稿承载。这样既能完成纠错，又能追溯人工修改前后的差异。

## 校验

```bash
pnpm typecheck
pnpm test
pnpm build
```
