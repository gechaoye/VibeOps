# 全局搜索功能探索报告

## 状态

`incomplete`。任务契约、设备门禁和双模型预检已建立，但入口下的递归队列尚未开始执行，Canonical 图谱与 Obsidian 投影没有发布变更。

## 探索范围

- 应用：中通宝盒 FAT `8.58.0.10542`
- 入口：消息页右上角放大镜 icon
- 权威事实：该入口的功能名称为“全局搜索”
- 计划：从应用前台进入消息页，打开全局搜索，然后覆盖所有安全可达的页面、覆盖层、控件、滚动状态和结果状态

## 实际批次

1. `initial-navigation-attempt1` 启动了同一个 Midscene `AndroidAgent`，冻结了首帧并调用了独立 `qwen3-vl-plus` Worker A。Worker A 响应的 `approximateRegion` 未满足技能 schema 的归一化约束，分支在动作前以 `unresolved` 结束。
2. `initial-navigation-attempt2` 在截图前被设备门禁阻断：设备处于梦境锁屏状态，系统 NotificationShade 获得焦点。未执行任何 UI 动作；`stay_on_while_plugged_in` 已恢复到起始值 `0`。

## 未完成项

设备需要人工唤醒并保持解锁、让中通宝盒回到前台消息页。恢复后应从 `plans/initial-navigation.plan.json` 继续，并重新验证首帧 Worker A schema，再执行入口导航和递归队列。

## 证据

- 首轮原始证据：`initial-navigation-attempt1/raw-evidence/`
- 第二轮设备门禁证据：`initial-navigation-attempt2/raw-evidence/sessions/01KYS35BW2W9TND42SF74YE80J/raw-session.json`
- 覆盖记录：`coverage.yaml`
- 任务契约：`scope.yaml`
