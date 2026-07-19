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
  - **Auto-fit zoom**: instead of a fixed `zoom: 17` (too tight on long Par 5s, too loose on short
    Par 3s), the constructor calls `map.fitBounds([fallbackOrigin, initialTarget], { bearing,
    pitch, padding: { top: 120, bottom: 180, left: 60, right: 60 }, duration: 0 })` right after
    creation — asymmetric padding biases the fit so the tee sits nearer the bottom and the green
    nearer the top. `duration: 0` keeps it instant (no fly-in animation), matching the "no visible
    spin/tilt on the first frame" goal the pre-rotated constructor options already established.
    Caveat: Mapbox's bounds-fitting for a *pitched* camera is an approximation, not an exact
    per-pixel placement — the green consistently lands near the top, but the tee isn't pinned to
    the literal bottom edge on every hole. Falls back to the old fixed `zoom: 17` centered view
    when `fallbackOrigin`/`initialTarget` aren't both available yet (e.g. demo mode).
  - **Live-GPS activation range + off switch**: `usingLiveGps` swaps live GPS in for the saved-tee
    origin once the device is within `GPS_ACTIVE_MAX_METERS` (2000 yards ≈ 1828.8 m) of the tee —
    widened from a much tighter 300m so real position drives the map anywhere on/near the course,
    not just on the tee. A `gpsEnabled` prop (Settings › Location "Use live GPS on the course",
    persisted in `lib/settings.ts` under `caddyshot_gps_enabled`, default on) forces GPS off
    entirely: the `watchPosition` effect early-returns and clears `me`, so `origin` falls back to
    the saved tee. Read once on `RoundMapPage` mount, so toggling it takes effect next round open.
  - **Overlapping measure-dot dedupe**: after a user adds or drops a measure dot, `dedupeMeasureDots`
    removes any dot whose on-screen center (via `map.project`) is within `DEDUPE_PX` (26px) of an
    earlier one, so dots never pile up. Deliberately skipped when *seeding* dots (saved waypoints,
    auto-layup — `addMeasureMarker(point, false)`): those are already known-distinct, and running the
    pixel dedupe during early mount, before the canvas is final-sized and `map.project` is reliable,
    would falsely collapse genuinely separate seeded dots.
  - **Saved waypoints seed the measure line** (`initialWaypoints`, from `Hole.waypoints`): placed
    once on mount, and when present they suppress the automatic layup suggestion (they *are* the
    user's considered layup line). `waypointsSeededRef` guards the one-shot — and, like
    `autoLayupPlacedRef`, it is reset in the map-init cleanup, or StrictMode's throwaway first mount
    would consume the guard and the real mount would silently skip seeding (a bug this exact reset
    fixes; see the marker-refs note above for the same StrictMode hazard).
  - **In-round text scale**: the on-course HUD/header/pill/label sizes are deliberately large for
    arm's-length sunlight reading — measure-dot segment labels ~2x (22px), plus scaled-up hole
    header, BACK/CTR/FRONT card, right pill, tee selector, and bottom bar. The 📋 scorecard pill was
    replaced by a live score-to-par badge (`relativeToParLabel`, e.g. "-2"/"E"/"+3", "–" pre-round).
  - **Camera re-centering now also uses `fitBounds`, not `easeTo`**: the `[target, origin]` effect
    that re-orients the camera as the target/tee change used to call `map.easeTo({ center: origin,
    bearing, pitch })` — a fixed zoom that didn't re-frame the hole. It now calls the same
    `fitBounds` pattern as the initial constructor, but with tighter padding: `{ top: 104, bottom:
    122, left: 60, right: 60 }`, chosen so the green lands roughly under the right-side `🎯` pill
    button and the tee lands roughly at the bottom edge of the left distance HUD card (§17) —
    every hole ends up occupying about the same vertical screen footprint regardless of yardage.
  - **Tee-drag also suppresses the camera re-fit**, not just target-drag: `isDraggingTeeRef`
    (`dragstart`/`dragend` on the tee marker) is checked alongside `isDraggingTargetRef` in the
    `[target, origin]` effect's guard (`!isDraggingTargetRef.current &&
    !isDraggingTeeRef.current`) — without it, every tee-drag tick's `teeOverride` update would
    re-trigger a `fitBounds` mid-drag, fighting the user's own drag gesture with a competing camera
    animation. Mirrors the target marker's existing pattern (§8 draggable target marker bullet).
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
  back button, a slim single-line hole header (`"${getHoleOrdinal(n)} - Par ${par} - ${yardage}
  Yards"`, no icons — pitch-black background with a thin emerald border, per the "sleek theme"
  pass; not extended to every other container, since only the header and the notes-preview
  snippet, §15, were concretely tied to that change), bottom-left front/center/back distance
  capsule (§17), right utility pill (set target / map style / notes / scorecard / dispersion —
  each button also carries a native `title` attribute so its purpose is discoverable on
  hover/long-press), bottom profile+score bar —
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
    can drop style-specific sources, all of `CourseMap`'s sources/layers (target line, invisible
    bunker hit-test layer, dispersion ellipse) are (re-)added by one named `ensureSources()`,
    re-run on both the initial `"load"` and `"style.load"` after every switch, rather than assuming
    Mapbox's cross-style diffing preserves them.
