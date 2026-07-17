# Golf App — Technical Design

Personal-use golf yardage book, round tracker, and stats app. No social features.
Stack: React + Vite PWA · Mapbox GL JS · Supabase (Postgres + Auth) · Dexie.js (IndexedDB) local-first storage.
Primary target device: Pixel 9 Pro (Chrome on Android) — installed as a standalone PWA.

## 1. Data Architecture

Local-first: every write lands in IndexedDB immediately and the UI reads only from there. A sync
worker pushes/pulls against Supabase opportunistically when online. Single user, so conflict
resolution is last-write-wins by `updated_at` — no multi-writer merge logic needed.

```
UI  →  Dexie (IndexedDB)  →  outbox table  →  sync worker  →  Supabase (Postgres)
                ↑__________________________________________________|
                         pull-down on reconnect / app start
```

Every syncable table gets: `id (uuid, client-generated)`, `updated_at`, `deleted_at` (soft delete,
so deletions replicate instead of just disappearing locally), and a `dirty` flag used only on the
client side (not persisted to Supabase).

## 2. Supabase Schema

```sql
-- single-user app, but keep user_id + RLS anyway: cheap insurance if you ever add a second device/account
create table courses (
  id uuid primary key,
  user_id uuid not null references auth.users,
  name text not null,
  location geography(point, 4326),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- copy-on-write: editing a course's geometry creates a new version rather than mutating in place
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
  name text not null,        -- "Black", "Blue", "White", etc.
  location geography(point, 4326) not null
);

-- fairway / green / bunker / hazard / OB / fringe / rough polygons, one row per feature
create table hole_features (
  id uuid primary key,
  hole_id uuid not null references holes,
  feature_type text not null check (feature_type in
    ('fairway','green','fringe','bunker_greenside','bunker_fairway','hazard','ob','rough')),
  geometry geography(polygon, 4326) not null,
  z_order int not null default 0   -- resolves overlaps, e.g. fringe (higher) drawn/tested before green (lower)
);

create table clubs (
  id uuid primary key,
  user_id uuid not null references auth.users,
  name text not null,          -- "7 Iron", "Driver", etc.
  sort_order int not null,
  updated_at timestamptz not null default now()
);

create table rounds (
  id uuid primary key,
  user_id uuid not null references auth.users,
  course_version_id uuid not null references course_versions,
  played_on date not null,
  status text not null check (status in ('in_progress','completed')),
  updated_at timestamptz not null default now()
);

create table round_holes (
  id uuid primary key,
  round_id uuid not null references rounds,
  hole_id uuid not null references holes,
  score int,
  putts int,
  putt_distances_feet numeric[],        -- one entry per putt (null entry = not recorded); first putt feeds SG-putting
  pin_location geography(point, 4326),  -- null = assume green-center for this hole/round
  updated_at timestamptz not null default now()
);

create table shots (
  id uuid primary key,
  round_hole_id uuid not null references round_holes,
  shot_number int not null,
  club_id uuid references clubs,
  start_point geography(point, 4326) not null,
  end_point geography(point, 4326),         -- null until the next shot's start is recorded
  lie_start text,                            -- auto-detected from hole_features, override allowed
  lie_end text,
  aim_point_override geography(point, 4326), -- null = use the default aim-point rule
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Trackman import deferred out of v1 (no export sample available yet) — table intentionally omitted
-- for now. Re-add with the same shape as `shots` (club_id, carry/total/offline in the downrange/
-- offline frame from section 4) once a real export is in hand; dispersion queries just need to union
-- it in alongside on-course shots.

-- seeded once from a published scratch-golfer expected-strokes table (e.g. Broadie-style), not user-editable
create table sg_baseline_scratch (
  lie text not null,
  distance_yards int not null,   -- bucketed, e.g. every 10y; interpolate between buckets at query time
  expected_strokes numeric not null,
  primary key (lie, distance_yards)
);
```

RLS: every table with `user_id` (or joinable to one) gets `using (auth.uid() = user_id)`. Single
Supabase Auth user (email/password or magic link) — no invite/multi-user flow needed.

## 3. IndexedDB (Dexie) Mirror

