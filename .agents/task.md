# Enhancement & Review Tasks

- [x] Redesign Round Map Layout (Grint Style)
  - [x] Add circular white back button at top left in `src/pages/RoundMapPage.tsx`
  - [x] Implement centered `getHoleOrdinal(n)` header capsule in `src/pages/RoundMapPage.tsx`
  - [x] Pass `onDistanceUpdate` callback from `src/components/CourseMap.tsx` to `src/pages/RoundMapPage.tsx`
  - [x] Render floating right-side vertical capsule action buttons
  - [x] Replace bottom sheet triggers with a sleek bottom profile/action bar
- [x] Implement Bottom-Left HUD Cards
  - [x] Render Front/Center/Back green distance card in the bottom-left container in `src/pages/RoundMapPage.tsx`
  - [x] Render Water Warning card (`⚠️ Water: XXXy`) in the bottom-left container
- [x] Implement Segmented Map Lines, HUD, and Tee Box Dot
  - [x] Adjust `hudStyle` in `src/components/CourseMap.tsx` to hide or move it out of the top
  - [x] Add `teeMarkerRef` to render a white circle dot with a dark green border on the tee box in `src/components/CourseMap.tsx`
  - [x] Implement `updateLineAndLabels()` in `src/components/CourseMap.tsx` to sort measure markers by distance and route the line through them
  - [x] Format distance labels to read `XXXy / YYYy` where the first `XXXy` is the distance **from the previous point on the line**
  - [x] Bind `updateLineAndLabels()` to marker drag, initialization, and delete events
- [x] Water Hazards & Bunker Warnings
  - [x] Add `@turf/line-intersect` checks for water features in `src/components/CourseMap.tsx`
  - [x] Place a small circular red marker with a white exclamation mark `!` at the boundary crossing point
  - [x] Expose water intersection warning distance via callback to bottom-left HUD
  - [x] Implement hover/click handlers on bunker polygons to display Front/Middle/Back yardages in a card
- [x] Segmented Line Spawning & 5-Dot Limit
  - [x] Update map click listener in `src/components/CourseMap.tsx` to scan all path segments for tap coordinates
  - [x] Limit the total number of placed layup dots to 5 maximum
- [x] Automatic Fairway Layup Points
  - [x] Project the fairway centroid onto the centerline to find the midpoint in `src/components/CourseMap.tsx`
  - [x] Automatically place the first layup dot at this fairway midpoint on load
- [x] Implement Draggable Greens & Pin Locations
  - [x] Change `targetMarkerRef` initialization to `draggable: true` in `src/components/CourseMap.tsx`
  - [x] Bind drag listeners to update target coordinates in state and invoke `onTargetChange` callback
  - [x] Resolve active target to `pinLocation ?? greenCentroid` inside `src/pages/RoundMapPage.tsx`
  - [x] Save pin location coordinate updates to `roundHoles` table in IndexedDB via `onTargetChange` callback
- [x] Map Gesture & Touch Target Optimizations
  - [x] Set `user-select: none` globally in `src/index.css` to disable copy-paste highlighting
  - [x] Wrap visual map dots in a `44px` invisible touch target in `src/components/CourseMap.tsx`
  - [x] Apply CSS translation on drag (`:active`) to offset visual dots 30px above fingers and color them green
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
- [x] Fairway Miss Tracking
  - [x] Add `fairwayResult` field to `RoundHole` schema in `src/types/domain.ts`
  - [x] Render 5-way miss selector (`Hit | Left | Right | Short | Long`) in `src/components/RoundSheets.tsx`
- [x] Right Capsule Notes Popover
  - [x] Add `notes` field to `Hole` schema in `src/types/domain.ts`
  - [x] Add `📝` notes button to the right utility pill in `src/pages/RoundMapPage.tsx`
  - [x] Render a togglable, auto-saving notes text card adjacent to the right-side capsule
- [x] Dispersion Overlay & Settings
  - [x] Add dispersion ranges editing view to `src/pages/SettingsPage.tsx`
  - [x] Render draggable confidence ellipse overlay around green target in `src/components/CourseMap.tsx`
- [x] Correct OSM Green & Tee Polygon Mapping
  - [x] Update `parseOverpassGeoJson` in `src/lib/importOverpass.ts` to map greens to the centerline end and tee boxes to the centerline start
  - [x] Update `parseOverpassGeoJson` to generate fallback tee boxes from centerline starts for courses without tee polygons
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

- Automatic fairway layup point uses the tee→green straight line as a stand-in "centerline" (via
  `nearestPointOnSegment`), not a real OSM hole centerline — that geometry is only used transiently
  during course import and was never persisted to Dexie. Extending the schema to persist it was out
  of scope for this turn; see DESIGN.md §17 for the reasoning.
- Confirmed via real-browser screenshot: the bottom-left HUD (BACK/CTR/FRONT + pace timer +
  `⚠️ Water: XXXy`), the minimalist red "!" water marker, the notes popover next to the right pill,
  and the auto-placed fairway layup dot all render correctly together on the same hole.
- The "Target Selector Dismiss" / rename-the-pill-icons parts of implementation_plan.md's right-side
  breakdown (🎯 becoming "Reset Pin", 📐 becoming a dedicated "Ruler" toggle, 🏌️ moving into the
  pill) were not in task.md's checklist and would have broken the already-shipped dispersion-picker
  (📐) and set-target (🎯) features without a corresponding checkbox asking for that — left as-is,
  only the explicitly-requested 📝 notes button was added to the pill.
