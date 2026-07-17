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

## Important deviation from the plan: green/tee mapping algorithm

The plan specified matching greens/tees to the nearest hole centerline's raw **endpoint
coordinate** (last/first vertex). Implemented that literally first, then stress-tested it against
the real Tarandowah/Innerkip GeoJSON by comparing its output to the original algorithm across every
green/tee polygon in both files — **before** shipping either. Result: the literal endpoint-distance
version regressed 8+ correctly-assigned features (e.g. two Innerkip greens that are genuinely
hole 6's went from correct to reassigned to hole 7), because real course centerlines are only
2-4 vertices approximating the true fairway path — a genuinely-correct green can legitimately sit
100-300m from its own hole's literal last vertex, while an unrelated neighboring hole's raw vertex
happens to be closer by coincidence.

Replaced it with a hybrid: `nearestHoleByCenterlineHalf()` uses `turf.nearestPointOnLine` to find
where a feature projects onto EACH candidate hole's line (as a fraction 0-1 along its length), only
considers holes where that fraction is on the correct half (green → back half, tee → front half),
and picks the perpendicular-closest among those — falling back to plain nearest-whole-line if
nothing qualifies. Verified against the same real data: every case where this disagrees with the
original algorithm has the original landing at the *wrong end* of its chosen hole's line (e.g. a
"green" matched to fraction ~0.0 — right at that hole's tee, not a plausible green spot), confirming
these are genuine fixes rather than new regressions. See the code comment on
`nearestHoleByCenterlineHalf` in `importOverpass.ts` for the full reasoning.

## Notes on other scope/design calls made while executing

- **Tee dropdown option list** is the union of tee names across the *whole course* (via the
  already-existing `allTeeBoxes` query used for GPS auto-hole-select), not just the current hole's
  tee boxes — matches the plan's "all unique teebox names found on the course."
- **`caddyshot_reseeded_v2` wipes unconditionally** (not gated on the existing `courseHasTeeBoxes`
  0-tee-box check from a prior session) — a course can have tee boxes present and still have them,
  or its greens, mapped to the wrong hole, which tee-box *presence* alone can't detect.

## Extra fix found during verification (not in original plan)

Segmented-line dot spawning initially appeared broken in testing (0 dots spawned even with
geometrically-precise click coordinates). Root cause was in the **test scripts**, not the app: the
measure-dot marker's inline style (`cursor:grab`) gets serialized by the browser back out as
`cursor: grab` (with a space) once read via `getAttribute("style")`, which a substring match for
the no-space form silently missed. Confirmed the actual feature works correctly once the test
script's detection was fixed to match either form — dots increment 1 through 5 across taps at
precise on-line coordinates, and a 6th tap is correctly rejected once the cap is hit.