Same tables, denormalized slightly for read speed (e.g. `hole_features` fetched and cached per
`course_version_id` as a bundle, since they're read together constantly during a round). Add an
`outbox` table:

```
outbox: { id, table, op: 'upsert'|'delete', payload, created_at }
```

Sync worker drains `outbox` in order on reconnect (`navigator.onLine` + periodic retry — Background
Sync API where supported, polling fallback otherwise since iOS Safari support is inconsistent).

## 4. Coordinate Math

**Distance/bearing** between two lat/lng points: haversine for distance, standard forward-azimuth
formula for bearing. Accurate enough at golf-hole scale (errors are sub-centimeter over a few
hundred meters).

**Local ENU projection** (for dispersion + measuring-dot math): pick an origin (aim point), convert
nearby lat/lng to flat-plane meters via equirectangular approximation:

```
x_east  = (lng - lng0) * cos(lat0) * 111320
y_north = (lat - lat0) * 110540
```

Flat-earth error is negligible under ~1km, well within any golf shot. From there, rotate into the
shot's own frame — project onto the tee→pin bearing to get **distance-downrange**, and onto the
perpendicular to get **offline** (signed, +right/-left) — same frame Trackman already reports in,
so on-course and Trackman shots become directly comparable.

**Dispersion ellipse** per club: given a set of (downrange, offline) points,
1. Compute mean and 2×2 covariance matrix.
2. Eigendecompose the covariance matrix → ellipse axes/orientation.
3. Scale axes by the chi-square critical value for the desired confidence level (2D Gaussian) —
   show both a 50% and 90% contour, which is the convention most shot-dispersion tools use.

Trackman shots (deferred, see section 2) would plug into the same (downrange, offline) frame
directly from their reported carry/offline columns — no lat/lng projection needed for those. v1
dispersion is in-app-shot-only.

## 5. Lie Detection

Point-in-polygon test (`turf.booleanPointInPolygon`) against the current hole's `hole_features`,
ordered by `z_order` descending so more specific features (e.g. `fringe`) win over broader ones
(e.g. `green`) when polygons overlap. No match → default to `rough`. Runs on every shot's
`start_point`/`end_point`; always editable manually after the fact.

## 6. Strokes Gained

```
SG(shot) = expected_strokes(lie_start, distance_to_pin_start)
         - expected_strokes(lie_end,   distance_to_pin_end)
         - 1
```

Two `expected_strokes` sources, toggled in the stats UI:
- **Scratch baseline**: lookup + linear interpolation against `sg_baseline_scratch`.
- **Self-relative baseline**: same lookup shape, but the table is computed client-side from your
  own historical shots bucketed by (lie, distance). Buckets with too few samples (threshold TBD,
  e.g. <5 shots) fall back to the scratch table and are flagged in the UI as "low sample size."

## 7. Course Geometry Versioning

Editing a course's polygons never mutates `course_versions` in place — it inserts a new
`course_versions` row (+ copies of `holes`/`hole_features`) with an incremented `version_number`.
`rounds.course_version_id` pins each round to the geometry that was live when it was played, so
stats and lie-detection on old rounds never change retroactively because you tightened up a
bunker polygon later.

## 8. Mapbox Integration

- **Camera**: `bearing` set to the tee→green azimuth so the hole always renders bottom-to-top;
  `pitch` gives the tilted/foreshortened view so the full hole fits a smaller vertical footprint at
  a given zoom. Pinch-to-zoom is native Mapbox GL JS gesture handling, unaffected by bearing/pitch.
  The map constructor itself is initialized already tilted/rotated onto the tee (not a top-down
  green-centered view that eases into place) — `RoundMapPage` gates rendering `CourseMap` on
  `greenCentroid && fallbackOrigin` being resolved (not just `currentHole`) so those values are
  real by the time the map-init effect runs once on mount; the effect is mount-only, so mounting
  early would permanently lock the camera onto a null/flat fallback.
- **Tile caching**: flagging a real constraint here — Mapbox GL JS for **web** doesn't have the
  first-party "offline region" support that Mapbox's native iOS/Android SDKs have; that feature is
  SDK-only. Given you're fine with "spotty signal, not zero signal," the plan is a service-worker
  runtime cache of recently-viewed tiles (last N holes seen this session) purely to smooth over
  brief dead spots — not a durable pre-downloaded offline pack. Worth revisiting if you ever hit a
  course dead-zone that this doesn't cover.
- **Usage**: at ~3 rounds/week solo use, map loads stay comfortably inside Mapbox's free tier.
- **Marker refs and StrictMode**: every marker-creating effect must reset its own ref to `null` in
  the map-init effect's cleanup (alongside `map.remove()`), not just on its own dependency change.
  React StrictMode mounts every component twice in dev (mount → cleanup → mount again); the map-init
  cleanup destroys the whole map, but a marker ref left pointing at a marker orphaned from that dead
  map makes the marker effect take its "already created, just reposition" branch instead of creating
  a fresh one attached to the real map — so it never appears. GPS-derived markers (`me`) usually dodge
  this by accident (still `null` on the very first synchronous mount), but anything already real at
  mount time (tee, target) hits it immediately.
- **Chrome vs. map split (Grint-style layout)**: `RoundMapPage` owns all the surrounding UI —
  back button, ordinal hole header (`getHoleOrdinal`), left front/center/back distance capsule +
  pace timer, right utility pill (set target / map style / scorecard), bottom profile+score bar —
  and passes `hideInternalHud` to suppress `CourseMap`'s own built-in HUD box, which otherwise
  still exists as the default for simpler callers (currently just demo mode, `/round/demo`, which
  has no hole context to build real chrome around). Two pieces of `CourseMap` state became
  controllable from outside instead of fully internal:
  - `settingTarget`/`onSettingTargetChange` — optional; falls back to an internal `useState` when
    omitted (demo mode's own "Set target" button), so this is backward-compatible, not a breaking
    change to the prop contract.
  - `onDistanceUpdate?: (yards: number | null) => void` — fires whenever the origin→target
    distance changes; `RoundMapPage` derives front/back by ±15y off this "center" value rather
    than computing distance a second time.
  - `mapStyle` (defaults to `SATELLITE_STYLE`) toggles via `map.setStyle()`; since a style change
    can drop style-specific sources, the line source/layer setup was pulled into a named
    `ensureLineSource()` re-run on both the initial `"load"` and `"style.load"` after every switch,
    rather than assuming Mapbox's cross-style diffing preserves it.

## 9. In-Round Measuring Tool

- Tap the tee→pin line → spawns a draggable marker at that point.
- The line is **segmented** through every placed marker rather than staying a straight
  origin→target line: `updateLineAndLabels()` in `CourseMap.tsx` sorts all markers by distance
  from origin and routes `origin -> nearest marker -> ... -> farthest marker -> target`. Recomputes
  every marker's label on every drag/add/delete, since moving one marker can change every other
  marker's sort position and neighbors — a label reads `<distance from origin> / <distance to the
  next marker, or target if it's the last one>`, in a small dark capsule pinned above the dot.
- Each tap on the line spawns an independent new marker; markers persist per hole until the hole
  changes, are draggable anywhere on the map (not constrained back to the original line), and are
  local-only UI state (not persisted to Supabase/Dexie).
- **Tapping works on any segment of the (possibly already-bent) path**, not just the original
  straight origin→target line — the click handler rebuilds the same `[origin, ...sortedDots,
  target]` path `updateLineAndLabels()` uses, then scans consecutive pairs for one within
  `ON_LINE_TOLERANCE_METERS` of the tap, stopping at the first hit. Capped at `MAX_MEASURE_DOTS = 5`
  total markers per hole; taps beyond that are ignored rather than queued or replacing the oldest.

## 10. Hole Selection

- Auto: current hole = whichever hole's polygon set the blue dot falls inside (or nearest, within
  300m).
- Fallback: beyond 300m from every hole (clubhouse, range, parking lot) — or when manually
  overridden — a swipe/list selector picks which hole to view, defaulting to that hole's tee box.
  Same control doubles as general hole navigation (e.g., peek at hole 12 while standing on hole 3).

**Implemented (v1, simplified):** rather than true polygon-containment hole detection, current-hole
auto-select is a one-time nearest-tee-box check on load (distance from live GPS to every tee box on
the course; picks that hole if within 300m, otherwise leaves it on hole 1 / last manually selected
hole). It only runs once per page load, not continuously, so it won't fight manual prev/next
navigation while playing. `CourseMap` remounts (via a `key={holeId}`) on every hole switch rather
than diffing Mapbox layers in place — simpler, and fast enough that the re-init isn't noticeable.
Default target = the current hole's green centroid (first green if several, fairway centroid as a
fallback if no green was mapped); still user-overridable via "Set target".

