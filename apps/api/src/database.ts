import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';
import { config } from './config.js';

export function createDatabasePool(options: Pick<PoolOptions, 'multipleStatements'> = {}): Pool {
  return mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name,
    waitForConnections: true,
    connectionLimit: config.database.connectionLimit,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    ...options,
  });
}

export async function checkDatabaseConnection() {
  const pool = createDatabasePool();

  try {
    await pool.query('SELECT 1 AS ok');
  } finally {
    await pool.end();
  }
}
