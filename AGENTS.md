# 项目协作约定

## 1. 目标

本项目必须同时遵守：

1. 按 `项目产品定位.md`、`项目开发方案.md` 和 `DESIGN.md` 推进产品开发。
2. 按 `progress/` 结构化真相源维护可回溯、可校验的开发进度。

## 2. 进度真相源

以下 JSON 文件是进度唯一真相源，必须手工维护：

- `progress/config.json`
- `progress/tasks/*.json`
- `progress/risks.json`
- `progress/tech-debts.json`
- `progress/logs.json`

以下 Markdown 是自动生成的展示层，禁止直接手工修改：

- `项目开发进度.md`
- `当前执行看板.md`

生成与校验命令：

- `npm run progress:build`
- `npm run progress:check`

## 3. 开发规则

1. 每次只推进一个可独立验收的最小步骤。
2. 每一步必须绑定明确任务 ID，优先使用 `PHx-xx`，治理或文档使用 `GOV-xxx` / `DOC-xxx`。
3. 用户确认下一步方案后，开始改代码前，先把边界写回任务卡：本步纳入、本步明确不纳入、后续归属任务。
4. 未达到验收标准只能标记为 `进行中`，不能提前标记 `已完成`。
5. 完成一步后，更新任务卡、必要时更新风险/技术债，并追加一条日志。
6. 更新结构化源后必须运行 `npm run progress:build`；提交前运行 `npm run progress:check`。
7. 发现阻塞、返工、范围变化时，必须同步更新 `progress/risks.json`。
8. 代码注释使用简体中文，只解释非显而易见的决策和复杂逻辑。
9. 前端界面使用简体中文；专有技术名词可保留英文。
10. 不得把 Markdown 源文件当作导入后的长期真相源，也不得让前端出现 Markdown 源码编辑态。
11. API Key、MySQL 密码、Cloudflare Tunnel 凭证不得进入代码库、Markdown 导出或 JSON 备份。
12. 公网开放前必须先完成单账号密码保护；登录功能虽然排在开发顺序最后，但不能绕过安全门槛上线。
13. 前端必须遵守 `DESIGN.md` 的 iOS 风格层级和控件规范。
14. 主界面禁止出现功能介绍长段落；按钮文字原则上不超过 4 个汉字。
15. 图标能明确表达动作时优先使用图标，陌生图标必须提供 Tooltip 和无障碍名称。
16. 图表的设计必须使用并遵守C:\Users\panshimao\.codex\skills\lieflat-charts技能
17. UI的设计和修改必须使用和遵守C:\Users\panshimao\.codex\skills\ui-ux-pro-max技能

## 4. 完成标准

一次推进只有同时满足以下条件才算完成：

- 有明确对象和任务 ID；
- 有代码、文档、测试、配置或可运行流程等实际产出；
- 有命令、测试或人工验收证据；
- 进度真相源与自动生成展示层已同步。

## 5. 范围控制

第一版不自动扩展 PDF 导入、离线复习、随机复习、间隔重复、提醒、标签、多用户协作或 AI 历史版本。新增范围必须先更新产品定位、开发方案和进度风险，再拆分任务。
