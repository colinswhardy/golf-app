# HANDOVER — golf-app ("CaddyShot")

> **STALE AS OF 2026-07-28.** This document describes the codebase BEFORE `REVISION-SPEC.md` was
> implemented. Since then: backup/export exists, reseed orphaning is fixed (slug + importerVersion,
> additive re-imports, integrity repair), `npm run build` type-checks, vitest covers the pure libs,
> two-stream capture (NFC club tags + watch laps), the reconciliation engine, the green-marking
> screen (putts are Shot rows), review/correction UI, and the stats engine all exist. §6 (no
> backend) is still accurate. Read this for history and hard-won gotchas, not for current state.

Audience: a Claude instance (or human) who has **never seen this repo** and is designing a major
revision. This document is self-contained; you should not need repo access to reason about the
system. It is deliberately blunt about weaknesses.

**What this is:** a personal, single-user golf yardage-book / GPS round-tracker / shot-logger,
built as a mobile web PWA for one person (Colin, Pixel 9 Pro, Chrome on Android). No accounts, no
social features, no multi-user anything. The player's name is literally hardcoded
(`PLAYER_NAME = "Colin"` in `RoundMapPage.tsx`). Two Ontario courses (Tarandowah Golfers Club,
Innerkip Highlands GC) ship inside the bundle as OpenStreetMap exports. "CaddyShot" appears only
in localStorage key names (`caddyshot_*`); the package and UI are just "Golf" / "golf-app".

---

## 1. Stack and versions

