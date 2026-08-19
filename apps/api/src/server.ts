import { createApp } from './app.js';
import { config } from './config.js';
import { createDataGovernanceService, startBackupScheduler } from './data-governance-service.js';
import { createAuthService } from './auth.js';

const dataGovernanceService = createDataGovernanceService();
const app = createApp(new Date(), { dataGovernanceService, authService: createAuthService(config.auth) });
const backupTimer = startBackupScheduler(dataGovernanceService);
const server = app.listen(config.port, '127.0.0.1', () => {
  console.info(`API 服务已启动：http://127.0.0.1:${config.port}`);
});

server.on('error', (error) => {
  console.error(error);
  clearInterval(backupTimer);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(backupTimer);
    server.close();
  });
}