## 11. Post-Round Review & Planned Aim Points

`ReviewRoundsPage.tsx` lists completed rounds (`db.rounds` filtered to `status === "completed"`,
joined through `courseVersions` to `courses` for a display name), then a hole-by-hole stepper for
the selected round's actual recorded shots.

- **`ReviewMap.tsx` is a separate component from `CourseMap`**, not more optional props bolted
  onto it. Reviewing a completed round has a fundamentally different interaction model — a fixed
  historical shot path, tapping the map to set a *planned* aim point — versus a live round's
  GPS-driven origin, live tee→green line, and measuring tool. None of `CourseMap`'s GPS/blue-dot/
  measuring-tool machinery makes sense here (you may not even be at the course), and threading a
  review mode through it risked destabilizing the app's most-used, most-tested code path for
  comparatively little shared logic. What IS shared: the tee-at-bottom tilted-camera convention,
  for visual consistency with the live round view.
- **Camera correctness gotcha**: `shots`/`fallbackOrigin` arrive from async `useLiveQuery` chains
  in the parent that are essentially never resolved on `ReviewMap`'s first render. A first attempt
  set the camera once in the mount effect (same pattern `CourseMap` used to have, before the
  `greenCentroid && fallbackOrigin` gating fix in §8) and it reproduced the same failure mode: the
  camera permanently locked onto the `{43.55, -80.2}` generic fallback while the real shot markers
  rendered far outside the visible viewport. Fixed with a dedicated effect that re-centers whenever
  real origin/finalPoint coordinates become available — `jumpTo` (instant) the first time, `easeTo`
  (animated) after that for hole-to-hole navigation, since `ReviewMap` isn't remounted per hole the
  way live-round `CourseMap` is.
