import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = Number(env.API_PORT ?? 8787);
  const webPort = Number(env.WEB_PORT ?? 5173);

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${apiPort}`,
      },
    },
  };
});
