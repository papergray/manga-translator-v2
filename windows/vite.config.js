import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    assetsDir: "assets",
    rollupOptions: {
      external: ["electron"],
    },
  },
  optimizeDeps: {
    exclude: ["@xenova/transformers", "tesseract.js"],
  },
  server: {
    port: 5173,
  },
});