- **Framework:** React 18.3.1 (function components + hooks only, `StrictMode` on), TypeScript 5.9.3 (`strict: true`), react-router-dom 6.30.4 (`BrowserRouter` with `basename=import.meta.env.BASE_URL`).
- **Build:** Vite 5.4.21 + `@vitejs/plugin-react` 4.7.0. **`npm run build` does NOT type-check** — the script is just `vite build`, no `tsc -b`. Type errors ship silently unless someone runs `npx tsc -b` by hand.
- **Target platform: PWA only.** No Capacitor, no native shell, no Electron. `vite-plugin-pwa` 0.20.5 (Workbox `generateSW`) provides installability + precache + Mapbox tile runtime caching. Deployed to GitHub Pages, installed via Chrome "Add to Home Screen".
- **Map:** Mapbox GL JS 3.26.0 (web SDK — note this has **no first-party offline-region support**; that's native-SDK-only).
- **Geometry math:** @turf/turf 7.3.5 plus a small hand-rolled `src/lib/geo.ts` (haversine, bearing, local ENU projection, dispersion ellipse fitting).
- **Storage:** Dexie 4.4.4 (IndexedDB) + dexie-react-hooks 1.1.7 (`useLiveQuery` everywhere). **This is the only datastore that actually exists.**
- **Backend:** @supabase/supabase-js 2.110.7 is installed and a client is conditionally constructed — **and then never used anywhere**. See §6.
- **No test framework, no linter, no formatter config.** There are `eslint-disable` comments in the code but no ESLint config or dependency — they are inert decoration.

Full dependency list (exact installed versions from package-lock.json):

| Package | Installed | package.json range |
|---|---|---|
| @supabase/supabase-js | 2.110.7 | ^2.45.4 |
| @turf/turf | 7.3.5 | ^7.1.0 |
| dexie | 4.4.4 | ^4.0.8 |
| dexie-react-hooks | 1.1.7 | ^1.1.7 |
| mapbox-gl | 3.26.0 | ^3.7.0 |
| react / react-dom | 18.3.1 | ^18.3.1 |
| react-router-dom | 6.30.4 | ^6.26.2 |
| @types/geojson (dev) | 7946.0.16 | ^7946.0.14 |
| @types/mapbox-gl (dev) | 3.4.1 | ^3.4.0 |
| @types/node (dev) | 26.1.1 | ^26.1.1 |
| @types/react (dev) | 18.3.31 | ^18.3.5 |
| @types/react-dom (dev) | 18.3.7 | ^18.3.0 |
| @vitejs/plugin-react (dev) | 4.7.0 | ^4.3.1 |
| typescript (dev) | 5.9.3 | ^5.5.3 |
| vite (dev) | 5.4.21 | ^5.4.3 |
| vite-plugin-pwa (dev) | 0.20.5 | ^0.20.5 |

Dev machine: Windows 11, Node v24.18.0, project path contains an apostrophe (`C:\Users\Colin's
PC\...`) — this breaks local production builds (see §7). CI builds on Ubuntu with Node 22.

Environment variables (Vite, build-time): `VITE_MAPBOX_TOKEN` (required — map components render an
error div without it), `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (**currently empty in
`.env.local`; the Supabase client is therefore `null` at runtime**), `VITE_BASE` (set to
`/golf-app/` by the deploy workflow only).

## 2. Repo tree (depth 3, excluding node_modules / dist)

```
golf-app/
├── .agents/                    # Historical multi-agent workflow docs (Antigravity planner +
│   ├── AGENTS.md               #   Claude executor protocol). Stale; not load-bearing.
│   ├── implementation_plan.md
│   ├── task.md
│   └── walkthrough.md
├── .claude/settings.local.json # Claude Code local permissions. Not app code.
├── .github/workflows/
│   └── deploy.yml              # THE deploy pipeline: push to main -> vite build -> GitHub Pages.
├── data/imports/               # Raw Overpass Turbo GeoJSON exports — audit-trail source of truth.
│   ├── innerkip-highlands.geojson   (~496 KB)
│   └── tarandowah.geojson           (~492 KB)
├── docs/
│   └── osm-editing-guide.md    # How to tag golf features in OSM so the importer reads them;
│                               #   lists known data gaps (Tarandowah holes 12/13 have no centerline).
├── public/
│   ├── courses/                # COPIES of data/imports, shipped as static assets and precached
│   │   ├── innerkip-highlands.geojson   by the service worker; seeded into Dexie on app load.
│   │   └── tarandowah.geojson
│   └── icons/                  # PWA icons (192, 512, 512-maskable).
├── src/
│   ├── App.tsx                 # Routes + fire-and-forget course seeding + fixed "1.0" version badge.
│   ├── main.tsx                # StrictMode + BrowserRouter entry.
│   ├── index.css               # ~66 lines global CSS. Everything else is inline style objects.
│   ├── components/
│   │   ├── CourseMap.tsx       # THE live-round map (974 lines). GPS blue dot, target line, measure
│   │   │                       #   dots, dispersion ellipse, bunker/water warnings. Biggest file.
│   │   ├── ReviewMap.tsx       # Separate, simpler map for post-round shot-path review.
│   │   ├── RoundSheets.tsx     # Bottom sheets: ShotSheet, HoleScoreSheet, ScorecardSheet.
│   │   └── PageHeader.tsx      # Trivial title header.
│   ├── lib/
│   │   ├── db.ts               # Dexie schema — the real data model (see §3).
│   │   ├── courseRepo.ts       # All course-side Dexie writes (+outbox queueing).
│   │   ├── roundRepo.ts        # All round/shot Dexie writes (+outbox queueing).
│   │   ├── importOverpass.ts   # Pure OSM-GeoJSON -> ParsedCourse parser (all import heuristics).
│   │   ├── seedCourses.ts      # Bundled-course auto-seeding + destructive re-seed migrations.
│   │   ├── geo.ts              # Haversine/bearing/ENU/downrange-offline/dispersion-ellipse math.
│   │   ├── lie.ts              # Point-in-polygon lie detection.
│   │   ├── fairway.ts          # Tee-shot fairway hit/left/right/short/long classifier.
│   │   ├── dispersion.ts       # Manual + actual (shot-history) dispersion ellipse resolution.
│   │   ├── settings.ts         # localStorage GPS-enabled preference.
│   │   └── supabase.ts         # 8 lines. Creates a client nobody uses. Currently null.
│   ├── pages/
│   │   ├── Home.tsx            # 2x3 tile menu.
│   │   ├── CoursesPage.tsx     # Course list/search -> /round/:courseId.
│   │   ├── RoundMapPage.tsx    # THE in-round screen (994 lines): HUD, sheets, shot recording.
│   │   ├── ReviewRoundsPage.tsx# Completed-round list -> hole stepper -> ReviewMap + aim points.
│   │   ├── CourseEditorPage.tsx# In-app fixer for bad OSM data (1002 lines): move tees/greens,
│   │   │                       #   waypoints, draw hazards. Own standalone Mapbox map.
│   │   ├── DataImportsPage.tsx # Manual Overpass GeoJSON upload flow.
│   │   └── SettingsPage.tsx    # GPS toggle + per-club dispersion table.
│   └── types/domain.ts         # All entity types (the de-facto schema, see §3).
├── DESIGN.md                   # 900+ lines. Part real documentation, part aspiration. Sections on
│                               #   Supabase/sync/SG describe things that DO NOT EXIST. Read
│                               #   critically — it is the best map of intent and of landmines.
├── README.md                   # Run instructions, phone-testing setup, deploy notes.
├── index.html                  # Single entry; viewport locked (no zoom), dark theme color.
├── vite.config.ts              # PWA manifest, workbox precache + Mapbox runtime caching, VITE_BASE.
└── tsconfig*.json              # strict, ES2022, bundler resolution, noEmit.
```

## 3. The complete data model

**There is no server database.** The only real schema is the Dexie (IndexedDB) one below.
DESIGN.md contains a full Postgres/PostGIS DDL for Supabase — reproduced at the end of this
section — but it was never applied anywhere and no code reads or writes Supabase. Treat the SQL as
a design sketch, not a deployed schema. The two have already drifted (fields added client-side
that the SQL lacks: `Hole.notes/greenPoint/waypoints`, `Club.manual*/useActualDispersion`,
`Course.isFeatured/lastSelectedAt`, `RoundHole.fairwayResult`; the SQL's `user_id` columns have no
client counterpart at all).

### 3a. Dexie schema (actual, from `src/lib/db.ts`)

```ts
// Dexie stores declaration — the strings are "primaryKey, index, index..." (only indexed fields
// are listed; rows carry the full TypeScript shapes below).
db.version(1).stores({
  courses:           "id, updatedAt, deletedAt",
  courseVersions:    "id, courseId, versionNumber",
  holes:             "id, courseVersionId, number",
  teeBoxes:          "id, holeId",
  holeFeatures:      "id, holeId, featureType",
  clubs:             "id, sortOrder",
  rounds:            "id, courseVersionId, playedOn, status",
  roundHoles:        "id, roundId, holeId",
  shots:             "id, roundHoleId, shotNumber, clubId",
  sgBaselineScratch: "[lie+distanceYards], lie",
  outbox:            "id, createdAt"
});
// v2: added "name" index on courses (querying non-indexed fields throws in Dexie; course
// save/seed was silently broken until this migration).
db.version(2).stores({ courses: "id, name, updatedAt, deletedAt" });
```

### 3b. Row shapes (actual, from `src/types/domain.ts` — this IS the model)

```ts
export type LatLng = { lat: number; lng: number };

export type FeatureType =
  | "fairway" | "green" | "fringe" | "bunker_greenside" | "bunker_fairway"
  | "hazard" | "ob" | "rough" | "tee";

export interface Course {
  id: string;                       // client-generated crypto.randomUUID() everywhere
  name: string;                     // unique-by-convention; dedupe key on import/seed
  location: LatLng | null;
  updatedAt: string;                // ISO strings, not Dates
  deletedAt: string | null;         // soft delete (honored by listCourses filter only)
  isFeatured?: boolean;             // bundled-course badge on CoursesPage
  lastSelectedAt?: string | null;   // recency sort on CoursesPage
}

export interface CourseVersion {
  id: string;
  courseId: string;
  versionNumber: number;            // re-import same name => new version (copy-on-write... mostly, see §9)
  effectiveFrom: string;
  source: "overpass_import" | "manual_edit";
  updatedAt: string;
}

export interface Hole {
  id: string;
  courseVersionId: string;
  number: number;                   // 1..18
  par: number;                      // defaults to 4 when OSM lacks a par tag
  defaultYardage: number | null;    // length of the OSM centerline, not scorecard yardage
  notes?: string | null;            // per-hole free text, persists across rounds
  greenPoint?: LatLng | null;       // course-editor override for green center / camera target
  waypoints?: LatLng[] | null;      // course-editor saved layup dots, seeded onto the round map
  updatedAt: string;
}

export interface TeeBox {
  id: string;
  holeId: string;
  name: string;                     // "Blue", "White", "Blue / White", "Tee", "Tee (approx.)"
  location: LatLng;                 // NOTE: no updatedAt — sync-unfriendly, see §9
}

export interface HoleFeature {                  // one polygon per row
  id: string;
  holeId: string;
  featureType: FeatureType;
  geometry: GeoJSON.Polygon;                    // ALWAYS Polygon; points/lines get buffered first
  zOrder: number;                               // lie-detection precedence (fringe 4 > green 3 > ... > rough 0, ob 5)
}

export interface Club {
  id: string;
  name: string;                     // "Driver", "7 Iron", "50°", "Putter" (name-matched in code! see §9)
  sortOrder: number;
  manualFrontBackYards?: number | null;   // total spread; halved into ellipse semi-axes
  manualLeftRightYards?: number | null;
  useActualDispersion?: boolean;          // prefer ellipse fitted from recorded shots
  updatedAt: string;
}

// ============ SHOT TRACKING TABLES (rounds, roundHoles, shots + clubs feeding them) ============

export interface Round {                        // SHOT TRACKING
  id: string;
  courseVersionId: string;          // pins the round to geometry-as-imported (in theory, §9)
  playedOn: string;                 // "YYYY-MM-DD"
  status: "in_progress" | "completed";
  updatedAt: string;
}

export type FairwayResult = "hit" | "left" | "right" | "short" | "long";

export interface RoundHole {                    // SHOT TRACKING — one row per hole per round, lazily created
  id: string;
  roundId: string;
  holeId: string;
  score: number | null;
  putts: number | null;
  puttDistancesFeet: (number | null)[] | null;  // collected in UI; consumed by NOTHING yet
  pinLocation: LatLng | null;       // per-round custom pin (drag/tap); null = green centroid
  fairwayResult?: FairwayResult | null;         // auto-classified at shot 2, overridable at hole-out
  updatedAt: string;
}

export type Lie =
  | "tee" | "fairway" | "rough" | "bunker_greenside" | "bunker_fairway"
  | "hazard" | "ob" | "green" | "fringe" | "recovery";

export interface Shot {                         // SHOT TRACKING — the core row
  id: string;
  roundHoleId: string;
  shotNumber: number;               // 1-based, derived from count at insert
  clubId: string | null;
  startPoint: LatLng;               // GPS fix when "Shot N" was tapped (or tee-box fallback)
  endPoint: LatLng | null;          // closed out by the NEXT shot's start, or green centroid at hole-out
  lieStart: Lie | null;             // auto-detected point-in-polygon, user-overridable
  lieEnd: Lie | null;
  aimPointOverride: LatLng | null;  // set in post-round review; feeds "actual dispersion"
  recordedAt: string;
  updatedAt: string;
}

export interface SgBaselineScratch {            // strokes-gained baseline: TABLE EXISTS, NEVER SEEDED,
  lie: Lie;                                     // NEVER READ. The whole SG engine is unbuilt.
  distanceYards: number;
  expectedStrokes: number;
}

export interface OutboxEntry {                  // sync queue for a sync worker that DOES NOT EXIST.
  id: string;                                   // Every repo write appends here; nothing ever drains
  table: string;                                // it. It grows forever. See §6/§7.
  op: "upsert" | "delete";
  payload: unknown;
  createdAt: string;
}
```

### 3c. The aspirational Supabase DDL (from DESIGN.md §2 — NOT deployed, NOT used)

```sql
create table courses (
  id uuid primary key,
  user_id uuid not null references auth.users,
  name text not null,
  location geography(point, 4326),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table course_versions (
  id uuid primary key,
  course_id uuid not null references courses,
  version_number int not null,
  effective_from timestamptz not null default now(),
  source text not null check (source in ('overpass_import', 'manual_edit')),
  updated_at timestamptz not null default now()
);
create table holes (
  id uuid primary key,
  course_version_id uuid not null references course_versions,
  number int not null check (number between 1 and 18),
  par int not null,
  default_yardage int,
  updated_at timestamptz not null default now()
);
create table tee_boxes (
  id uuid primary key,
  hole_id uuid not null references holes,
  name text not null,
  location geography(point, 4326) not null
);
create table hole_features (
  id uuid primary key,
  hole_id uuid not null references holes,
  feature_type text not null check (feature_type in
    ('fairway','green','fringe','bunker_greenside','bunker_fairway','hazard','ob','rough')),
  geometry geography(polygon, 4326) not null,
  z_order int not null default 0
);
create table clubs (
  id uuid primary key,
  user_id uuid not null references auth.users,
  name text not null,
  sort_order int not null,
  updated_at timestamptz not null default now()
);
create table rounds (          -- SHOT TRACKING
  id uuid primary key,
  user_id uuid not null references auth.users,
  course_version_id uuid not null references course_versions,
  played_on date not null,
  status text not null check (status in ('in_progress','completed')),
  updated_at timestamptz not null default now()
);
create table round_holes (     -- SHOT TRACKING
  id uuid primary key,
  round_id uuid not null references rounds,
  hole_id uuid not null references holes,
  score int, putts int,
  putt_distances_feet numeric[],
  pin_location geography(point, 4326),
  updated_at timestamptz not null default now()
);
create table shots (           -- SHOT TRACKING
  id uuid primary key,
  round_hole_id uuid not null references round_holes,
  shot_number int not null,
  club_id uuid references clubs,
  start_point geography(point, 4326) not null,
  end_point geography(point, 4326),
  lie_start text, lie_end text,
  aim_point_override geography(point, 4326),
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table sg_baseline_scratch (
  lie text not null,
  distance_yards int not null,
  expected_strokes numeric not null,
  primary key (lie, distance_yards)
);
```

## 4. Course geometry: storage, loading, rendering

**Source format:** raw Overpass Turbo GeoJSON exports of OpenStreetMap data (standard OSM golf
tagging: `golf=hole` centerlines with `ref`/`par`, `golf=fairway|green|tee|bunker|water_hazard`
polygons, `teebox=<color>` names). Two courses are bundled at `public/courses/*.geojson`
(~500 KB each) and precached by the service worker; ad-hoc imports go through
`DataImportsPage` file upload. `docs/osm-editing-guide.md` documents the tagging contract.

**Import pipeline** (`importOverpass.ts` → `courseRepo.saveImportedCourse`), all heuristic:
1. Course name/boundary from `leisure=golf_course` (fallback `landuse=grass`).
2. One `Hole` per `ref` 1..max; missing centerlines become par-4 placeholders. Yardage = turf
   length of the centerline (not real scorecard yardage). Backward-digitized centerlines are
   auto-reversed by checking which end is nearer the closest green.
3. Every polygon is assigned to a hole by **nearest-centerline distance** (greens/tees use a
   smarter "correct half of the line" match; everything else is plain nearest). Wrong-hole
   assignment is a known failure mode, warned but not blocked.
4. Bunkers split greenside/fairway by ≤30y-from-green heuristic. Non-golf-tagged water
   (`natural=water`, `waterway=*`, names matching creek/stream/drain) becomes `hazard`;
   LineString streams are turf-buffered 3y into thin polygons because **the model is
   polygon-only** (DB shape + all proximity math assume polygons).
5. Tee polygons produce both a `HoleFeature` and a centroid `TeeBox`; holes with no tee polygon
   get one synthesized from the centerline's first coordinate ("Tee (approx.)").
6. The centerline itself is **discarded after import** — only derived values survive. At
   round-time the straight tee→green line stands in for the centerline everywhere.

**Storage:** one Dexie `holeFeatures` row per polygon, `geometry` as a plain GeoJSON Polygon in
WGS84 lon/lat. No tiling, no simplification, no spatial index — every read is "all features for
hole X" (tens of rows, fine at this scale).

**Rendering:** Mapbox GL JS, style `mapbox://styles/mapbox/satellite-streets-v12` (toggle to
`outdoors-v12`). Projection is whatever Mapbox does (Web Mercator); all app-side math uses
haversine + a hand-rolled equirectangular local-meters approximation in `geo.ts` (fine under
~1 km). **Course polygons are deliberately NEVER drawn.** The user sees raw satellite imagery
only; polygons exist solely as invisible geometry for (a) lie auto-detection
(`turf.booleanPointInPolygon`, z-order descending, no-hit ⇒ rough), (b) an invisible
`fill-opacity: 0` bunker layer that is still hit-testable via `queryRenderedFeatures` for
tap-for-front/mid/back-yardage cards, (c) water-proximity warnings (closest point on any hazard
boundary to the current origin), (d) fairway-hit classification, and (e) the auto-layup-dot
placement. Camera convention everywhere: tee at bottom, green at top, bearing = tee→green,
pitch 55°, framed with `fitBounds` + asymmetric padding.

There are **three separate Mapbox map components** with duplicated marker/drag code:
`CourseMap` (live round), `ReviewMap` (post-round), and a third map inside `CourseEditorPage`.
Each reimplements its own markers, drag handling (including a copy-pasted
`applyTouchDragOffset`), and camera logic. This was a deliberate "don't destabilize the main
path" choice, but it is triple-maintenance and a prime consolidation target for the revision.

## 5. Manual shot tracking, end to end

There is no automatic shot detection. Shots are recorded by tapping a button while standing at
the ball. The chain:

1. **GPS capture** — `CourseMap.tsx` runs `navigator.geolocation.watchPosition`
   (`enableHighAccuracy: true`) and calls the `onPositionChange` prop on every fix.
   `RoundMapPage.tsx` stores the latest fix in `lastPositionRef` (a ref, not state — no re-render
   per tick). That ref is the **only** live position the recording flow ever reads.
2. **Start round** — bottom bar "⛳ Start round" → `roundRepo.startRound(courseVersionId)` inserts
   a `Round` (`status: "in_progress"`). Re-opening `/round/:courseId` later resumes it via
   `getActiveRoundForCourse` (there is no abandon/discard-round UI at all).
3. **Per-hole row** — on hole change, `getOrCreateRoundHole(roundId, holeId)` lazily inserts the
   `RoundHole`.
4. **Record a shot** — "🏌️ Shot N" opens `ShotSheet` (`RoundSheets.tsx`). Lie is pre-detected via
   `detectLie(lastPositionRef.current, holeFeatures)`; shot 1 skips the lie step (always "tee");
   detecting/tapping "Green" instant-saves with the Putter (the club is found **by name match**
   `c.name === "Putter"`). Otherwise: tap lie tile → tap club tile → saved.
5. **Write** — `RoundMapPage.handleSaveShot` → `roundRepo.recordShot`. Position = current GPS fix,
   **falling back to the tee-box coordinate if GPS has no lock yet** (a silent accuracy hole).
   In one Dexie transaction: the previous shot's `endPoint`/`lieEnd` are closed out with this
   point (you play from where the last one finished), then the new `Shot` row is inserted with
   `endPoint: null`. Both writes are mirrored into `outbox` (which nothing consumes).
6. **Fairway auto-classify** — the moment shot 2 saves on a par-4+, `classifyFairwayResult`
   (point-in-fairway-polygon, else short/long/left/right in the tee→green downrange/offline
   frame) writes `RoundHole.fairwayResult`; the hole-out sheet pre-selects it, overridable.
7. **Hole out** — "🏁 Hole Out" opens `HoleScoreSheet`: fairway tiles, putts stepper with
   optional per-putt distances, score (auto = recorded shots + putts until touched).
   `saveHoleResult` writes the RoundHole and closes the final shot's `endPoint` to the **green
   centroid** — not the per-round `pinLocation` even when one was set (known inconsistency).
   Auto-advances to the next hole; holing out the last hole calls `completeRound`.
8. **State management** — no Redux/Zustand/context. Plain `useState`/`useRef` in `RoundMapPage`
   plus Dexie `useLiveQuery` subscriptions for anything persisted. `CourseMap` is deliberately
   remounted per hole (`key={currentHole.id}`) instead of diffing layers. A large fraction of
   the code's comment volume exists to fight two recurring hazards: Dexie live queries briefly
   returning the *previous* hole's rows after a hole switch (guarded by explicit
   `row.holeId === currentHole.id` checks before mounting the map), and StrictMode double-mount
   orphaning imperative Mapbox markers held in refs (guarded by resetting every ref in the map
   cleanup). Any revision that keeps Dexie + remount-per-hole inherits both hazards.
9. **Review / aim points** — `ReviewRoundsPage` lists completed rounds → per-hole `ReviewMap`
   shows numbered shot-start markers + path line. "🎯 Set Aim Target" arms a map tap that writes
   `Shot.aimPointOverride`. Those aim points are the input for "actual dispersion": ellipse
   fitted (mean + covariance eigendecomposition, 90% chi-square scaling) over each shot's end
   point projected into its own start→aim frame. Shots without aim points are excluded from
   dispersion entirely.

What the recorded data feeds today: the scorecard, fairway stats field, the review path, and the
dispersion ellipse. **Nothing else.** No stats screen, no strokes-gained, no aggregates, no
per-club distance averages. Putt distances are collected and never read.

## 6. Backend and API surface

**There is no backend. Zero. This is the single most important fact for the revision.**

- `src/lib/supabase.ts` builds a Supabase client only if `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` are set; **they are empty in `.env.local` and absent from CI**, so
  `supabase` is `null` in every environment that has ever run. No file imports it besides its own
  definition — grep confirms nothing calls it even when non-null.
- No REST/RPC endpoints, no auth of any kind, no user identity (the DDL's `user_id` has no client
  counterpart), no server functions.
- The entire "local-first with sync worker draining the outbox" architecture in DESIGN.md §1/§3
  is **unimplemented**. `lib/sync.ts` is referenced in a comment and does not exist. Every write
  dutifully appends to `outbox`, which is never read, never pruned, and grows monotonically
  forever in IndexedDB.
- Practical consequence: **all golf data lives in one Chrome profile's IndexedDB on one phone.**
  Clearing site data, browser eviction under storage pressure, or losing the phone destroys every
  round ever recorded. There is no export, no backup, no import-from-backup.
- **Hosting** (static only): GitHub Pages via `.github/workflows/deploy.yml` — push to `main` →
  `npm ci` → `vite build` (with `VITE_BASE=/golf-app/`, `VITE_MAPBOX_TOKEN` from repo secret) →
  copy `index.html` to `404.html` (SPA fallback) → deploy. Third-party services actually used at
  runtime: Mapbox APIs (tiles/styles/fonts, public `pk.` token baked into the public bundle) and
  browser Geolocation. That's it.

## 7. Working / stubbed / broken

**Fully working (verified in real use, per DESIGN.md's verification notes):**
- Course seeding from bundled GeoJSON; Overpass import pipeline with its heuristics and warnings.
- Live round map: GPS blue dot, tee/target markers with drag (+50px touch offset), segmented
  measure line with per-leg yardage labels (max 5 dots), auto-layup dot, saved waypoints seeding,
  front/center/back HUD, water proximity warning, invisible-bunker tap cards, dispersion ellipse
  (manual + actual), satellite/outdoors toggle, per-hole notes with debounced save, tee-set
  selector with backmost-tee default, nearest-tee auto hole select on load.
- Shot recording flow (§5), scorecard, fairway auto-detect, instant green-putter save,
  round completion.
- Post-round review with aim-point setting; review scorecard.
- Course editor: move/create tee boxes, green override point, waypoints, hand-drawn point/line/area
  hazards (buffered to polygons), hazard delete.
- PWA install + offline precache of app shell and course GeoJSON on the deployed site.

**Stubbed / non-existent (some of it looks designed — don't be fooled by DESIGN.md):**
- Supabase sync/backup: dead config + an outbox to nowhere (§6).
- Strokes gained: `sgBaselineScratch` table empty and unread; no baseline dataset was ever
  sourced (DataGolf's numbers are proprietary; Broadie's tables were the plan).
- Stats/aggregation of any kind. No screen shows historical data beyond scorecard + shot paths.
- Trackman range-session import: deliberately deferred; no table, no code.
- Settings page mostly a stub (its own copy says "Not built yet: units, default aim-point rule,
  SG baseline default, Supabase sync status").
- Handicap/stroke-index: importer guide mentions `handicap` tag; nothing stores or uses it.
- Home has one intentionally blank tile.

**Known-broken / landmines:**
- **`npm run build` fails on the dev machine** — workbox's generated service worker embeds the
  absolute project path in a single-quoted JS string, and the apostrophe in `Colin's PC` breaks
  it. Local workflow is dev-server-only; production builds happen exclusively in CI. Same bug
  forces `devOptions.enabled: false`, so the service worker / Add-to-Home-Screen can only ever be
  tested against the deployed site.
- **Reseed migrations orphan historical rounds.** `seedCourses.ts` wipes and re-imports bundled
  courses on (a) zero tee boxes or (b) a bumped `caddyshot_reseeded_v3` localStorage key.
  `wipeCourse` deletes the course, its versions, holes, and features — but **not** rounds,
  roundHoles, or shots, whose `courseVersionId`/`holeId` foreign keys now dangle (new import =
  new UUIDs). Any round recorded before a reseed bump loses its course/hole/par joins in review.
  With no referential integrity in IndexedDB, nothing errors — data just silently stops joining.
  This has already happened at least through v3 bumps.
- **Course "versioning" is half a lie.** Re-imports create new `CourseVersion` rows (append-only,
  good), but every course-editor write (tee move, green point, waypoints, notes, custom hazards)
  mutates the current version's rows in place — no `manual_edit` version is ever created despite
  the enum value existing. DESIGN.md §7's promise that old rounds' lie detection never changes
  retroactively is false the moment the editor is used. Also, only the **latest** version is ever
  loaded (`getLatestCourseVersion`) — review pages join `round.courseVersionId` directly, so
  rounds played on older versions still resolve, but nothing ever displays old geometry.
- **Uncommitted work in the tree right now** (2 modified files, functional, not yet committed):
  `vite.config.ts` gained Mapbox tile/style runtime caching (CacheFirst with sku/access_token
  stripped from cache keys); `CourseMap.tsx` gained auto-clearing of measure dots within 200y of
  the target **and a debug leak: `window.__debugMap = map` is set in the map-init effect** — a
  verification hook that a previous session's notes say was supposed to be removed before
  shipping.
- OSM data gaps: Tarandowah holes 12/13 have no centerline in OSM — placeholders with wrong par-4
  defaults and editor-created tees/greens; their real fairway/green polygons are mis-assigned to
  holes 11/14. Innerkip is clean.
- `Hole.defaultYardage` is the OSM centerline length, not scorecard yardage — close but not
  authoritative, and par defaults to 4 wherever OSM lacks a tag.
- No tests of any kind, no lint, no type-check gate (see §1/§8). Every regression to date was
  caught by manually playing/driving the app; DESIGN.md records several bugs that type-checking
  and smoke tests structurally could not catch (e.g. querying a non-indexed Dexie field).

## 8. Build, run, test

```bash
npm install
npm run dev        # Vite dev server on http://localhost:5173, --host (LAN-exposed)
```

- `npm run build` — production build. **Broken locally** (apostrophe-in-path, §7); works in CI.
- `npm run preview` — vite preview of a build (moot locally).
- **Type check (manual, not wired into anything):** `npx tsc -b`
- **Tests: none exist. There is no test command.**
- Deploy: push to `main` → GitHub Actions → GitHub Pages at `https://<user>.github.io/golf-app/`.
  Mapbox token comes from the `VITE_MAPBOX_TOKEN` repo secret (`gh secret set VITE_MAPBOX_TOKEN`).
- Phone testing over LAN: `npm run dev`, open `http://<dev-machine-ip>:5173` on the phone (same
  wifi). One-time setup: Windows Firewall rule for TCP 5173, and Chrome's "Insecure origins
  treated as secure" flag for the LAN origin (GPS is blocked on plain HTTP otherwise).
- Local env: copy `.env.example` → `.env.local`, set `VITE_MAPBOX_TOKEN` (public `pk.` token).

## 9. What a newcomer gets wrong (conventions, debt, load-bearing hacks)

1. **DESIGN.md is half documentation, half fiction.** It is genuinely the best source for *why*
   the code is shaped the way it is (its gotcha write-ups are accurate and hard-won), but its
   Supabase/sync/SG/RLS sections describe a system that was never built. Cross-check any claim
   against the code before designing on top of it.
2. **The outbox pattern is write-only theater.** Keep writing through the repo functions if you
   extend the current code (consistency), but know that every `queueOutbox` call is currently
   pure overhead, the payload snapshots use the client field names (camelCase, `LatLng` objects)
   which do NOT match the aspirational SQL (snake_case, PostGIS geography), and `wipeCourse`
   bypasses the outbox entirely. A real sync implementation cannot trust what's queued.
3. **IDs are client-generated UUIDs; names are the real keys in several places.** Courses dedupe
   by `name`. The Putter is found by `name === "Putter"`. Default-club migration detects legacy
   installs by name list (`LEGACY_ONLY_CLUB_NAMES`) and **clears and reseeds the clubs table**,
   orphaning `Shot.clubId` references from before the reseed (another silent dangling-FK case).
   Renaming a club in a future editor would break the instant-putter flow.
4. **Load-bearing hack: stale-live-query guards.** Every derived value that feeds `CourseMap`'s
   mount (`greenCentroid`, `fallbackOrigin`, `fairwayLayupPoint`) checks
   `rows.every(r => r.holeId === currentHole.id)` because dexie-react-hooks re-emits the previous
   query's rows for a few renders after the key changes. Removing these "redundant" checks locks
   the camera onto the wrong hole permanently (the map reads its props once, at mount). Same
   class of guard: `pinDataReady`, `resolvedRoundHole` seeding, and ReviewMap's separate
   camera-placement effect.
5. **Load-bearing hack: StrictMode ref resets.** The map-init cleanup nulls every marker ref and
   one-shot guard ref (`autoLayupPlacedRef`, `waypointsSeededRef`, `clearedNearTargetRef`).
   StrictMode double-mounts in dev; forget a reset and a feature silently never renders (this bug
   class shipped multiple times). Any new imperative-marker effect must follow the same pattern.
6. **`applyTouchDragOffset` moves the real coordinate, not the pixels.** Dragged markers'
   geographic positions sit 50px above the finger by design — drop points are intentionally
   offset from the raw touch. Do not "fix" this, and do not add a CSS transform on top (it
   doubles the offset; that bug also shipped once). The function is duplicated in
   `CourseEditorPage.tsx`.
7. **Polygons are invisible on purpose.** Satellite-imagery-only is an explicit user preference.
   Do not render course features on the round map in a redesign without asking.
8. **Everything is inline `React.CSSProperties` objects** at the bottom of each file; `index.css`
   is ~66 lines of global resets (including global `user-select: none` — required so map
   double-taps don't trigger text selection). No design system, no CSS modules, heavy copy-paste
   of the same dark-green palette (#0b0f0c / #1a3a24 / #2f5c3d / #f5d90a accents). A restyle
   touches every file.
9. **Single-user assumptions are everywhere**, not just the hardcoded name: no user_id on any
   row, localStorage for preferences (`caddyshot_gps_enabled`, `caddyshot_tee_preference`,
   `caddyshot_reseeded_v3`), last-write-wins-by-design, and migration flags in localStorage that
   are invisible to any other device.
10. **Yardage units are baked in** (yards for golf distances, feet for putts, meters internally in
    geo math). There is no units setting.
11. **The three-map-components split** (CourseMap / ReviewMap / editor map) was a deliberate
    isolation choice, and CourseMap is the most battle-tested code in the app. If the revision
    unifies them, expect to re-fight every gotcha in DESIGN.md §8/§10/§11 — budget for it.
12. **GPS fallback silently degrades shot data**: with no GPS lock, shots record at the tee-box
    coordinate with no flag distinguishing them from real fixes. Any future analytics must expect
    polluted `startPoint`s. Similarly, hole-out endPoints are green centroids, not pins (§5.7).
13. **The version badge is a hand-edited string** ("1.0" in `App.tsx`), not derived from
    package.json (which says 0.0.1) or git. There is no versioning discipline to inherit.
14. **`.agents/` is residue from a past multi-agent workflow** (planner/executor protocol). Its
    checklists and plan predate large chunks of the current code. Do not treat as current intent.
15. **`defaultYardage`, par, and hole numbering all inherit OSM quality.** Garbage in OSM =
    garbage in-app, with only heuristics and the in-app editor between them. The re-seed
    machinery (see §7's orphaning landmine) exists precisely because parser fixes keep needing
    to force re-imports — any schema revision should replace that mechanism with something that
    doesn't sever round history.
