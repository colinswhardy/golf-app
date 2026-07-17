# Enhancement Tasks

- [x] Clean Up Header Layout & Formatting
  - [x] Remove redundant course name in `src/pages/RoundMapPage.tsx`
  - [x] Remove top-right absolute `✕` close button in `src/pages/RoundMapPage.tsx`
  - [x] Replace `y` distance label suffix with ` Yards` in `src/pages/RoundMapPage.tsx`
- [x] Implement Segmented Map Lines, HUD, and Tee Box Dot
  - [x] Adjust `hudStyle` in `src/components/CourseMap.tsx` to `top: 76px` to prevent overlap
  - [x] Add `teeMarkerRef` to render a white circle dot with a dark green border on the tee box (`fallbackOrigin`) in `src/components/CourseMap.tsx`
  - [x] Implement `updateLineAndLabels()` in `src/components/CourseMap.tsx` to sort measure markers by distance and route the line through them
  - [x] Format distance labels to read `XXXy / YYYy` (first part to origin, second part to next target)
  - [x] Bind `updateLineAndLabels()` to marker drag, initialization, and delete events
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
- [x] OSM Parser Fallback & Re-seed Migration
  - [x] Update `parseOverpassGeoJson` in `src/lib/importOverpass.ts` to auto-create fallback tee box coordinates from the first index of `golf=hole` centerlines
  - [x] Update `seedBundledCourses` in `src/lib/seedCourses.ts` to wipe and re-seed bundled courses if they currently have 0 tee boxes
- [x] Verify UI & Functionality
  - [x] Verify that Innerkip/Tarandowah now load with tee box markers and lines to the green
  - [x] Verify HUD position, auto-putter, and segmented line drag interactions

## Extra fixes found during verification (not in original plan)

1. **Duplicate course versions**: `seedBundledCourses()` is called from a fire-and-forget mount
   effect in `App.tsx`, and React StrictMode double-invokes effects in dev — two concurrent calls
   both saw "course not present yet" and each imported it, and `saveImportedCourse`'s copy-on-write
   versioning always creates a new version rather than deduping against an identical existing one
   (correct behavior for its real use case — manual re-imports — just not for this race). Result:
   both bundled courses ended up with 2 duplicate versions (36 holes instead of 18) on every fresh
   dev load. Fixed with a single-flight promise guard around `seedBundledCourses`.

2. **Tee/target markers invisible in dev**: deeper bug, not limited to the new tee marker. Every
   marker-creating effect (blue dot, target, and the new tee marker) only creates a marker when its
   ref is `null`, otherwise repositions the existing one — but only the map-init effect's cleanup
   reset *its own* ref (`mapRef.current = null`) when StrictMode's synthetic
   mount→cleanup→mount-again cycle destroyed and recreated the map. The marker refs were never
   reset, so after the remount they pointed at markers orphaned from the dead map — the effects took
   the "reposition" branch against a marker never attached to the live map, so nothing appeared.
   `me` (GPS) accidentally dodged this since it's `null` on the very first synchronous mount, before
   StrictMode's cycle completes; `fallbackOrigin`/`target` are already real data by then (this
   task's RoundMapPage gates CourseMap's render on them), so tee/target markers hit it immediately.
   Fixed by resetting all marker refs in the map-init effect's own cleanup, alongside `map.remove()`.

3. Confirmed via direct IndexedDB inspection that Tarandowah holes 12 and 13 have **no**
   `golf=hole` centerline in the OSM source data at all (not just missing tee boxes) — the new
   parser fallback can't synthesize a tee location with nothing to derive it from. This is a real,
   pre-existing OSM data gap, already documented in `docs/osm-editing-guide.md` (which existed
   before this session). Those two holes will still show "Loading course…" until that gap is
   mapped in OSM; every other hole across both bundled courses now has a tee box.
