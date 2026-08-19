import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(currentDirectory, '../../../database/migrations/002_phase_5_07_catalog.sql');

test('PH5-07 迁移建立目录、封面和状态历史边界', async () => {
  const sql = await fs.readFile(migrationPath, 'utf8');

  for (const table of ['courses', 'subjects', 'material_covers', 'review_status_history']) {
    assert.match(sql, new RegExp('CREATE TABLE `' + table + '`'));
  }
  assert.match(sql, /ALTER TABLE `materials`[\s\S]*ADD COLUMN `subject_id` CHAR\(36\)/);
  assert.match(sql, /SET `subject_id` = @default_subject_id/);
  assert.match(sql, /VALUES \(@default_course_id, '待整理', 0, TRUE\)/);
  assert.match(sql, /VALUES \(@default_subject_id, @default_course_id, '待整理', 0, TRUE\)/);
  assert.match(sql, /CURRENT_TIMESTAMP\(3\), 'migration'/);
  assert.doesNotMatch(sql, /DATABASE_PASSWORD\s*=|CLOUDFLARE_TUNNEL_TOKEN|sk-[A-Za-z0-9]/i);
});
