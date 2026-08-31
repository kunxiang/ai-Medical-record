import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// spec m1-05 §1:SW 只做外壳预缓存。
// 无 sync 事件处理(ADR-046:SW 读不到 token,且触发时无 client 可转发)。
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'MediReco · 家庭健康档案',
        short_name: 'MediReco',
        start_url: '/',
        display: 'standalone',
        background_color: '#f4f7f5',
        theme_color: '#0a564f',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // ★ 裁边检测器(opencv.js,约 3.9 MB gzip / 15 MB 未压缩)不进 precache。
        //   进了 precache 就是让每个用户在安装时先付这 4 MB —— 包括从不用这个功能的人,
        //   而裁边的定位是**增益不是前提**(检测不到就退回整幅,那是已知可用的行为)。
        //   注意默认的 maximumFileSizeToCacheInBytes 是 2 MiB,即便不 ignore 它也会被
        //   静默踢出 precache 且不报错 —— 这里显式排除,免得靠一个默认值维持正确行为。
        globIgnores: ['**/opencv-*.js', '**/opencv-*.js.map'],
        navigateFallback: 'index.html',
        // 否则 API 的 404 会被外壳 HTML 顶掉(审核 #002 A-23)
        navigateFallbackDenylist: [/^\/api\//],
        // ★ 仍然不缓存任何 API 与 S3 请求。唯一的运行时缓存是上面排除掉的检测器:
        //   首次用到时下载,此后永久离线可用 —— 采集在诊室离线进行,而应用至少被联网
        //   打开过一次,所以实际覆盖与 precache 几乎一样,却不向所有人收安装期的过路费。
        runtimeCaching: [
          {
            urlPattern: /\/assets\/opencv-[^/]+\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'crop-detector',
              expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173, host: true },
  preview: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true },
});