- **Aim points**: `Shot.aimPointOverride` (already in the schema, previously unused) is set via
  `roundRepo.setShotAimPoint(shotId, point)`, following the same upsert+outbox pattern as every
  other write in that file. The shot list below the map has a "🎯 Set Aim Target" toggle per shot;
  toggling one arms `ReviewMap`'s click handler, and the next map tap writes the point and disarms.
  Rendered as a small red marker per shot that has one set.

### Dispersion ellipses — implemented, not wired up

`computeDispersionEllipse()` in `lib/geo.ts` is complete (covariance-matrix eigendecomposition,
confidence-scaled semi-axes) but nothing calls it yet — no chart or map overlay consumes it. Needs
a UI home (likely a stats page, filtering shots by club into `(downrange, offline)` points via
`toDownrangeOffline`) before it does anything visible.

## Course Import — Overpass → Dexie

Implemented in `src/lib/importOverpass.ts` (pure parsing) + `src/lib/courseRepo.ts` (Dexie
persistence). Key decisions, since they weren't fully nailed down in the schema design:

- **Hole numbering**: holes are built for `1..max(ref)` observed across `golf=hole` features, so
  gaps (a hole missing its centerline in OSM) still produce a placeholder `Hole` row (par defaulted
  to 4, no yardage) rather than being silently dropped — every other feature still needs a `hole_id`
  to attach to. See `docs/osm-editing-guide.md` for the real gaps found in Tarandowah (holes 12/13).
- **Feature → hole assignment**: fairway/bunker/rough/hazard/fringe polygons are assigned to
  whichever `golf=hole` centerline they're geometrically closest to (`turf.pointToLineDistance`
  from the polygon's centroid). Simple and works well in practice, but a hole with no centerline
  "loses" its features to a neighboring hole instead of failing — flagged as an import warning, not
  silently wrong.
  - **Greens and tees are handled differently** (`nearestHoleByCenterlineHalf`), because plain
    nearest-line distance genuinely misassigns them on real data: two consecutive holes'
    centerlines often run close together right where one hole's green sits near the next hole's
    tee-off direction, and a green can end up perpendicular-closer to the *wrong* hole's line than
    to its own. The fix uses `turf.nearestPointOnLine` to find where a feature projects onto each
    candidate hole's line as a fraction (0=start, 1=end) of that line's length, only considers
    holes where the fraction lands on the correct half (green → back half, tee → front half), and
    picks the perpendicular-closest among those, falling back to plain nearest-line if nothing
    qualifies. A simpler first attempt — matching to the nearest hole's raw start/end *vertex
    coordinate* instead of a fractional position along the line — was tried and rejected: real
    course centerlines are only 2-4 vertices approximating the true fairway path, so a genuinely
    correct green can legitimately sit 100-300m from its own hole's literal last vertex, while an
    unrelated neighboring hole's vertex happens to be closer by coincidence. Verified against the
    real Tarandowah/Innerkip data before shipping either version — see the code comment on
    `nearestHoleByCenterlineHalf` for how.
