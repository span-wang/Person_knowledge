import { verifyStoragePaths } from './storage.js';

verifyStoragePaths()
  .then((results) => {
    for (const result of results) {
      console.info(`${result.kind} 路径可读写：${result.path}`);
    }
  })
  .catch((error: unknown) => {
    console.error('存储路径检查失败。', error);
    process.exitCode = 1;
  });
