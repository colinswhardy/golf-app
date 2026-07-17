# Enhancement & Review Tasks

- [x] Redesign Round Map Layout (Grint Style & Sleek Theme)
  - [x] Add circular white back button at top left in `src/pages/RoundMapPage.tsx`
  - [x] Implement centered slim `getHoleOrdinal(n) - Par Y - ZZZ Yards` header capsule in `src/pages/RoundMapPage.tsx`
  - [x] Pass `onDistanceUpdate` callback from `src/components/CourseMap.tsx` to `src/pages/RoundMapPage.tsx`
  - [x] Render floating right-side vertical capsule action buttons
  - [x] Replace bottom sheet triggers with a sleek bottom profile/action bar
  - [x] Add tooltips/titles to all pill buttons on the right side
- [x] Implement Bottom-Left HUD Cards
  - [x] Render Front/Center/Back green distance card in the bottom-left container in `src/pages/RoundMapPage.tsx` (remove pace/time line)
  - [x] Render Closest Water Warning card (`⚠️ Water: XXXy`) in the bottom-left container
- [x] Implement Segmented Map Lines, HUD, and Tee Box Dot
  - [x] Adjust `hudStyle` in `src/components/CourseMap.tsx` to hide or move it out of the top
  - [x] Add `teeMarkerRef` to render a white circle dot with a dark green border on the tee box in `src/components/CourseMap.tsx`
  - [x] Set `teeMarkerRef` to `draggable: true` but do not save position updates to IndexedDB (only update local state coordinates)
  - [x] Implement `updateLineAndLabels()` in `src/components/CourseMap.tsx` to sort measure markers by distance and route the line through them
  - [x] Format distance labels to read `XXXy / YYYy` where the first `XXXy` is the distance **from the previous point on the line**
  - [x] Bind `updateLineAndLabels()` to marker drag, initialization, and delete events
- [x] Water Hazards & Bunker Warnings
  - [x] Scan boundaries of water features to find the closest point to the origin/tee box coordinate in `src/components/CourseMap.tsx`
  - [x] Expose water warning distance via callback to bottom-left HUD
  - [x] Implement click handlers on bunker polygons to display Front/Middle/Back yardages in a card
- [x] Segmented Line Spawning & 5-Dot Limit
  - [x] Update map click listener in `src/components/CourseMap.tsx` to scan all path segments for tap coordinates
  - [x] Limit the total number of placed layup dots to 5 maximum
- [x] Automatic 275y Fairway Layup Points
  - [x] For holes < 300 yards or Par 3s: Do not place an automatic dot
  - [x] For holes >= 300 yards: Project a coordinate 275 yards down the centerline. If inside the fairway, place the dot there. Else, place it at the fairway point closest to the tee
- [x] Auto-Fit Viewport Zoom
  - [x] Replace constructor zoom with `fitBounds()` using bearing and paddings to position the tee near the bottom and green near the top
- [x] Implement Draggable Greens & Pin Locations
  - [x] Change `targetMarkerRef` initialization to `draggable: true` in `src/components/CourseMap.tsx`
  - [x] Bind drag listeners to update target coordinates in state and invoke `onTargetChange` callback
  - [x] Resolve active target to `pinLocation ?? greenCentroid` inside `src/pages/RoundMapPage.tsx`
  - [x] Save pin location coordinate updates to `roundHoles` table in IndexedDB via `onTargetChange` callback
- [x] Map Gesture & Touch Target Optimizations
  - [x] Set `user-select: none; -webkit-user-select: none;` globally in `src/index.css` to disable copy-paste highlighting
  - [x] Wrap visual map dots in a `44px` invisible touch target in `src/components/CourseMap.tsx`
  - [x] Apply CSS translation on drag (`:active`) to offset visual dots 55px above fingers and color them green
- [x] Migrate Custom Clubs Seed List
  - [x] Modify `ensureDefaultClubs()` in `src/lib/courseRepo.ts` to clear and re-seed the new club list
- [x] Update Shot Saving & GPS Fallback
  - [x] Remove `!lastPositionRef.current` lock from "Shot X" button in `src/pages/RoundMapPage.tsx`
  - [x] Add GPS fallback to `fallbackOrigin` and Sand Bunker distance check inside `handleSaveShot`
