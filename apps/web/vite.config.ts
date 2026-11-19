import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const browserOrigin = 'http://127.0.0.1:5173';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'EXAM_RUNTIME_');
  const apiOrigin = `http://127.0.0.1:${env.EXAM_RUNTIME_PORT || '3000'}`;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiOrigin,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (proxyRequest, request) => {
              if (request.headers.origin === browserOrigin) {
                proxyRequest.setHeader('origin', apiOrigin);
              }
            });
          },
        },
      },
    },
  };
});
