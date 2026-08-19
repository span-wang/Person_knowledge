import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readLocalEnvironment() {
  const values = {};
  for (const fileName of ['.env', '.env.local']) {
    const filePath = path.join(projectRoot, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
      if (!match || match[1] in values) {
        continue;
      }
      values[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, '$2');
    }
  }
  return values;
}

const localEnvironment = readLocalEnvironment();
const configuredValue = (name, fallback = '') => process.env[name] ?? localEnvironment[name] ?? fallback;
const configuredPath = (value, fallback) => {
  const selected = value.trim() || fallback;
  return path.normalize(path.isAbsolute(selected) ? selected : path.resolve(projectRoot, selected));
};

function fail(message) {
  console.error(`[tunnel:check] ${message}`);
  process.exitCode = 1;
}

const binarySetting = configuredValue('CLOUDFLARED_BIN', 'cloudflared.exe');
const binaryPath = path.isAbsolute(binarySetting)
  ? binarySetting
  : configuredPath(binarySetting, 'cloudflared.exe');
const binary = fs.existsSync(binaryPath) ? binaryPath : binarySetting;
const configPath = configuredPath(configuredValue('CLOUDFLARED_CONFIG'), 'cloudflared/config.yml');
const credentialsPath = configuredPath(
  configuredValue('CLOUDFLARED_CREDENTIALS_FILE'),
  'cloudflared/tunnel-credentials.json',
);
const publicUrl = configuredValue('CLOUDFLARED_PUBLIC_URL', 'https://review.panspan.cloud').trim();

if (!fs.existsSync(configPath)) {
  fail(`未找到配置文件：${configPath}。请先复制 cloudflared/config.example.yml 为 config.yml 并填写本机值。`);
}
if (!fs.existsSync(credentialsPath)) {
  fail(`未找到 Tunnel 凭证文件：${credentialsPath}。凭证只应保存在本机，不要提交到代码库。`);
}
try {
  const parsedUrl = new URL(publicUrl);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'review.panspan.cloud') {
    fail('CLOUDFLARED_PUBLIC_URL 必须是 https://review.panspan.cloud。');
  }
} catch {
  fail('CLOUDFLARED_PUBLIC_URL 不是有效的 HTTPS 地址。');
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

const result = spawnSync(binary, ['tunnel', '--config', configPath, 'ingress', 'validate'], {
  cwd: projectRoot,
  encoding: 'utf8',
  windowsHide: true,
});
if (result.error) {
  fail(`无法执行 cloudflared：${result.error.message}`);
}
if (result.status !== 0) {
  const details = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  fail(`Tunnel ingress 配置校验失败${details ? `：${details}` : '。'}`);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

const gate = configuredValue('PUBLIC_ACCESS_READY', 'false').toLowerCase() === 'true';
console.log(`[tunnel:check] 配置有效：${configPath}`);
console.log(`[tunnel:check] 公网地址：${publicUrl}`);
console.log(`[tunnel:check] 公网安全门禁：${gate ? '已开启' : '未开启（start.ps1 将拒绝启动 Tunnel）'}`);
