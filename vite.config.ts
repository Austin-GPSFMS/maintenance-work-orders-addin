import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config for the GPSFMS Maintenance Work Orders MyGeotab add-in.
 *
 * Hosted at:
 *   https://austin-gpsfms.github.io/maintenance-work-orders-addin/dist/index.html
 *
 * `base` is the ABSOLUTE GitHub Pages URL (same convention as the other
 * GPSFMS add-ins): MyGeotab injects the add-in HTML into the my.geotab.com
 * page, so relative asset paths would resolve against Geotab's origin and 404.
 */
export default defineConfig({
  base: "https://austin-gpsfms.github.io/maintenance-work-orders-addin/dist/",
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: true,
    assetsInlineLimit: 20480,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },
  server: { port: 5176, strictPort: false },
});
