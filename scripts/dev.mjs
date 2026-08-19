import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const services = [
  {
    label: 'web',
    cwd: path.join(rootDir, 'apps', 'web'),
    args: [path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js')],
  },
  {
    label: 'api',
    cwd: path.join(rootDir, 'apps', 'api'),
    args: [path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'watch', 'src/server.ts'],
  },
];

let stopping = false;
const children = services.map((service) => {
  const child = spawn(process.execPath, service.args, {
    cwd: service.cwd,
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${service.label} 服务已退出（${signal ?? code ?? '未知原因'}）。`);
      stop(code ?? 1);
    }
  });

  return child;
});

function stop(exitCode) {
  if (stopping) {
    return;
  }

  stopping = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exitCode = exitCode;
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
