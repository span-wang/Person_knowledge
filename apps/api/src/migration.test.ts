import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(currentDirectory, '../../../database/migrations/001_initial_schema.sql');

test('初始迁移覆盖核心数据实体且不包含秘密', async () => {
  const sql = await fs.readFile(migrationPath, 'utf8');
  const expectedTables = [
    'materials',
    'chapters',
    'sections',
    'cards',
    'resources',
    'highlights',
    'review_records',
    'ai_provider_profiles',
    'ai_explanations',
    'sync_locks',
    'backup_records',
    'trash_items',
    'app_settings',
  ];

  for (const table of expectedTables) {
    assert.match(sql, new RegExp('CREATE TABLE `' + table + '`'));
  }
  assert.match(sql, /`relative_path` VARCHAR\(512\) NOT NULL/);
  assert.doesNotMatch(sql, /DATABASE_PASSWORD\s*=|CLOUDFLARE_TUNNEL_TOKEN|sk-[A-Za-z0-9]/i);
});

test('题库迁移隔离题目、AI 版本和作答快照且不包含秘密', async () => {
  const sql = await fs.readFile(path.resolve(currentDirectory, '../../../database/migrations/005_phase_6_question_bank.sql'), 'utf8');
  for (const table of ['question_banks', 'question_chapters', 'questions', 'question_ai_explanations', 'practice_sessions', 'practice_attempts']) {
    assert.match(sql, new RegExp('CREATE TABLE `' + table + '`'));
  }
  assert.match(sql, /`options_json` JSON NOT NULL/);
  assert.match(sql, /`answer_json` JSON NOT NULL/);
  assert.match(sql, /`snapshot_json` JSON NOT NULL/);
  assert.match(sql, /ENUM\('single', 'multiple', 'true_false'\)/);
  assert.match(sql, /ENUM\('cram', 'test'\)/);
  assert.doesNotMatch(sql, /API_KEY|PASSWORD|CLOUDFLARE|CIPHERTEXT|SECRET/i);
});

test('题库回收站迁移扩展题库实体枚举', async () => {
  const sql = await fs.readFile(path.resolve(currentDirectory, '../../../database/migrations/006_phase_6_question_trash.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE `trash_items`/);
  assert.match(sql, /'question_bank', 'question_chapter', 'question'/);
});
