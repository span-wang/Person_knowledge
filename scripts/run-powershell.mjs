import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const [scriptPath, ...scriptArguments] = process.argv.slice(2);
if (!scriptPath) {
  console.error('缺少 PowerShell 脚本路径。');
  process.exit(2);
}

const candidates = [];
if (process.env.SystemRoot) {
  candidates.push(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
}
candidates.push('powershell.exe', 'pwsh.exe');

for (const executable of candidates) {
  if (path.isAbsolute(executable) && !existsSync(executable)) {
    continue;
  }

  const result = spawnSync(executable, [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.resolve(scriptPath),
    ...scriptArguments,
  ], { stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') {
    continue;
  }
  process.exit(result.status ?? 1);
}

console.error('未找到可用的 PowerShell（powershell.exe 或 pwsh.exe）。');
process.exit(1);
