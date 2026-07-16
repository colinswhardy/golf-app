# Golf App

Personal golf yardage book, round tracker, and stats app. See [DESIGN.md](./DESIGN.md) for the full
technical design.

## Running it

```
npm install
npm run dev
```

Opens on `http://localhost:5173`. There's no separate production build/deploy step — `npm run dev`
is the only workflow this project needs right now.

## Opening it on the Pixel 9 Pro

The app deploys to **GitHub Pages** automatically on every push to `main`
(`.github/workflows/deploy.yml`). On the phone: open
`https://<github-username>.github.io/golf-app/` in Chrome → menu → **Add to Home Screen**.
Because it's HTTPS, GPS and the PWA install work with zero special setup.

The Mapbox token is injected at build time from the repo secret `VITE_MAPBOX_TOKEN`
(`gh secret set VITE_MAPBOX_TOKEN`). Note the deployed site is a public static bundle, so use a
Mapbox **public** (`pk.`) token and consider restricting it to the github.io URL in Mapbox's
dashboard.

### Alternative: live-reload testing over LAN

For instant iteration without waiting on a deploy, run `npm run dev` and open
`http://192.168.2.46:5173` from the phone (same wifi; IP may drift — check `ipconfig`). Two
one-time setups needed for this path only: allow TCP 5173 through Windows Firewall (admin
PowerShell: `New-NetFirewallRule -DisplayName 'Vite dev server 5173' -Direction Inbound -Protocol
TCP -LocalPort 5173 -Action Allow -Profile Private`), and — because Chrome blocks GPS on plain
HTTP — enable `chrome://flags` → "Insecure origins treated as secure" with
`http://192.168.2.46:5173` on the phone.

## Before it does anything useful

Copy `.env.example` to `.env.local` and fill in:
- `VITE_MAPBOX_TOKEN` — required for any of the map views to render.
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — optional for now; the app works fully offline
  against local IndexedDB without these. Only needed once cloud backup/sync is wired up.

## Try it

- Home → **Courses** → *Preview the in-round map view* — proof-of-concept of the blue dot, tap-to-set
  target, live distance line, and draggable multi-point measuring tool, using only your live GPS
  position (no real course data loaded yet).
- Everything else (course import, round scoring, stats, dispersion) is scaffolded with placeholder
  pages but not built yet.
