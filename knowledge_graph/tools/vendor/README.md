# 本地校验依赖

本目录保存 UIKG 离线校验器运行所需的固定版本第三方依赖。

- `js-yaml-4.1.1.js`：`js-yaml` 4.1.1 官方 `dist/js-yaml.js` 发布文件。
- `js-yaml-4.1.1.LICENSE`：对应 MIT 许可证。

校验器只从本目录加载 YAML 解析器，不搜索工作区外的 `node_modules`。
