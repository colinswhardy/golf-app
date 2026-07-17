# Enhancement & Review Tasks

- [x] Redesign Round Map Layout (Grint Style & Sleek Theme)
  - [x] Add circular white back button at top left in `src/pages/RoundMapPage.tsx`
  - [x] Implement centered slim `getHoleOrdinal(n) - Par Y - ZZZ Yards` header capsule in `src/pages/RoundMapPage.tsx`
  - [x] Pass `onDistanceUpdate` callback from `src/components/CourseMap.tsx` to `src/pages/RoundMapPage.tsx`
  - [x] Render floating right-side vertical capsule action buttons
  - [x] Replace bottom sheet triggers with a sleek bottom profile/action bar
  - [x] Add tooltips/titles to all pill buttons on the right side
- [x] Implement Bottom-Left HUD Cards
  - [x] Render Front/Center/Back green distance card in the bottom-left container in `src/pages/RoundMapPage.tsx` (above the notes snippet card)
  - [x] Render Closest Water Warning card (`⚠️ Water: XXXy`) in the bottom-left container (above the notes snippet card)
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
  - [x] For holes >= 300 yards: Calculate intersection of centerline with fairway. Place dot at midpoint of the fairway polygon segment (or 275 yards down if inside fairway)
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
- [x] Auto-Detect Fairway Misses & PGA SG Result Tracking
  - [x] Add `fairwayResult` field to `RoundHole` schema in `src/types/domain.ts`
  - [x] Auto-calculate miss direction (hit/left/right/short/long) using coordinate and line projection math when Shot 2 is logged on Par 4/5 holes
  - [x] Render 5-way miss selector in `src/components/RoundSheets.tsx` showing the auto-detected result as pre-selected (bypass entirely for Par 3 holes)
- [x] Right Capsule Notes Popover & Bottom Preview Snippet
  - [x] Add `notes` field to `Hole` schema in `src/types/domain.ts`
  - [x] Add `📝` notes button to the right utility pill in `src/pages/RoundMapPage.tsx`
  - [x] Render a togglable, auto-saving notes text card adjacent to the right-side capsule (ensuring no overlaps)
  - [x] Render a notes preview card at the bottom of the map screen that opens the notes popover on click
- [x] Dispersion Overlay & Settings
  - [x] Add dispersion ranges editing view to `src/pages/SettingsPage.tsx`
  - [x] Render draggable confidence ellipse overlay in `src/components/CourseMap.tsx`. Center on the target of the shot currently being played (`dots[0]` for Shot 1, `dots[1]` for Shot 2, target green pin for Shot 3+)
- [x] Tap-Away Dismissals
  - [x] Bind static click events on map wrapper to dismiss active popups (notes popovers, club sheets) in `src/pages/RoundMapPage.tsx` without triggering on active drags/pans
- [x] Correct OSM Green & Tee Polygon Mapping
  - [x] Update `parseOverpassGeoJson` in `src/lib/importOverpass.ts` to map greens to the centerline end and tee boxes to the centerline start
  - [x] Check green-centerline coordinates to auto-reverse backward-drawn OSM lines in `src/lib/importOverpass.ts`
  - [x] Update `parseOverpassGeoJson` to generate fallback tee boxes from centerline starts for courses without tee polygons
  - [x] Expand water hazard query tags in `src/lib/importOverpass.ts` to scan waterway, natural=water, streams, creeks, and drains
- [x] Implement Teebox Selector UI & Backmost Default
  - [x] Add `selectedTeeName` state and persistent localStorage key in `src/pages/RoundMapPage.tsx`
  - [x] Render a dropdown selector in the round setup view for selecting teebox sets (excluding generic "Tee" if color sets exist)
  - [x] Filter `teeBoxes` by `selectedTeeName`, falling back to the backmost tee box (furthest from green) by default
  - [x] Ensure the teebox selection modal closes immediately upon selecting a tee set
- [x] Re-seed Database Migration
  - [x] Add a `caddyshot_reseeded_v2` version check in `src/lib/seedCourses.ts` to wipe and re-seed bundled courses on next load