- **Bunker greenside/fairway split**: OSM only has `golf=bunker`, no side info. Classified by
  distance from the bunker centroid to the nearest green centroid *on the same hole*: ≤30y →
  greenside, else fairway. A heuristic, not authoritative — fine to be wrong occasionally until the
  course editor exists to fix it by hand.
- **Tee boxes**: `golf=tee` polygons produce *two* things — a `hole_features` row (feature_type
  `tee`, real polygon, for rendering) and a `tee_boxes` row (centroid point, name from the `teebox`
  color tag, semicolon-joined if a tee serves multiple colors) for later "which tee are you playing"
  selection. Any hole that ends up with **no** tee box this way (real courses sometimes have
  `golf=hole` centerlines mapped without ever mapping `golf=tee` polygons — true for most of
  Innerkip/Tarandowah) gets one synthesized from the first coordinate of its centerline instead,
  named `"Tee (approx.)"` so it's identifiable as a fallback rather than real OSM data. Without
  *some* tee box the round map has no origin to draw the tee→green line/camera from and gets stuck
  on "Loading course…". A hole with no centerline at all still can't get one — see
  `docs/osm-editing-guide.md`.
- **Tee set selection**: a hole can have several `tee_boxes` rows (one per marker color —
  white/blue/red, etc). `RoundMapPage` lets you pick a preferred set from a dropdown (populated
  from the union of tee names across the whole course), persisted to `localStorage` under
  `caddyshot_tee_preference` so it survives reloads. If the preference doesn't match a tee box on
  the *current* hole (naming can be inconsistent hole-to-hole in the source data) or nothing's been
  chosen yet, it falls back to the **backmost** tee box — furthest from the green centroid — rather
  than an arbitrary array order, on the theory that "furthest from the green" is a more useful
  default than "whichever happened to be seeded first."
- **Re-seeding on a fix**: `seedBundledCourses()` has two independent triggers for wiping and
  re-importing an already-present bundled course, since neither alone catches every case a fix
  might need: (1) zero tee boxes present (detects the tee-box-fallback gap above), and (2) a
  version-keyed `localStorage` flag (currently `caddyshot_reseeded_v2`) that unconditionally wipes
  once regardless of tee-box presence — needed because a course can have tee boxes and still have
  them, or its greens, mapped to the *wrong hole*, which tee-box presence alone can't detect. Bump
  the version key (`v3`, `v4`, ...) the next time a parser fix needs everyone re-seeded again.
- **Re-importing** a course with a name that already exists adds a new `course_versions` row under
  the same course (copy-on-write, per §7) rather than duplicating it.

### Bundled courses (zero-network on-course loading)

Course GeoJSON is **not** fetched from a database at runtime — it ships as a static asset inside
the app itself, so it works with zero network at the course, not just "usually fine on weak
signal." `public/courses/*.geojson` are copies of the raw exports in `data/imports/` (which remain
the source-of-truth audit trail); `vite.config.ts`'s `workbox.globPatterns` explicitly includes
`geojson` so the service worker precaches them alongside the JS/CSS bundle. `lib/seedCourses.ts`
runs once per app load (fired from `App.tsx`, fire-and-forget) and imports any bundled course not
already in Dexie by name — idempotent, so it's cheap to just always call it rather than tracking a
"first run" flag.

