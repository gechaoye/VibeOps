# 特别关注 UIKG 3.0.1 规范化报告

本次用 22 个实时双模型冻结帧和 20 次成功 Midscene 动作完成背景遮罩红框修复并复验既有模型。

- 设置行 profile：action_row=1、help_toggle_row=3、selector_row=4、toggle_row=1。
- 页面引用：设置页、提示音面板和成员页只引用顶层容器，不再扁平引用后代。
- 交互边界：说明文字、当前值、帮助内容和 affordance 不可操作；实际 Trigger 独立承担 capability。
- 定位修复：弹窗提醒间隔选择器背景遮罩使用完整模态背景区域的实时 locator 生成独立红框图。
- 普通复合控件：提示音行区分选择与试听，成员行区分主行与移除按钮。
- 重复清理：旧帮助 Page 和 `settings.help.*` 重复元素通过审核迁移记录退出 Canonical。
- 运行冲突：旧“再次点击问号关闭”边已从可执行路网移除并保留反例证据。
- 总体状态：模型规范化完成；历史 仅 Worker B 状态仍缺独立 Worker A，图谱保持 `incomplete`。