- [x] Implement Post-Round Review & Aim Targets
  - [x] Implement `ReviewRoundsPage.tsx` to query and list completed rounds
  - [x] Add hole-by-hole navigation and shot review listings
  - [x] Bind click events on the map in review mode to update `aimPointOverride` for the selected shot in Dexie database
- [x] Implement In-App Course Editor
  - [x] Create `CourseEditorPage.tsx` routing and link the 4th tile in `src/pages/Home.tsx`
  - [x] Allow dragging and editing tee box locations hole-by-hole on the map, writing override changes to `teeBoxes` table
- [x] Verify UI & Functionality
  - [x] Verify that Innerkip/Tarandowah load correctly and map visual elements are positioned like the screenshot
  - [x] Verify review page list, map loading, and aim target placement
  - [x] Verify that teebox selection works and defaults to the backmost tee box
  - [x] Verify that green mapping bugs on holes 2 and 3 are fixed
  - [x] Verify that tapping the line spawns a layup dot (up to 5 dots max)
  - [x] Verify that holding and dragging the pin updates position and persists on returning to the hole
  - [x] Verify segment distance logic, touch offsets, auto-putter green bypass, fairway miss logger, and hole notes popover
  - [x] Verify Course Editor loads and edits tee boxes successfully
  - [x] Verify dispersion overlay centers on the active target segment for the current shot number
  - [x] Verify Par 3 scorecard flow skips fairway result questions completely

## Extra notes from this turn's verification

- **Real bug found and fixed**: verifying "dispersion centers on `dots[1]` for Shot 2" required
  placing two layup dots and then starting a round — doing so revealed that starting a round
  (`round` flipping `null` → non-null) briefly unmounted and remounted `CourseMap`, silently
  wiping every measure dot the player had placed pre-round. Root cause: `pinDataReady` in
  `RoundMapPage.tsx` momentarily went `false` for a render or two while `currentRoundHole`'s live
  query caught up to a `roundHoleId` the app had *already* resolved the full row for (via
  `getOrCreateRoundHole`). Fixed by seeding a `resolvedRoundHole` state with that same resolved
  row, so `currentRoundHole` never has to wait on the separate live query. Confirmed via direct
  before/after dot-count checks around the "Start round" click.
- Dispersion shot-number-aware centering (`dots[0]`/`dots[1]`/`target`) verified by placing two
  layup dots, reading the dispersion source's raw GeoJSON directly (not `querySourceFeatures`,
  which can lag a render behind a `setData()` call), and confirming exact-match distances to the
  expected point at each shot number.
- Tap-away dismissal distinguishes a genuine tap from a map pan/drag via `pointerdown`/`pointerup`
  screen-distance tracking (`TAP_MOVE_TOLERANCE_PX = 10`), not a plain `onClick` — a pan still
  ends in a native click, which would otherwise dismiss the notes popover on every pan. Verified
  both directions: a 120px drag leaves the popover open; a near-zero-movement tap closes it.
- Course Editor (new `/course-editor` + `/course-editor/:courseId` routes, `CourseEditorPage.tsx`)
  is a standalone map component, not a reuse of `CourseMap` — same rationale as `ReviewMap` in
  DESIGN.md §11. Edits are staged locally (drag updates a draft, not Dexie) until "Save"; "Clear"
  discards the unsaved drag back to the currently-persisted coordinate — there's no true "revert
  to original OSM import" since that isn't tracked separately. Verified end-to-end: dragged a tee
  marker, tapped Save, confirmed the exact coordinate changed in IndexedDB.
- Fairway layup fallback (when the fixed 275y point misses the fairway) computes the midpoint of
  the segment where the tee->green line actually crosses the fairway polygon — verified both
  branches fire across many real holes (e.g. "275y / 193y" = primary branch; "331y / 48y" =
  fallback branch, clearly not a near-the-tee placement the old "nearest edge to tee" fallback
  would have produced).
