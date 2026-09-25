import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.PALERMO_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/mcp': target,
      '/socket.io': { target, ws: true },
    },
  },
});