- **Version badge**: `App.tsx` renders a fixed `1.0` label bottom-right on every route (outside the
  `<Routes>` switch, so it survives navigation), `pointer-events: none` and low-opacity so it never
  intercepts taps. Manually bumped by hand with each meaningful round of changes — not derived from
  `package.json` or git — since this app has no CI/CD versioning pipeline and is single-developer.
- **Touch targets**: every draggable map dot (measure markers, the target/pin marker, the tee
  marker) is a 44×44px invisible flex-centered `.map-touch-target` div — the actual Mapbox marker
  element Mapbox positions/tracks — wrapping a smaller visual `.map-touch-dot` (16px for measure
  dots, 14px for the target, 12px for the tee). A thumb covers the 44px target without obscuring
  its own view of the smaller dot inside it.
  - **Mathematical drag offset** (`applyTouchDragOffset`): while dragging, the marker's *actual
    geographic coordinate* — not just its rendered position — is kept 50px above the real touch
    point. On every `drag` tick: `map.project(marker.getLngLat())` to get the pointer-driven
    position in screen pixels, subtract 50 from Y, `map.unproject()` back to a LngLat, and
    `marker.setLngLat()` there. Since Mapbox renders a marker at whatever screen position its
    coordinate projects to, this makes the visual dot sit 50px above the finger for free — no CSS
    transform needed, and critically, the marker's *real* position (what `dragend`/the line/the
    dispersion ellipse all read) matches what's on screen, unlike a purely cosmetic CSS offset
    would. Safe to call every tick: Mapbox's own marker-drag math bases each tick's "natural"
    position on the pointer's cumulative delta from drag-start, not on wherever
    `applyTouchDragOffset` last snapped the marker to, so repeated calls don't compound or drift.
    Applied uniformly to the tee, target/pin, and measure-dot markers. `src/index.css`'s
    `.map-touch-target:active .map-touch-dot` rule now only changes the dot's color to green while
    pressed (an earlier version also applied `translateY(-55px) scale(1.25)` via CSS — removed,
    since stacking a CSS transform on top of the *real* coordinate offset above would double it).
  - `user-select: none` is set globally in `index.css` too — this is a touch-driven map app, not a
    document, so double-taps must never trigger the OS text-selection menu.
  - **Waypoint label offset while dragging**: each measure dot's distance label is a plain
    absolutely-positioned child div (`top: 36px; left: 50%; transform: translateX(-50%)`, centered
    underneath the dot by default). `dragstart` shifts it to `top: 10px; left: 44px; transform:
    translateY(-50%)` (beside the dot, vertically centered) so a thumb dragging the dot doesn't
    also cover its own live-updating distance label; `dragend` restores the default underneath
    position. Purely a `label.style` mutation on the existing DOM node — no re-render, same
    approach as the touch-target color change above.
- **Draggable target marker (custom pin locations)**: the red target marker is `draggable: true`;
  `drag` calls `setTarget(applyTouchDragOffset(...))` on every tick (same render path as
  tap-to-set, so the line/labels/`onDistanceUpdate` all update live with no special-casing —
  `setTarget` doesn't know or care its argument is offset from the raw touch point, see the touch
  targets bullet above), while `dragstart`/`dragend` toggle an
  `isDraggingTargetRef` that suppresses the camera's `easeTo` re-orientation for the duration —
  without it, the map would spin/re-tilt continuously as you drag instead of just following the
  pin. `dragend` re-enables the camera (settling it once, smoothly, to face the final position) and
  fires `onTargetChange` with the settled point so `RoundMapPage` can persist it as
  `roundHoles.pinLocation`. Tap-to-set-target (§10) fires the same callback, so either way of moving
  the pin persists.
- **Draggable tee marker (never persisted)**: unlike the target/measure markers, the tee marker's
  drag only updates a local `teeOverride` state (also via `applyTouchDragOffset`, same as the
  target marker) — there's no `onTeeChange`-style callback and
  nothing is written to Dexie. `origin` resolves as `usingLiveGps ? me : (teeOverride ??
  fallbackOrigin ?? me)`, so a drag temporarily re-anchors the line/yardages/camera (e.g. playing
  from just off the mapped tee marker) without corrupting the real tee-box data. `teeOverride`
  resets to `null` whenever `fallbackOrigin` itself changes — new hole, or a different tee set
  picked from the dropdown — so a stale drag from a previous tee never lingers; since `CourseMap`
  also fully remounts per hole (`key={currentHole.id}`), a hole change resets it for free anyway.
  The `>300m live-GPS proximity check` stays keyed off the *real* `fallbackOrigin`, not
  `teeOverride` — that check is about real-world position validity, which a temporary drag
  shouldn't be able to spoof.

## 9. In-Round Measuring Tool

