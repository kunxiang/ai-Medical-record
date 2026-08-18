import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// spec m1-05 §1:SW 只做外壳预缓存。
// 无 sync 事件处理(ADR-046:SW 读不到 token,且触发时无 client 可转发)。
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'AI 病历 · 采集',
        short_name: 'AI 病历',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#0f766e',
        icons: [],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: 'index.html',
        // 否则 API 的 404 会被外壳 HTML 顶掉(审核 #002 A-23)
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],          // ★ 不缓存任何 API 与 S3 请求
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173, host: true },
  preview: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true },
});
