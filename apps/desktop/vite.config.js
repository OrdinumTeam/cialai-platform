// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const desktopRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const mobileResource = mode === 'mobile-resource';
  return {
    root: desktopRoot,
    plugins: [react()],
    publicDir: false,
    base: './',
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port: 1420,
      strictPort: true,
      fs: { allow: [workspaceRoot] },
    },
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    build: {
      outDir: mobileResource ? 'src-tauri/resources/mobile' : 'dist',
      emptyOutDir: true,
      target: 'safari16',
      rollupOptions: {
        input: mobileResource
          ? { mobile: `${desktopRoot}mobile.html` }
          : {
            main: `${desktopRoot}index.html`,
            mobile: `${desktopRoot}mobile.html`,
          },
      },
    },
  };
});
