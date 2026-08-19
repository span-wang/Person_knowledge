import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const progressDir = path.join(rootDir, 'progress');
const tasksDir = path.join(progressDir, 'tasks');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeContent(value) {
  return value.replace(/\r\n/g, '\n');
}

function escapeCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function renderTable(headers, rows) {
  const header = `| ${headers.map(escapeCell).join(' | ')} |`;
  const divider = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

function renderOrderedList(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

async function readJson(filePath) {
  const source = await fs.readFile(filePath, 'utf8');
  return JSON.parse(source);
}

async function loadTaskFiles() {
  const names = (await fs.readdir(tasksDir))
    .filter((name) => name.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));

  return Promise.all(names.map((name) => readJson(path.join(tasksDir, name))));
}

function priorityRank(priority) {
  const match = String(priority).match(/P(\d+)/);
  return match ? Number(match[1]) : 99;
}

function statusRank(status) {
  const ranks = {
    '进行中': 0,
    '阻塞': 1,
    '未开始': 2,
    '暂缓': 3,
    '已完成': 4,
  };
  return ranks[status] ?? 99;
}

function summarizeStatus(tasks) {
  if (tasks.length === 0 || tasks.every((task) => task.status === '未开始')) {
    return '未开始';
  }
  if (tasks.every((task) => task.status === '已完成')) {
    return '已完成';
  }
  if (tasks.every((task) => task.status === '暂缓')) {
    return '暂缓';
  }
  if (tasks.some((task) => task.status === '阻塞')) {
    return '阻塞';
  }
  return '进行中';
}

function renderBoundary(task) {
  const boundary = task.executionBoundary;
  if (!boundary?.confirmed) {
    return [];
  }

  const lines = [
    `### \`${task.id}\` ${task.title}`,
    '',
    `- 状态：${boundary.statusLabel ?? '边界已确认'}`,
    `- 确认日期：${boundary.confirmedOn ?? '未记录'}`,
  ];

  if (boundary.summary) {
    lines.push(`- 边界摘要：${boundary.summary}`);
  }
  if (boundary.inScope?.length) {
    lines.push('- 本步纳入：', ...boundary.inScope.map((item) => `  - ${item}`));
  }
  if (boundary.outOfScope?.length) {
    lines.push('- 本步明确不纳入：', ...boundary.outOfScope.map((item) => `  - ${item}`));
  }
  if (boundary.deferredTo?.length) {
    lines.push('- 后续归属任务：', ...boundary.deferredTo.map((item) => `  - ${item}`));
  }
  lines.push('');
  return lines;
}

function validateData({ config, taskFiles, allTasks, risks, techDebts, logs }) {
  const allowedStatuses = new Set(config.statusDefinitions.map((item) => item.status));
  const phaseIds = new Set(config.phases.map((item) => item.id));
  const milestoneIds = new Set(config.milestones.map((item) => item.id));
  const moduleIds = new Set(config.modules.map((item) => item.id));
  const taskIds = new Set();
  const logIds = new Set();
  const riskIds = new Set();
  const debtIds = new Set();

  assert(config.projectName, 'progress/config.json 缺少 projectName。');
  assert(config.generatedFiles?.progressDocument, '缺少进度文档输出路径。');
  assert(config.generatedFiles?.boardDocument, '缺少执行看板输出路径。');

  for (const taskFile of taskFiles) {
    assert(phaseIds.has(taskFile.phaseId), `任务文件引用未知阶段：${taskFile.phaseId}`);
    assert(Array.isArray(taskFile.tasks), `阶段任务缺少 tasks 数组：${taskFile.phaseId}`);

    for (const task of taskFile.tasks) {
      assert(task.id, `阶段 ${taskFile.phaseId} 存在无 ID 任务。`);
      assert(!taskIds.has(task.id), `任务 ID 重复：${task.id}`);
      taskIds.add(task.id);
      assert(task.title, `任务缺少标题：${task.id}`);
      assert(task.acceptance, `任务缺少验收标准：${task.id}`);
      assert(allowedStatuses.has(task.status), `任务状态非法：${task.id} -> ${task.status}`);
      assert(task.moduleIds?.every((id) => moduleIds.has(id)), `任务引用未知模块：${task.id}`);
      assert(task.milestoneIds?.every((id) => milestoneIds.has(id)), `任务引用未知里程碑：${task.id}`);
      if (task.status === '已完成') {
        assert(task.completedOn, `已完成任务缺少 completedOn：${task.id}`);
      }
      if (task.executionBoundary?.confirmed) {
        assert(task.executionBoundary.inScope?.length, `已确认边界缺少本步纳入：${task.id}`);
        assert(task.executionBoundary.outOfScope?.length, `已确认边界缺少本步明确不纳入：${task.id}`);
        assert(task.executionBoundary.deferredTo?.length, `已确认边界缺少后续归属任务：${task.id}`);
      }
    }
  }

  for (const risk of risks) {
    assert(risk.id && !riskIds.has(risk.id), `风险 ID 缺失或重复：${risk.id ?? '未知'}`);
    riskIds.add(risk.id);
    assert(risk.description && risk.impactScope && risk.currentHandling, `风险字段不完整：${risk.id}`);
  }

  for (const debt of techDebts) {
    assert(debt.id && !debtIds.has(debt.id), `技术债 ID 缺失或重复：${debt.id ?? '未知'}`);
    debtIds.add(debt.id);
    assert(allowedStatuses.has(debt.status), `技术债状态非法：${debt.id} -> ${debt.status}`);
  }

  for (const log of logs) {
    assert(log.id && !logIds.has(log.id), `日志 ID 缺失或重复：${log.id ?? '未知'}`);
    logIds.add(log.id);
    assert(log.taskIds?.length, `日志缺少任务 ID：${log.id}`);
    assert(log.taskIds.every((id) => taskIds.has(id)), `日志引用未知任务：${log.id}`);
    assert(log.result && log.verification?.length && log.affectedFiles?.length, `日志字段不完整：${log.id}`);
  }

  const phaseTaskMap = new Map(taskFiles.map((item) => [item.phaseId, item.tasks]));
  for (const phase of config.phases) {
    const expected = summarizeStatus(phaseTaskMap.get(phase.id) ?? []);
    assert(phase.status === expected, `阶段状态与任务不一致：${phase.id}，配置=${phase.status}，任务汇总=${expected}`);
  }

  for (const milestone of config.milestones) {
    const related = allTasks.filter((task) => task.milestoneIds.includes(milestone.id));
    const expected = summarizeStatus(related);
    assert(milestone.status === expected, `里程碑状态与任务不一致：${milestone.id}，配置=${milestone.status}，任务汇总=${expected}`);
  }
}

function buildProgressDocument({ config, phaseTaskMap, allTasks, risks, techDebts, logs }) {
  const currentPhase = config.phases.find((phase) => phase.status !== '已完成') ?? config.phases.at(-1);
  const currentMilestone = config.milestones.find((item) => item.status !== '已完成') ?? config.milestones.at(-1);
  const activeTasks = allTasks
    .filter((task) => task.status === '进行中' || task.status === '阻塞')
    .sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.order - right.order);
  const nextTasks = (phaseTaskMap.get(currentPhase.id) ?? [])
    .filter((task) => task.status === '未开始')
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.order - right.order)
    .slice(0, 5);
  const boundaries = allTasks.filter((task) => task.executionBoundary?.confirmed);

  const lines = [
    '# 项目开发进度',
    '',
    '> 本文件由 `progress/config.json`、`progress/tasks/*.json`、`progress/risks.json`、`progress/tech-debts.json` 和 `progress/logs.json` 自动生成。',
    '>',
    '> 请不要直接修改本文件；手工改动会在下次执行 `npm run progress:build` 时被覆盖。',
    '',
    '## 1. 文档目的',
    '',
    `本文件跟踪 **${config.projectName}** 的阶段、里程碑、模块、任务、风险、技术债和每次可验证推进。`,
    '',
    '业务与工程基线：',
    '',
    ...config.baselineDocuments.map((item) => `- \`${item}\``),
    '',
    '## 2. 跟踪原则',
    '',
    renderOrderedList(config.trackingPrinciples),
    '',
    '## 3. 完成判定',
    '',
    ...config.stepCompletionRequirements.map((item) => `- ${item}`),
    '',
    '## 4. 状态定义',
    '',
    renderTable(
      ['状态', '含义', '使用规则'],
      config.statusDefinitions.map((item) => [`\`${item.status}\``, item.meaning, item.rule]),
    ),
    '',
    '## 5. 阶段',
    '',
    renderTable(
      ['阶段', '目标', '计划周期', '状态'],
      config.phases.map((item) => [item.label, item.goal, item.plannedCycle, `\`${item.status}\``]),
    ),
    '',
    '## 6. 里程碑',
    '',
    renderTable(
      ['里程碑', '完成标准', '状态'],
      config.milestones.map((item) => [`\`${item.id}\` ${item.label}`, item.completion, `\`${item.status}\``]),
    ),
    '',
    '## 7. 模块',
    '',
    renderTable(
      ['模块', '能力层', '状态', '说明'],
      config.modules.map((item) => [item.name, item.capabilityLayer, `\`${item.status}\``, item.summary]),
    ),
    '',
    '## 8. 当前执行概览',
    '',
    `- 当前阶段：${currentPhase.label}（\`${currentPhase.status}\`）`,
    `- 当前里程碑：\`${currentMilestone.id}\` ${currentMilestone.label}（\`${currentMilestone.status}\`）`,
    '',
    '### 8.1 进行中或阻塞任务',
    '',
    activeTasks.length
      ? renderTable(['任务', '标题', '优先级', '状态', '验收标准'], activeTasks.map((task) => [`\`${task.id}\``, task.title, task.priority, `\`${task.status}\``, task.acceptance]))
      : '当前没有进行中或阻塞任务。',
    '',
    '### 8.2 当前阶段下一批任务',
    '',
    nextTasks.length
      ? renderTable(['任务', '标题', '优先级', '验收标准'], nextTasks.map((task) => [`\`${task.id}\``, task.title, task.priority, task.acceptance]))
      : '当前阶段没有待开始任务。',
    '',
    '## 9. 全部任务',
    '',
  ];

  for (const phase of config.phases) {
    const tasks = [...(phaseTaskMap.get(phase.id) ?? [])].sort((left, right) => left.order - right.order);
    lines.push(
      `### ${phase.label}`,
      '',
      renderTable(
        ['任务', '标题', '优先级', '里程碑', '状态', '验收标准'],
        tasks.map((task) => [
          `\`${task.id}\``,
          task.title,
          task.priority,
          task.milestoneIds.map((id) => `\`${id}\``).join('、'),
          `\`${task.status}\``,
          task.acceptance,
        ]),
      ),
      '',
    );
  }

  lines.push('## 10. 已确认执行边界', '');
  if (boundaries.length === 0) {
    lines.push('当前没有已确认的执行边界。', '');
  } else {
    for (const task of boundaries.sort((left, right) => left.order - right.order)) {
      lines.push(...renderBoundary(task));
    }
  }

  lines.push(
    '## 11. 风险与范围变化',
    '',
    renderTable(
      ['ID', '日期', '类型', '描述', '影响范围', '当前处理'],
      risks.map((item) => [`\`${item.id}\``, item.date, item.type, item.description, item.impactScope, item.currentHandling]),
    ),
    '',
    '## 12. 技术债与延期能力',
    '',
    renderTable(
      ['ID', '事项', '来源', '状态', '偿还计划'],
      techDebts.map((item) => [`\`${item.id}\``, item.debt, item.sourcePhase, `\`${item.status}\``, item.repaymentPlan]),
    ),
    '',
    '## 13. 变更日志',
    '',
  );

  for (const log of [...logs].reverse()) {
    lines.push(
      `### \`${log.id}\` ${log.date} - ${log.step}`,
      '',
      `- 任务：${log.taskIds.map((id) => `\`${id}\``).join('、')}`,
      `- 阶段/里程碑：${log.phaseMilestone}`,
      `- 动作：${log.action}`,
      `- 结果：${log.result}`,
      '- 验证：',
      ...log.verification.map((item) => `  - ${item}`),
      `- 影响文件：${log.affectedFiles.map((item) => `\`${item}\``).join('、')}`,
      `- 下一步：${log.next}`,
      '',
    );
  }

  return `${lines.join('\n').trim()}\n`;
}

function buildBoardDocument({ config, phaseTaskMap, allTasks, risks, logs }) {
  const currentPhase = config.phases.find((phase) => phase.status !== '已完成') ?? config.phases.at(-1);
  const currentMilestone = config.milestones.find((item) => item.status !== '已完成') ?? config.milestones.at(-1);
  const currentPhaseTasks = phaseTaskMap.get(currentPhase.id) ?? [];
  const activeTasks = allTasks
    .filter((task) => task.status === '进行中' || task.status === '阻塞')
    .sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.order - right.order);
  const nextTasks = currentPhaseTasks
    .filter((task) => task.status === '未开始')
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.order - right.order)
    .slice(0, 3);
  const confirmedBoundaries = currentPhaseTasks.filter((task) => task.executionBoundary?.confirmed && task.status === '未开始');
  const completed = allTasks
    .filter((task) => task.status === '已完成')
    .sort((left, right) => String(right.completedOn).localeCompare(String(left.completedOn)))
    .slice(0, 5);

  const lines = [
    '# 当前执行看板',
    '',
    '> 本文件由结构化进度源自动生成，请勿直接修改。',
    '',
    '## 当前焦点',
    '',
    `- 项目：${config.projectName}`,
    `- 阶段：${currentPhase.label}（\`${currentPhase.status}\`）`,
    `- 里程碑：\`${currentMilestone.id}\` ${currentMilestone.label}（\`${currentMilestone.status}\`）`,
    '',
    '## 进行中与阻塞',
    '',
    activeTasks.length
      ? renderTable(['任务', '标题', '状态', '验收标准'], activeTasks.map((task) => [`\`${task.id}\``, task.title, `\`${task.status}\``, task.acceptance]))
      : '当前没有进行中或阻塞任务。',
    '',
    '## 下一步',
    '',
    nextTasks.length
      ? renderTable(['顺序', '任务', '标题', '验收标准'], nextTasks.map((task, index) => [index + 1, `\`${task.id}\``, task.title, task.acceptance]))
      : '当前阶段没有待开始任务。',
    '',
    '## 已确认待开工边界',
    '',
  ];

  if (confirmedBoundaries.length) {
    for (const task of confirmedBoundaries) {
      lines.push(...renderBoundary(task));
    }
  } else {
    lines.push('当前没有已确认但尚未开始的任务边界。', '');
  }

  lines.push(
    '## 当前风险',
    '',
    renderTable(
      ['ID', '类型', '描述', '当前处理'],
      risks.map((item) => [`\`${item.id}\``, item.type, item.description, item.currentHandling]),
    ),
    '',
    '## 最近完成',
    '',
    completed.length
      ? renderTable(['任务', '标题', '完成日期'], completed.map((task) => [`\`${task.id}\``, task.title, task.completedOn]))
      : '尚无已完成任务。',
    '',
    '## 最近日志',
    '',
    renderTable(
      ['日志', '日期', '步骤', '下一步'],
      [...logs].slice(-5).reverse().map((item) => [`\`${item.id}\``, item.date, item.step, item.next]),
    ),
    '',
    '## 使用规则',
    '',
    '- 真相源位于 `progress/`，不在本文件。',
    '- 开工前先确认任务边界并写入任务卡。',
    '- 完成后更新任务、风险/技术债和日志，再执行 `npm run progress:build`。',
    '- 提交前执行 `npm run progress:check`。',
    '',
  );

  return lines.join('\n');
}

