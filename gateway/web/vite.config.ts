import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En dev, l'API et le WebRTC sont servis par la passerelle Go (port 8765).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8765' } },
});
