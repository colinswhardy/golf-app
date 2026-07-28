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
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest,geojson}"],
        // Persist Mapbox imagery/style data across sessions so replaying a familiar course doesn't
        // re-download the whole map every time (and mostly works on a dead signal). Verified against
        // the app's actual requests: satellite raster + streets vector tiles come from
        // api.mapbox.com/v4/..., the style JSON/sprites from /styles/v1/, glyphs from /fonts/v1/.
        // Deliberately NOT cached: events.mapbox.com (telemetry) and /map-sessions/v1 (billing
        // session) — caching those would be both pointless and wrong.
        runtimeCaching: [
          {
            // Raster + vector tiles: the bulk of the bytes, and immutable per tile coordinate.
            urlPattern: /^https:\/\/(?:api\.mapbox\.com\/v4|[a-d]\.tiles\.mapbox\.com)\//i,
            handler: "CacheFirst",
            options: {
              cacheName: "mapbox-tiles",
              expiration: { maxEntries: 2500, maxAgeSeconds: 60 * 60 * 24 * 90, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
              plugins: [
                {
                  // Mapbox GL appends a `sku` token that ROTATES (and access_token can change), so
                  // the raw URL is a moving target — caching by it would mint a brand-new entry for
                  // the same tile every session, meaning permanent misses and an ever-growing cache.
                  // Normalizing both out makes a tile coordinate map to exactly one entry. Applies to
                  // reads and writes alike, since cacheKeyWillBeUsed runs for both.
                  cacheKeyWillBeUsed: async ({ request }: { request: Request }) => {
                    const url = new URL(request.url);
                    url.searchParams.delete("sku");
                    url.searchParams.delete("access_token");
                    return url.href;
                  }
                }
              ]
            }
          },
          {
            // Style JSON, sprites and glyph ranges: small, but requested on every single map init.
            // StaleWhileRevalidate so they render instantly from cache while still picking up any
            // upstream style change in the background.
            urlPattern: /^https:\/\/api\.mapbox\.com\/(?:styles|fonts)\/v1\//i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "mapbox-style",
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 90, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
              plugins: [
                {
                  cacheKeyWillBeUsed: async ({ request }: { request: Request }) => {
                    const url = new URL(request.url);
                    url.searchParams.delete("sku");
                    url.searchParams.delete("access_token");
                    return url.href;
                  }
                }
              ]
            }
          }
        ]
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
