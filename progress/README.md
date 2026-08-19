# 结构化开发进度

`progress/` 是本项目开发进度的唯一真相源。

## 文件职责

- `config.json`：阶段、里程碑、模块、状态和生成文件配置。
- `tasks/*.json`：各阶段任务卡、验收标准和已确认执行边界。
- `risks.json`：风险、返工和范围变化。
- `tech-debts.json`：明确延期或尚未偿还的能力。
- `logs.json`：每次可独立验收推进的结果记录。

## 使用方式

完成结构化源更新后运行：

```powershell
npm run progress:build
npm run progress:check
```

不要直接编辑 `项目开发进度.md` 和 `当前执行看板.md`。
