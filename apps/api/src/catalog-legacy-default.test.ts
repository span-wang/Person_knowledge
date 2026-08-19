import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(currentDirectory, '../../../database/migrations/003_phase_5_07_legacy_material_default.sql');

test('PH5-07 兼容迁移为旧资料写入提供默认科目', async () => {
  const sql = await fs.readFile(migrationPath, 'utf8');

  assert.match(sql, /DROP FOREIGN KEY `fk_materials_subject`/);
  assert.match(sql, /SET `id` = @default_course_id/);
  assert.match(sql, /SET `id` = @default_subject_id/);
  assert.match(sql, /DEFAULT '00000000-0000-4000-8000-000000000002'/);
});