This was a deliberate choice over a database-backed course catalog: the course list is small,
changes rarely, and the whole point is it has to work standing in a fairway with no signal — a
static bundle guarantees that; a database sync would just add a failure mode ("did it sync before I
left home") for data that doesn't need to be dynamic. Supabase remains the right tool for *round*
data (scores/shots), which is genuinely per-session and needs to survive a phone loss — see §1.

**Adding a new bundled course**: drop the `.geojson` in `public/courses/`, add `{name, file}` to
`BUNDLED_COURSES` in `seedCourses.ts`, commit+push — it auto-seeds into everyone's Dexie on next
load. The in-app Data Imports upload flow (`DataImportsPage.tsx`) still exists independently for
ad-hoc/one-off imports that don't warrant a code change.

## Open Items / Risks

- **Trackman import deferred out of v1.** No usable CSV export in hand yet (only a web session
  viewer, not a downloadable file) — revisit once an actual export is available. Schema/dispersion
  code should leave room for it (section 2/4) but nothing depends on it now.
- `sg_baseline_scratch` needs a real seed dataset. Checked DataGolf's public FAQ
  (datagolf.com/frequently-asked-questions) — they describe their methodology (baseline = average
  performance of tour players ranked ~125-175, categories: tee/fairway/rough/sand/green/recovery,
  ARG = within 50y of the pin) but **do not publish the actual expected-strokes lookup values** —
  those are proprietary. Need an alternate source for real numbers, most likely Mark Broadie's
  published expected-strokes tables/formulas (from *Every Shot Counts*, widely reproduced in golf
  analytics writeups) rather than DataGolf directly. Until then, seed with a rough placeholder
  curve per lie type so the UI/schema can be built and tested, clearly marked as non-authoritative.
- Self-relative baseline is meaningless until enough rounds are logged; needs a "not enough data
  yet" state in the UI rather than showing a misleading number from a tiny sample.
- Shot recording v1 is built (`lib/roundRepo.ts`, `lib/lie.ts`, `components/RoundSheets.tsx`):
  start round → per-shot bottom sheet (shot number, club chips, lie auto-detected at the current
  GPS fix via §5 point-in-polygon, overridable by tapping any lie chip — courses move their rough)
  → "hole out" sheet (putts + score, score auto-suggested as recorded shots + putts) → auto-advance
  to the next hole; finishing hole 18 completes the round. Each shot's end point/lie is closed out
  by the *next* shot's start (or by the green centroid on hole-out — real per-round pin positions
  still TODO). Course polygons are intentionally not rendered on the in-round map (user preference:
  satellite imagery only); they exist solely to power lie detection.
- Remaining round-tracking gaps: per-round pin placement UI (§ Rounds), round review screen
  (breadcrumbs/shot markers), stats/SG engine, dispersion views, in-app course editor.
- Target device is Pixel 9 Pro / Chrome on Android, which has solid Background Sync API and
  Geolocation support — sync worker can lean on that as the primary path, with a polling fallback
  kept only for cheap future-proofing if this ever runs on another browser/device.
- `npm run build` fails **locally only**: workbox-build's service-worker codegen embeds absolute
  file paths as single-quoted JS import strings, and the project sits under `C:\Users\Colin's
  PC\...` — the apostrophe breaks out of the string. Deployment happens via GitHub Actions
  (`.github/workflows/deploy.yml` → GitHub Pages at `/golf-app/`), where the Linux runner's paths
  have no apostrophe, so CI builds fine. Local workflow remains `npm run dev`. If a local build is
  ever truly needed: move the project to an apostrophe-free path, or switch vite-plugin-pwa to
  `injectManifest`.
- Same apostrophe bug also breaks the PWA plugin's **dev-mode** service worker (it 500s on
  `dev-sw.js`), so `devOptions.enabled` is `false` in `vite.config.ts` — "Add to Home Screen" only
  ever works against the real deployed site, never `npm run dev`. Caught by actually driving the
  dev server in a real (Playwright) browser rather than just checking HTTP status codes on
  transformed files — that testing gap is also how the `courses` table missing a `name` index
  (below) shipped without being noticed.
- **Fixed**: `db.courses` didn't index `name`, but both `courseRepo.saveImportedCourse` and
  `seedCourses.ts` query `.where("name")` — Dexie throws on querying a non-indexed field, so course
  saving/seeding was silently failing end-to-end since courseRepo.ts was written. Fixed via a
  Dexie `version(2)` migration adding the index. Lesson: this class of bug is invisible to
  type-checking and "does it transform" smoke tests — needs an actual browser exercising the
  runtime query path to catch.