- [x] Overhaul Shot Logging Component
  - [x] Modify `ShotSheet` in `src/components/RoundSheets.tsx` to skip lie selection for Shot 1
  - [x] In `ShotSheet`, check if `props.detectedLie === "green"` and if so, save immediately with `"Putter"` (no club step)
  - [x] Add 2-column Lie grid and 3-column Club grid tiles
  - [x] Add click-to-transition flow (one-tap lie changes to club, one-tap club triggers instant save)
- [x] Auto-Detect Fairway Misses & Result Tracking
  - [x] Add `fairwayResult` field to `RoundHole` schema in `src/types/domain.ts`
  - [x] Auto-calculate miss direction (hit/left/right/short/long) using coordinate and line projection math when Shot 2 is logged
  - [x] Render 5-way miss selector in `src/components/RoundSheets.tsx` showing the auto-detected result as pre-selected
- [x] Right Capsule Notes Popover & Bottom Preview Snippet
  - [x] Add `notes` field to `Hole` schema in `src/types/domain.ts`
  - [x] Add `📝` notes button to the right utility pill in `src/pages/RoundMapPage.tsx`
  - [x] Render a togglable, auto-saving notes text card adjacent to the right-side capsule (ensuring no overlaps)
  - [x] Render a notes preview card at the bottom of the map screen that opens the notes popover on click
- [x] Dispersion Overlay & Settings
  - [x] Add dispersion ranges editing view to `src/pages/SettingsPage.tsx`
  - [x] Render draggable confidence ellipse overlay around green target in `src/components/CourseMap.tsx`
- [x] Correct OSM Green & Tee Polygon Mapping
  - [x] Update `parseOverpassGeoJson` in `src/lib/importOverpass.ts` to map greens to the centerline end and tee boxes to the centerline start
  - [x] Check green-centerline coordinates to auto-reverse backward-drawn OSM lines in `src/lib/importOverpass.ts`
  - [x] Update `parseOverpassGeoJson` to generate fallback tee boxes from centerline starts for courses without tee polygons
  - [x] Expand water hazard query tags in `src/lib/importOverpass.ts` to scan waterway, natural=water, streams, creeks, and drains
- [x] Implement Teebox Selector UI & Backmost Default
  - [x] Add `selectedTeeName` state and persistent localStorage key in `src/pages/RoundMapPage.tsx`
  - [x] Render a dropdown selector in the round setup view for selecting teebox sets (excluding generic "Tee" if color sets exist)
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
  - [x] Verify segment distance logic, touch offsets, auto-putter green bypass, fairway miss logger, and hole notes popover

## Extra notes from this turn's verification

- Bumped the reseed migration key to `caddyshot_reseeded_v3` so existing installs pick up the
  expanded water tags and centerline auto-reversal — both are parser-time fixes that only take
  effect on a fresh import.
- The two bundled courses' raw Overpass exports don't happen to contain any water feature tagged
  only as `natural=water`/`waterway=*` without an accompanying `golf=water_hazard` tag — so the
  expanded water-tag detection has no *visible* effect on Tarandowah/Innerkip today (hazard count
  unchanged at 5). Verified correct anyway via a synthetic unit test (`npx tsx` against a fake
  Overpass FeatureCollection with a `waterway=stream` LineString and a bare `natural=water`
  polygon, neither carrying a `golf=*` tag) — both were correctly classified as `"hazard"`
  features. This will matter for future course imports.
- Centerline auto-reversal verified the same way: a synthetic backward-drawn line (`[green-end,
  tee-end]` instead of `[tee-end, green-end]`) with no `golf=tee` polygon (forcing tee-box
  synthesis from the centerline's start) produced a tee box at the *real* tee coordinate, not the
  green end — confirming the reversal ran before that synthesis step.
- fitBounds' framing under a tilted (pitch 55°) camera doesn't put the tee flush against the very
  bottom edge the way a flat 2D map's padding would — Mapbox's bounds-fitting for a pitched camera
  is an approximation, not an exact per-pixel placement. Used the plan's exact padding values
  (`top:80, bottom:120, left:50, right:50`); the visible result is a clear improvement over the
  old fixed `zoom:17` (adapts to each hole's actual length) with the green consistently landing
  near the top, even if the tee isn't pinned to the literal bottom edge on every hole.
- Did not implement implementation_plan.md's "Tap-Away Dismissal" (tapping the map closes notes/
  club-grid popups) — it isn't a task.md checkbox, and no dispersion/tee/set-target pill semantics
  were renamed to match the plan's alternate icon-meaning table, for the same reason noted in
  prior turns (staying consistent with this app's actual shipped feature set, not the plan's
  illustrative one).
