import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from './database.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../../../database/migrations');

async function readMigrationFiles() {
  const fileNames = await fs.readdir(migrationsDirectory);
  return fileNames.filter((fileName) => fileName.endsWith('.sql')).sort();
}

async function migrate() {
  const pool = createDatabasePool({ multipleStatements: true });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (version)
      ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    const [rows] = await pool.query('SELECT version, checksum FROM schema_migrations');
    const appliedMigrations = new Map(
      (rows as Array<{ version: string; checksum: string }>).map((row) => [row.version, row.checksum]),
    );

    for (const fileName of await readMigrationFiles()) {
      const sql = await fs.readFile(path.join(migrationsDirectory, fileName), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previousChecksum = appliedMigrations.get(fileName);

      if (previousChecksum) {
        if (previousChecksum !== checksum) {
          throw new Error(`迁移文件 ${fileName} 已被修改，不能继续执行。`);
        }
        console.info(`已跳过迁移：${fileName}`);
        continue;
      }

      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)', [fileName, checksum]);
      console.info(`已执行迁移：${fileName}`);
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  console.error('数据库迁移失败。', error);
  process.exitCode = 1;
});