- Tap the tee→pin line → spawns a draggable marker at that point.
- The line is **segmented** through every placed marker rather than staying a straight
  origin→target line: `updateLineAndLabels()` in `CourseMap.tsx` sorts all markers by distance
  from origin and routes `origin -> nearest marker -> ... -> farthest marker -> target`, in a small
  dark capsule pinned above the dot (see the segment-label bullet below for the label format).
- Each tap on the line spawns an independent new marker; markers persist per hole until the hole
  changes, are draggable anywhere on the map (not constrained back to the original line), and are
  local-only UI state (not persisted to Supabase/Dexie).
- **Segment-to-segment labels, not always-from-tee**: a label reads `<distance from the previous
  point on the path> / <distance to the next point, or target if it's the last one>` — i.e. true
  leg-by-leg yardages (tee-to-dot-1, dot-1-to-dot-2, ...), not every dot's distance measured from
  the tee. `updateLineAndLabels()` recomputes every dot's neighbors (both sides) on every
  drag/add/delete, since moving one dot can change every other dot's sort position.
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
fallback if no green was mapped); user-overridable both by tapping "Set target" and by directly
dragging the red target marker (see §11), and persisted per-hole-per-round as a custom pin once set.

**Stale-hole-data gotcha (same shape as the marker-refs/StrictMode and ReviewMap-camera bugs
elsewhere in this doc, different trigger):** `currentHole` is a `useMemo` derived synchronously from
the already-loaded `holes` array, so it updates the instant `holeNumber` changes. `teeBoxes`/
`holeFeatures`, however, are separate `useLiveQuery` subscriptions keyed on `currentHole?.id` —
confirmed via direct render logging that Dexie's live-query hook keeps returning the *previous*
hole's already-resolved rows for several renders after the dependency changes, before the new query
catches up. Since `<CourseMap key={currentHole.id}>` remounts immediately when the key changes, and
`CourseMap` only reads `initialTarget`/`fallbackOrigin` once at mount, trusting this stale data
would lock the new hole's camera onto the *previous* hole's green/tee permanently. `greenCentroid`/
`fallbackOrigin` in `RoundMapPage` guard against this by checking every row's `holeId` actually
matches `currentHole.id` (not just checking non-null/non-empty) — returns `null` during the stale
window, which naturally holds `<CourseMap>` on the existing "Loading course…" gate until the real
data for the new hole arrives. Found via the OSM-mapping scorecard-yardage verification (§ real
ground-truth yardages, not just internal cross-checking, caught what a simple non-null check
couldn't).

## 11. Post-Round Review & Planned Aim Points

`ReviewRoundsPage.tsx` lists completed rounds (`db.rounds` filtered to `status === "completed"`,
joined through `courseVersions` to `courses` for a display name), then a hole-by-hole stepper for
the selected round's actual recorded shots.

- **Scorecard**: the round list shows each round's to-par + holes-scored summary, and an open round
  has a "Scorecard" button that opens the same `ScorecardSheet` component the live round map uses
  (hole/par/score/± with a running total) — built from the round's `roundHoles` joined to the
  version's holes, so the review scorecard is literally the in-round one, not a parallel
  implementation. Only holes with a recorded `score` count toward the total, so a partial round
  still summarizes sensibly.

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

## 12. Water Hazards & Bunker Warnings

Course polygons are still never rendered visually (§8's satellite-only design) — hazards and
bunkers are used purely as invisible geometry, in two different ways:

- **Water hazards — closest-point proximity, not a crossing check**: `updateWaterWarning()` in
  `CourseMap.tsx` finds the closest point on the boundary of *any* `hazard`-type `HoleFeature`
  polygon to the current `origin` (tee/GPS) — `turf.polygonToLine` converts each hazard to its
  boundary, `turf.nearestPointOnLine` finds the closest point on it to `origin`, closest wins
  across all hazards on the hole. This is deliberately a "how close is water to me" proximity
  warning, not "does my current aim line cross water" — earlier versions used
  `turf.lineIntersect` against the aim path, but that only fired when actively aiming through a
  hazard, missing hazards that are simply *nearby* (e.g. lurking down the right side) while you're
  aiming elsewhere. Called whenever `origin` changes (the target/origin camera effect) or
  `holeFeatures` updates, not tied to the measuring-line path at all anymore. Reported two ways:
  `onWaterWarning?(yards)` for the parent's own HUD row (`RoundMapPage` renders "⚠️ Water: XXXy" as
  the last row of its bottom-left HUD, §17), and a small circular red Mapbox `Marker` with a white
  "!" placed directly at the closest point on the map itself — no yardage text on the marker
  itself, by design; that's the HUD's job. A DOM marker is simpler than a symbol layer for a
  single, occasionally-repositioned icon like this.
- **Bunkers**: an invisible (`fill-opacity: 0`) GeoJSON fill layer (`BUNKER_SOURCE_ID`) holds every
  `bunker_greenside`/`bunker_fairway` feature for the current hole — invisible but still
  hit-testable via `map.queryRenderedFeatures`, same trick used for hazard-free click detection
  elsewhere. The map's single `click` handler checks this layer *first*, before falling through to
  the existing settingTarget/measure-dot logic; a hit computes `front`/`middle`/`back` yardages
  (closest/farthest polygon-ring vertex from origin for front/back, `turf.centroid` for middle —
  a reasonable proxy, not survey-precise line-polygon clipping) and shows them in a floating capsule
  card, cleared on hole change.
- Both sources are populated by `updateBunkerSource()`, called from `ensureSources()` on load/style
  change and from a `[holeFeatures]`-keyed effect so navigating holes refreshes them.
- **Verification note**: hit-testing a small polygon on a tilted (pitch 55°) 3D-projected map by
  guessing screen pixel coordinates is unreliable — a coarse blind grid-click sweep missed real
  bunkers repeatedly during verification even though the underlying data/layer were correct. Confirmed
  correct by temporarily exposing the map instance (`window.__debugMap`, removed before shipping) to
  call `map.project()` on a known bunker's actual centroid and click exactly there — the card
  rendered ("Front 209y Mid 212y Back 215y"). Water hazard crossings don't have this problem since
  the check is pure lat/lng geometry (`turf.lineIntersect`), not a screen click.

## 13. Shot Logging — Instant Green-Putter Save

`ShotSheet` (`RoundSheets.tsx`) treats landing on `"green"` as a special case: unlike every other
lie (which requires a lie tap, then a club tap to save), tapping "Green" — or auto-detecting it via
`detectedLie` — saves the shot **immediately** with `Putter`, zero taps in the club grid. A
`useEffect` watching `lie` fires `onSave(putter.id, "green")` whenever `lie` becomes `"green"`,
covering both paths (auto-detected initial state, and a later manual tap of the Green tile) with
one code path; the component renders `null` once that state is reached, since the sheet is about
to close. Putting off the green is a near-certainty and the single most frequent lie transition in
a round, so this is worth a small special case.

## 14. Fairway Miss Tracking

`RoundHole.fairwayResult?: FairwayResult | null` (`"hit" | "left" | "right" | "short" | "long"`).

- **Auto-detected the instant Shot 2 is logged** (`lib/fairway.ts`'s `classifyFairwayResult`), Par
  4+ only, and only when the hole has a mapped `fairway` `HoleFeature` to test against — Shot 2's
  start point is the same coordinate `recordShot` already closes Shot 1's `endPoint` out to, so no
  extra GPS read is needed. Classification: inside the fairway polygon
  (`turf.booleanPointInPolygon`) -> `"hit"`; otherwise projected into the tee→green
  (downrange, offline) frame via `toDownrangeOffline` — past either end of the *fairway polygon's
  own* downrange span along that line -> `"short"`/`"long"`; still within that span but off to the
  side -> `"left"`/`"right"` by the sign of `offlineYards`. Written immediately via
  `roundRepo.setRoundHoleFairwayResult`, independent of whether the hole is finished yet.
- **Still overridable**: `HoleScoreSheet` renders the 5-tile selector for `par >= 4` holes with the
  auto-detected value (passed in as `autoDetectedFairwayResult`) pre-selected — tapping any other
  tile overrides it, and whatever the sheet shows at Save Hole time is what
  `roundRepo.saveHoleResult` finally persists (the Shot-2-time write is just an early pre-fill, not
  the source of truth).
- Verified against real course data with a scripted GPS move to a point computed 150y downrange /
  45y right of an actual hole's tee→green line — the app classified it `"right"` and the sheet
  pre-selected "Right", confirming the coordinate math end-to-end rather than just that some value
  gets set.

## 15. Per-Hole Notes

`Hole.notes?: string | null` — tied to the **hole** (course-level data), not the round, so a note
written once ("water short-right, take one more club") reloads automatically the next time that
course/hole is played, regardless of which round. Editable via a togglable textarea popover opened
by a `📝` button in the right-side utility pill (originally lived in the header — moved to the pill
so it groups with the rest of the round-map tools, §17); writes are debounced 600ms after the last
keystroke (`lib/courseRepo.updateHoleNotes`) rather than requiring an explicit save action.
Whenever a note exists and the popover is closed, a truncated one-line preview pill
("📝 Notes: ...") floats centered above the bottom bar — tapping it just calls the same
`setNotesOpen(true)` the pill button does, so there's no separate open path to keep in sync.

## 16. Dispersion Overlay & Settings

`computeDispersionEllipse()` in `lib/geo.ts` (covariance-matrix eigendecomposition,
confidence-scaled semi-axes) is now wired up end-to-end via `lib/dispersion.ts`:

- **Manual** (`manualDispersion(club)`): reads `Club.manualFrontBackYards`/`manualLeftRightYards`
  (edited on the Settings page's per-club table) and halves them into semi-axes. `rotationRad: 0`
  — front/back and left/right are already expressed in the shot's own downrange/offline frame, so
  no extra rotation is needed on top of the bearing-based rotation `CourseMap` applies when drawing
  it.
- **Actual** (`computeActualDispersion(clubId)`, gated by `Club.useActualDispersion`): pulls every
  recorded `Shot` for that club with both an `endPoint` and an `aimPointOverride` (set during
  post-round review, §11), projects each end point into its own start→aim bearing's
  (downrange, offline) frame via `toDownrangeOffline`, and fits a 90%-confidence ellipse across all
  of them. Shots without a recorded aim point are skipped — there's no meaningful "offline" axis
  without knowing what was being aimed at. Falls back to manual values when there isn't enough
  actual history yet.
- **Round map picker** (`RoundMapPage`): the 📐 pill button toggles a club-chip panel
  (`clubPickerStyle`) with an explicit ✕ close control in its header; `activeClubId` → an effect
  resolves the club's `DispersionEllipseSpec` via `getClubDispersion` and passes it to `CourseMap`
  as `dispersionEllipse`. "None" clears it. (This trigger UI was briefly removed and then brought
  back with the close button; the underlying `computeDispersionEllipse` / `lib/dispersion.ts` /
  `CourseMap` drawing+centering was never touched.) The ellipse only actually draws once the chosen
  club has dispersion data — manual front/back+left/right in Settings, or enough recorded shots with
  known aim points — so selecting a brand-new club with neither shows nothing, by design.
  - **Centering** (`getDispersionCenter()`): the target of the shot currently being played, not
    always the green — `RoundMapPage` passes `currentShotNumber={shotCount + 1}` down; shot 1
    centers on the nearest-to-origin measure dot (`dots[0]`), shot 2 on the second-nearest
    (`dots[1]`), shot 3+ on `target` (the green/pin). The idea: once you've placed layup dots,
    those *are* the aim points for your first couple of shots (e.g. laying up short of a hazard,
    then a second layup past it), and only later shots are realistically aimed at the green
    itself. Falls back to `target` if the relevant dot doesn't exist yet (e.g. shot 1 requested
    but no dots placed at all). Orientation bearing is `origin→center`, matching whichever point
    it resolved to, so the ellipse's long axis always points along the actual aim line for the
    current shot. Centered on the already-draggable dot/pin rather than being independently
    draggable — moving either moves the ellipse with it for free.
  - **Gotcha**: measure dots live in a ref (imperative Mapbox markers, not React state), so
    `updateDispersionEllipse()` doesn't re-run on its own when a dot is added/dragged/deleted the
    way it does for prop changes (`[dispersionEllipse, target, origin, currentShotNumber]`).
    `addMeasureMarker()` and its drag/delete handlers all call it explicitly, same pattern as
    `updateLineAndLabels()`.
  - **Bug found via this feature's own verification**: advancing `currentShotNumber` (by
    recording a shot) only matters if the player's placed measure dots *survive* that action —
    they didn't. Starting a round (`round` flipping `null` → non-null) re-fires the effect that
    resolves `roundHoleId`, and for one render `pinDataReady` (§ below) went false before the
    separate `currentRoundHole` live query caught up, unmounting and remounting `CourseMap` and
    silently wiping any dots the player had placed pre-round. Fixed by seeding a `resolvedRoundHole`
    state with the exact row `getOrCreateRoundHole` already resolved, so `currentRoundHole` (and
    `pinDataReady`) never has to wait on the live query to independently catch up to a
    `roundHoleId` the app already has full data for.
- Settings page (`SettingsPage.tsx`) is a simple per-club table (front/back yards, left/right
  yards, "use actual" checkbox), direct-writing on blur/change via
  `courseRepo.updateClubDispersion` — low-frequency editing, no debounce needed.
- **Gotcha**: `useLiveQuery` callbacks run in a Dexie **read-only** transaction — calling
  `ensureDefaultClubs()` (a write) from inside one throws `ReadOnlyError` and silently blanks the
  whole component (React error boundary territory). Seeding has to happen in a plain `useEffect` on
  mount; `useLiveQuery` stays a pure read (`listClubs()`). Same rule applies anywhere else a
  `useLiveQuery` callback is tempted to seed/upsert as a side effect.

## 17. Round Map Layout — Bottom-Left HUD & Automatic Fairway Layup

- **Bottom-left vertical stack**: three left-anchored elements stack without overlap, cleanest at
  `left: 12` throughout: `bottomBarStyle` (`bottom: 0`, the profile/score/action bar) →
  `notesPreviewStyle` (`bottom: 76`, the one-line note preview pill — left-aligned, not centered,
  specifically so it lines up under the HUD rather than floating independently) →
  `bottomLeftHudStyle` (`bottom: 122`, the green front/center/back distance card + water warning
  row). 122 = 76 (notes bar clearance) + the notes pill's own rendered height (~34px) + a small
  gap, so the HUD sits directly above the notes bar regardless of whether a note preview is
  currently showing (its slot is reserved either way — nothing shifts when a note is added or
  cleared). Previously the notes preview was horizontally centered and the HUD sat beside it, not
  above it; moved so they read as one deliberate stack rather than two independently-floating
  pieces. A pace-of-play timer (`elapsedMinutes` since arriving at the hole) used to live in the
  HUD card too — removed along with its state/effects, since nothing else in the app reads that
  value.
- **Notes popover placement**: `notesBoxStyle` is `top: 76` / `right: 64` — vertically aligned with
  the right pill's first button, offset left just enough to clear the pill's own width, so opening
  notes reads as "a panel next to the tool that opened it" rather than a disconnected overlay. This
  is a different element from the *preview* pill above (which is always bottom-left when a note
  exists); the popover itself stays anchored to the right, next to the 📝 button that opens it.
- **Automatic 275y fairway layup dot**: on mount, if the current hole isn't a Par 3 and its
  `defaultYardage` isn't under 300y, and it has a `fairway`-type `HoleFeature` and no measure dots
  exist yet, `CourseMap` places one automatically — the layup suggestion is still fully
  draggable/deletable like any manually-placed dot afterward. Computed in `RoundMapPage`
  (`fairwayLayupPoint`):
  1. Project a point exactly 275 yards down the tee→green line (`fromDownrangeOffline(tee,
     bearing, 275, 0)`).
  2. If that point falls inside the fairway polygon (`turf.booleanPointInPolygon`), use it as-is.
  3. Otherwise (a dogleg, a fairway that doesn't reach 275y, etc.), fall back to the midpoint of
     the segment where the tee→green line actually *crosses* the fairway polygon
     (`fairwayCenterlineSegmentMidpoint`): intersect the line against the fairway boundary
     (`turf.lineIntersect`), sort the crossing points by distance from the tee, and take the
     midpoint of whichever consecutive pair's own midpoint falls inside the polygon (preferring
     the widest such span if a dogleg produces more than one crossing pair). A straight line
     through an oddly-shaped fairway can cross its boundary more than twice, so this doesn't just
     assume "first two crossings = the inside segment."
  4. If the line never crosses the fairway polygon at all (a sharp dogleg), fall back further to
     the point on the fairway boundary closest to the tee (`turf.nearestPointOnLine` against
     `turf.polygonToLine(fairway)`) — a last resort, but still on the short grass.
  - This replaced an earlier version whose only fallback was step 4 (nearest fairway edge to the
    tee) — which could land the suggested dot right at the fairway's near lip, barely past the
    tee shot's landing area. The intersection-midpoint approach (step 3) is a meaningfully better
    "aim here" suggestion for the common case (a fairway the 275y point simply doesn't reach or
    overshoots on a dogleg) and is now the primary fallback; step 4 only fires when the straight
    line genuinely misses the fairway polygon altogether.
  - **No real centerline at round-time**: OSM's `golf=hole` centerline geometry (§ Course Import)
    is used only transiently during import — it's never persisted as a `HoleFeature` or any other
    Dexie row, only its *derived* outputs (yardage, par, tee/green hole-assignment) survive. Rather
    than adding a new persisted geometry type just for this one feature, the straight tee→green
    line (already computed every render as the aim line) stands in for "the centerline" — a
    pragmatic scope call, not a literal reproduction of the original mapped path.
  - **Stale-hole-data guard**: this is a *one-shot* placement (guarded by a ref, unlike the
    bunker/water logic which safely re-derives on every `holeFeatures` change), so placing it
    during the same transient stale-data window documented in §10/§8 would *permanently* lock in
    the wrong hole's fairway dot for that mount — worse than those other cases, which self-correct.
    To avoid needing a second staleness-guard mechanism inside `CourseMap` (which only receives a
    trimmed `{featureType, geometry}[]` shape without `holeId`), the projection is computed in
    `RoundMapPage` instead, reusing the exact same `holeFeatures.every(f => f.holeId ===
    currentHole.id)` guard already proven for `greenCentroid`/`fallbackOrigin`, and passed down as
    a single ready-made `autoLayupPoint: LatLng | null` prop. `CourseMap` only needs to know "place
    this point once when it shows up," not re-derive freshness itself. Also depends only on stable
    per-hole values (tee, green, par, yardage) rather than live GPS, so it doesn't re-fire on every
    position tick the way a naive `[origin, target, holeFeatures]` dependency array would have.

## 18. Tap-Away Dismissal, Teebox Auto-Hide, and the In-App Course Editor

- **Tap-away dismissal (notes popover)**: a wrapper `<div>` around `CourseMap` tracks
  `pointerdown`/`pointerup` screen coordinates (`mapPointerDownRef`) rather than using a plain
  `onClick` — panning/dragging the map still ends in a native `click` event on pointerup, so a
  naive click handler would dismiss the notes popover on every pan, not just an intentional tap.
  Only dismisses when movement between down and up is under `TAP_MOVE_TOLERANCE_PX` (10px). The
  wrapper only wraps the map itself (not the header/HUD/pill/sheets, which are separate siblings
  stacked above via z-index), so this never fights clicks meant for that chrome.
  `ShotSheet`/`HoleScoreSheet`/`ScorecardSheet` already tap-away-dismiss via `RoundSheets.tsx`'s
  shared `Sheet` component (a full-screen backdrop that closes on any click outside the sheet
  card), so this only needed to cover the notes popover, which has no backdrop of its own. The
  same distance check also correctly leaves the popover open while *repositioning a measure dot*
  (dragging a marker, not panning the map background) — both are just pointer movement past the
  wrapper's threshold from the same handler's point of view, so no separate marker-vs-background
  distinction was needed. Verified explicitly since it's easy to assume markers might swallow the
  pointer events differently than a bare map drag; they don't.
- **Teebox selector auto-hide**: `handleTeeChange` sets a `teeSelectorClosed` flag alongside
  saving the preference, hiding the whole selector card immediately rather than leaving it open
  for the rest of pre-round setup — the choice is already saved (`localStorage`), so there's
  nothing left for the card to do. Resets on hole change (`useEffect` keyed on `currentHole?.id`)
  so it's available again on a later hole, still gated to pre-round (`!round`) same as before.

### In-App Course Editor

`CourseEditorPage.tsx` (routes `/course-editor` and `/course-editor/:courseId`) exists to correct
mis-mapped tee box coordinates by hand, without round-tripping through OpenStreetMap + Overpass
Turbo + a re-import for a one-tee-box fix.

- **Standalone map, not a `CourseMap` reuse** — same rationale as `ReviewMap` (§11): this has none
  of `CourseMap`'s live-round machinery (GPS blue dot, measuring tool, dispersion, bunker cards,
  water warnings), so reusing it would mostly mean threading props through to hide all of that.
  Renders its own minimal Mapbox map: a read-only red green-reference marker, a draggable white
  tee marker for whichever tee box is selected (chip row, for holes with multiple tee sets), and
  a Save/Clear bottom bar.
