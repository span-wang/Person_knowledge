import { checkDatabaseConnection } from './database.js';

checkDatabaseConnection()
  .then(() => {
    console.info('数据库连接正常。');
  })
  .catch((error: unknown) => {
    console.error('数据库连接失败。', error);
    process.exitCode = 1;
  });
