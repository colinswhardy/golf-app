import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Day-to-day workflow is `npm run dev` (base "/"). The GitHub Actions deploy sets
// VITE_BASE=/golf-app/ so the built app works at https://<user>.github.io/golf-app/.
const base = process.env.VITE_BASE ?? "/";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Off in dev: the dev-mode SW hits the same apostrophe-in-path workbox codegen
      // bug as `npm run build` does locally (see DESIGN.md Open Items), so it 500s on
      // this machine. Harmless to disable — it doesn't affect the app itself (only SW
      // registration fails, everything else works), and "Add to Home Screen" testing
      // only ever needs to happen against the real deployed site anyway.
      devOptions: { enabled: false },
      workbox: {
        // Default precache limit is 2 MiB; our main bundle (mostly Mapbox GL) is ~2.2 MB.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Default glob only covers js/css/html — bundled course GeoJSON needs to be
        // precached too, so course data works with zero network on the course.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest,geojson}"]
      },
      manifest: {
        name: "Golf",
        short_name: "Golf",
        description: "Personal golf yardage book, round tracker, and stats",
        start_url: base,
        scope: base,
        display: "standalone",
        orientation: "portrait",
        background_color: "#0b3d1f",
        theme_color: "#0b3d1f",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      }
    })
  ],
  server: {
    host: true,
    port: 5173
  }
});
