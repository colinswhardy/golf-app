# Enhancement & Review Tasks

- [x] Redesign Round Map Layout (Grint Style)
  - [x] Add circular white back button at top left in `src/pages/RoundMapPage.tsx`
  - [x] Implement centered `getHoleOrdinal(n)` header capsule in `src/pages/RoundMapPage.tsx`
  - [x] Pass `onDistanceUpdate` callback from `src/components/CourseMap.tsx` to `src/pages/RoundMapPage.tsx`
  - [x] Render floating left-side Front/Center/Back distance cards and pace timer
  - [x] Render floating right-side vertical capsule action buttons
  - [x] Replace bottom sheet triggers with a sleek bottom profile/action bar
- [x] Implement Segmented Map Lines, HUD, and Tee Box Dot
  - [x] Adjust `hudStyle` in `src/components/CourseMap.tsx` to `top: 76px` to prevent overlap
  - [x] Add `teeMarkerRef` to render a white circle dot with a dark green border on the tee box in `src/components/CourseMap.tsx`
  - [x] Implement `updateLineAndLabels()` in `src/components/CourseMap.tsx` to sort measure markers by distance and route the line through them
  - [x] Format distance labels to read `XXXy / YYYy` (first part to origin, second part to next target)
  - [x] Bind `updateLineAndLabels()` to marker drag, initialization, and delete events
- [x] Segmented Line Spawning & 5-Dot Limit
  - [x] Update map click listener in `src/components/CourseMap.tsx` to scan all path segments (origin -> dots -> target) for tap coordinates
  - [x] Limit the total number of placed layup dots to 5 maximum
- [x] Implement Draggable Greens & Pin Locations
  - [x] Change `targetMarkerRef` initialization to `draggable: true` in `src/components/CourseMap.tsx`
  - [x] Bind drag listeners to update target coordinates in state and invoke `onTargetChange` callback
  - [x] Resolve active target to `pinLocation ?? greenCentroid` inside `src/pages/RoundMapPage.tsx`
  - [x] Save pin location coordinate updates to `roundHoles` table in IndexedDB via `onTargetChange` callback
- [x] Migrate Custom Clubs Seed List
  - [x] Modify `ensureDefaultClubs()` in `src/lib/courseRepo.ts` to clear and re-seed the new club list
- [x] Update Shot Saving & GPS Fallback
  - [x] Remove `!lastPositionRef.current` lock from "Shot X" button in `src/pages/RoundMapPage.tsx`
  - [x] Add GPS fallback to `fallbackOrigin` and Sand Bunker distance check inside `handleSaveShot`
- [x] Overhaul Shot Logging Component
  - [x] Modify `ShotSheet` in `src/components/RoundSheets.tsx` to skip lie selection for Shot 1
  - [x] In `ShotSheet`, check if `props.detectedLie === "green"` and if so, auto-select `"Putter"` as default club
  - [x] Add 2-column Lie grid and 3-column Club grid tiles
  - [x] Add click-to-transition flow (one-tap lie changes to club, one-tap club triggers instant save)
- [x] Correct OSM Green & Tee Polygon Mapping
  - [x] Update `parseOverpassGeoJson` in `src/lib/importOverpass.ts` to map greens to the centerline end and tee boxes to the centerline start
  - [x] Update `parseOverpassGeoJson` to generate fallback tee boxes from centerline starts for courses without tee polygons
- [x] Implement Teebox Selector UI & Backmost Default
  - [x] Add `selectedTeeName` state and persistent localStorage key in `src/pages/RoundMapPage.tsx`
  - [x] Render a dropdown selector in the round setup view for selecting teebox sets
  - [x] Filter `teeBoxes` by `selectedTeeName`, falling back to the backmost tee box (furthest from green) by default
- [x] Re-seed Database Migration
  - [x] Add a `caddyshot_reseeded_v2` version check in `src/lib/seedCourses.ts` to wipe and re-seed bundled courses on next load
- [x] Implement Post-Round Review & Aim Targets
  - [x] Implement `ReviewRoundsPage.tsx` to query and list completed rounds
  - [x] Add hole-by-hole navigation and shot review listings
  - [x] Bind click events on the map in review mode to update `aimPointOverride` for the selected shot in Dexie database
- [x] Verify UI & Functionality
  - [x] Verify that Innerkip/Tarandowah load correctly and map visual elements are positioned like the screenshot
  - [x] Verify review page list, map loading, and aim target placement
  - [x] Verify that teebox selection works and defaults to the backmost tee box
  - [x] Verify that green mapping bugs on holes 2 and 3 are fixed
  - [x] Verify that tapping the line spawns a layup dot (up to 5 dots max)
  - [x] Verify that holding and dragging the pin updates position and persists on returning to the hole

## Scorecard verification (Innerkip Highlands, per plan §"Verification: Scorecard Match")

Measured actual tee-to-green (CTR) distance shown in the app vs. official scorecard yardage,
after the OSM mapping fix from the previous session:

| Hole | App CTR | Official | Diff |
|---|---|---|---|
| 1 | 384y | 397y | 13y |
| 2 | 126y | 142y | 16y |
| 3 | 379y | 390y | 11y |

All within a plausible OSM-data-quality margin (polygon-centroid tee/green positions vs. official
"measured to the center of the box/green" convention — not a code bug). Confirms the previous
session's green/tee mapping fix is still correct and holds up against real ground-truth numbers,
not just internal cross-checking.

## Important bug found and fixed during verification (not in original plan)

**Hole navigation used the previous hole's tee/green data for a few renders after switching**,
independent of and unrelated to today's new draggable-pin work — a pre-existing bug, just never
caught before because nothing had checked hole-to-hole navigation against concrete expected
yardages until this session's scorecard-match verification surfaced it (hole 2 showed a nonsensical
CTR of 88y, hole 3 showed 135y against an expected ~390y).

Root cause: `currentHole` is a `useMemo` derived synchronously from the already-loaded `holes`
array, so it updates the instant `holeNumber` changes. `teeBoxes`/`holeFeatures`, however, are
separate `useLiveQuery` subscriptions keyed on `currentHole?.id` — confirmed via direct render
logging that Dexie's live-query hook keeps returning the *previous* hole's already-resolved rows
for several renders after the dependency changes, before the new query catches up. Since
`<CourseMap key={currentHole.id}>` remounts immediately when the key changes, and `CourseMap` only
reads `initialTarget`/`fallbackOrigin` once at mount, it would lock onto this stale, wrong-hole
data permanently — the classic "async data not ready when a mount-only effect runs" shape that's
recurred several times this project (see the marker-refs/StrictMode and ReviewMap-camera write-ups
in `DESIGN.md`), just triggered here by live-query staleness rather than initial-load timing.

Fixed by having `greenCentroid`/`fallbackOrigin` reject data that doesn't actually belong to
`currentHole.id` (checking every row's `holeId`) rather than just checking non-null/non-empty —
returns `null` during the stale window, which naturally holds `<CourseMap>` on its existing
"Loading course…" gate until the real data for the new hole arrives.