- **Staged edits, not live-write-on-drag**: unlike the round map's tee marker (§8, local-only,
  never persisted) or target marker (persisted on every `dragend`), dragging here only updates a
  local `draftLocation` — nothing touches Dexie until "Save" (`courseRepo.updateTeeBoxLocation`,
  a direct overwrite of the `teeBoxes` row). "Clear" discards the unsaved drag back to whatever's
  currently persisted — there's no true "revert to original OSM import," since the original
  imported coordinate isn't tracked separately once overwritten. This is a deliberate scope call:
  building real edit-history tracking for a personal single-user admin tool wasn't worth the
  schema/complexity cost; the existing Data Imports flow remains the path to a genuine from-scratch
  re-import if a full reset is ever needed.
- Home's 4th tile (previously blank) now links here.
- **Editing green location, waypoints, and creating tees** (all persisted on the `Hole`, so they
  reload whenever the course is next played — see `courseRepo.updateHoleGreenPoint` /
  `updateHoleWaypoints` / `createTeeBox`):
  - **Green** — the reference marker (formerly read-only) is now draggable; dragging stages a
    `draftGreen`, "Save green" writes `Hole.greenPoint`, "Reset" clears it back to the polygon
    centroid. For a hole with no green polygon at all, "+ Green (center)" drops one at the map
    center. `RoundMapPage.greenCentroid` prefers `hole.greenPoint` over the derived centroid — so
    this both corrects mis-mapped greens and, critically, gives a target to greenless holes that
    otherwise never resolve one and sit on "Loading course…" (Tarandowah 6/12/13/15; see the OSM
    data-gap note).
  - **Waypoints** — a "+ Add waypoints" mode arms map-tap-to-place; markers are draggable and
    double-tap-delete (managed imperatively in `waypointMarkersRef`, like the round map's measure
    dots), "Save waypoints" writes `Hole.waypoints`. Rebuilt from the saved list on every hole
    change (gated on a `mapReady` state so it doesn't run before the map's "load"). Consumed by the
    round map via `initialWaypoints` (see §8).
  - **Tee creation** — a hole with zero tee boxes shows "+ Add tee box (map center)" (bottom-center,
    so it clears the left green/waypoint panel), which `createTeeBox`s a "Tee" at the map center;
    drag + Save to place it. This is what makes the no-tee holes (12/13) playable at all, since the
    round map can't render without a `fallbackOrigin`.
  - The camera recenter falls back to the green (`greenPos`) when a hole has no selected tee, so the
    editor doesn't strand you off-hole on exactly the holes most in need of fixing. (Holes with
    *neither* tee nor green — 12/13 before editing — still open at the map's default center; pan to
    the hole to drop the first tee.)
