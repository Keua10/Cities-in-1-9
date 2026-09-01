import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          pixi: ['pixi.js'],
          // 로그인은 pixi 보다 먼저 뜬다. 따로 떼어놔야 앱 코드를 고쳐도
          // 학생 브라우저가 firebase 를 다시 받지 않는다.
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore'],
        },
      },
    },
  },
  server: { host: true },
});