async function writeOrCheck(targetPath, content, checkOnly) {
  if (checkOnly) {
    const current = await fs.readFile(targetPath, 'utf8').catch(() => '');
    if (normalizeContent(current) !== normalizeContent(content)) {
      throw new Error(`生成产物未同步：${path.relative(rootDir, targetPath)}，请执行 npm run progress:build`);
    }
    return;
  }
  await fs.writeFile(targetPath, content, 'utf8');
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const config = await readJson(path.join(progressDir, 'config.json'));
  const taskFiles = await loadTaskFiles();
  const risks = (await readJson(path.join(progressDir, 'risks.json'))).items;
  const techDebts = (await readJson(path.join(progressDir, 'tech-debts.json'))).items;
  const logs = (await readJson(path.join(progressDir, 'logs.json'))).entries;

  const phaseTaskMap = new Map();
  const allTasks = [];
  for (const taskFile of taskFiles) {
    phaseTaskMap.set(taskFile.phaseId, taskFile.tasks);
    allTasks.push(...taskFile.tasks.map((task) => ({ ...task, phaseId: taskFile.phaseId })));
  }

  validateData({ config, taskFiles, allTasks, risks, techDebts, logs });

  const progressDocument = buildProgressDocument({ config, phaseTaskMap, allTasks, risks, techDebts, logs });
  const boardDocument = buildBoardDocument({ config, phaseTaskMap, allTasks, risks, logs });

  await writeOrCheck(path.join(rootDir, config.generatedFiles.progressDocument), progressDocument, checkOnly);
  await writeOrCheck(path.join(rootDir, config.generatedFiles.boardDocument), boardDocument, checkOnly);

  if (!checkOnly) {
    process.stdout.write('进度文档已生成。\n');
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
  process.exit(1);
});