- **Tee marker drag also uses `applyTouchDragOffset`**: the editor's own tee marker drag handler
  (separate implementation from `CourseMap`'s, since this is a standalone map — see above) applies
  the same 50px mathematical screen-space offset (§8) rather than a plain `marker.getLngLat()`
  read, so the same "thumb doesn't obscure the real coordinate" behavior applies here too.
- **Custom hazard drawing**: a right-side "Hole Hazards" panel lets Point, Line, or Area hazards
  (water, creeks, ponds the OSM import missed or drew wrong) be added by hand, per-hole.
  - **Drawing state machine**: `drawingMode: "none" | "point" | "line" | "area"` plus
    `drawingCoords: LatLng[]` accumulate clicked map coordinates while armed. A `draw-hazard`
    GeoJSON source/layer set (fill for area previews, dashed line for line previews, small circles
    for placed vertices) renders the in-progress shape live; a separate `existing-hazards`
    source/layer renders every already-saved `HoleFeature` of `featureType: "hazard"` for this hole
    in translucent blue, so it's obvious what's already mapped before drawing something new.
  - **Point** saves immediately on the first map click (no "Finish" step) — buffered 3 meters via
    `turf.buffer` into a small circular polygon. **Line** and **Area** accumulate multiple clicked
    vertices with a live preview, then require an explicit "Finish" button (disabled until the
    minimum vertex count — 2 for a line, 3 for an area — is met): a line buffers 1.5 meters into a
    thin channel polygon, an area closes its ring and saves as-is. All three funnel through
    `courseRepo.saveCustomHazard(holeId, geometry)`, which writes a `HoleFeature` with
    `featureType: "hazard"` and queues it in the sync `outbox`, same pattern as every other
    Dexie-writing repo function.
  - **Why buffer Point/Line at all**: both the Supabase `hole_features` table (`geometry
    geography(polygon, 4326)`) and the app's own proximity-warning math (§12, which expects
    polygon geometries to measure distance-to-nearest-edge against) require a polygon — a bare
    point or line would fail the DB constraint and crash the warning calculation. Buffering by a
    small, fixed real-world distance is a pragmatic way to get a valid polygon out of what's
    conceptually a point or a line, without adding a second non-polygon geometry code path
    anywhere else in the app.
  - `turf.buffer` can return `undefined` for degenerate inputs (its TS typing reflects this) — both
    call sites (`Point`, `Line`) check for that before proceeding, bailing out (and, for `Line`,
    leaving `drawingMode` armed so nothing is silently lost) rather than assuming a result.
  - **Delete**: each hazard in the panel's list gets a 🗑️ button calling
    `courseRepo.deleteHoleFeature(featureId)`, which deletes the Dexie row and queues a matching
    `outbox` delete entry.

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
  - **Backward-drawn centerlines**: `nearestHoleByCenterlineHalf`'s start/end-fraction matching
    silently breaks if a `golf=hole` way was digitized green-to-tee instead of tee-to-green (real
    bug found on Tarandowah's holes 1, 9, and 11). Corrected *before* any half-matching runs: for
    each hole's line, find the closest `golf=green` polygon by raw `turf.pointToLineDistance`
    (independent of half-matching, since that's what's being fixed) and check whether it sits
    nearer the line's first or last coordinate — nearer the first means the line runs
    green-to-tee, so its coordinates are reversed in place. Verified with a synthetic backward
    line + no `golf=tee` polygon (forcing tee-box synthesis from the centerline's start, §
    below) — the synthesized tee lands at the real tee coordinate only if the reversal ran first.
- **Bunker greenside/fairway split**: OSM only has `golf=bunker`, no side info. Classified by
  distance from the bunker centroid to the nearest green centroid *on the same hole*: ≤30y →
  greenside, else fairway. A heuristic, not authoritative — fine to be wrong occasionally until the
  course editor exists to fix it by hand.
- **Water hazards beyond `golf=water_hazard`**: OSM frequently maps ponds/streams/creeks with no
  `golf=*` tag at all (`natural=water`, `waterway=stream`, etc.), which the original golf-tag-only
  loop silently skipped. Non-golf-tagged features are now also checked against `natural=water`,
  any `water=*`/`waterway=*` value, or a name containing "creek"/"stream"/"drain" — matches become
  `hazard`-type features same as `golf=water_hazard`. Polygon geometry (ponds) is used directly;
  LineString geometry (stream/creek centerlines, which is how OSM usually maps them) is buffered
  into a 3-yard-wide corridor via `turf.buffer` first, since this app's hazard model is
  polygon-only — a guess at width, since OSM rarely records real stream widths, but good enough for
  lie detection and the proximity warning (§12). Neither bundled course's raw Overpass export
  happens to contain a *non-golf-tagged* water feature (their ponds are already tagged
  `golf=water_hazard`), so this has no visible effect on Tarandowah/Innerkip today — verified
  correct via a synthetic Overpass FeatureCollection instead; matters for future course imports.
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
  default than "whichever happened to be seeded first." The selector dropdown itself only renders
  pre-round (`!round`) — it's a setup-time control, not something you'd want to fiddle with mid-hole.
  Since `startRound()` creates the `Round` row with `status: "in_progress"` from the moment it
  resolves, `round` transitions `null` → non-null at exactly "round starts," so this one gate
  already covers "hide once the round is active" without needing a separate status check.
- **Re-seeding on a fix**: `seedBundledCourses()` has two independent triggers for wiping and
  re-importing an already-present bundled course, since neither alone catches every case a fix
  might need: (1) zero tee boxes present (detects the tee-box-fallback gap above), and (2) a
  version-keyed `localStorage` flag (currently `caddyshot_reseeded_v3` — bumped from `v2` for the
  backward-centerline and expanded-water-tag parser fixes above) that unconditionally wipes
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
- Remaining round-tracking gaps: stats/SG engine, in-app course editor. Per-round pin placement,
  round review (§11), and dispersion views (§16) are done.
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
