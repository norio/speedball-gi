import { defineConfig } from 'vite';

export default defineConfig({
  base: '/speedball-gi/',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    rolldownOptions: {
      input: {
        main: 'index.html',
        simple: 'simple.html',
        ballpool: 'ballpool.html',
      },
    },
  },
  resolve: {
    dedupe: ['three'],
    alias: {
      'three/addons': 'three/examples/jsm',
    },
  },
  optimizeDeps: {
    include: [
      '@perplexdotgg/bounce',
      'three',
      'three/webgpu',
      'three/tsl',
      'three-mesh-bvh',
      'speedball-gi',
      'stats-gl',
    ],
  },
});
