import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendOrigin = "http://127.0.0.1:4310";
const devOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // No CORS for the dev server either: other local or remote origins must not
    // read proxied API responses.
    cors: false,
    proxy: {
      "/api": {
        target: backendOrigin,
        // The backend validates Host/Origin against its own loopback origin.
        // Present the dev dashboard's requests as same-origin to the backend;
        // any other Origin is forwarded unchanged and rejected by the backend.
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            const origin = request.headers.origin;
            if (typeof origin === "string" && devOrigins.has(origin.toLowerCase())) {
              proxyRequest.setHeader("Origin", backendOrigin);
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
