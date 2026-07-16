import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Day-to-day workflow is `npm run dev` (base "/"). The GitHub Actions deploy sets
// VITE_BASE=/golf-app/ so the built app works at https://<user>.github.io/golf-app/.
// PWA dev mode stays enabled so "Add to Home Screen" also works off the dev server.
const base = process.env.VITE_BASE ?? "/";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      devOptions: { enabled: true },
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
