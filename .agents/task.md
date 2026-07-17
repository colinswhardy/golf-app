# Enhancement & Review Tasks

- [x] Redesign Round Map Layout (Grint Style)
  - [x] Add circular white back button at top left in `src/pages/RoundMapPage.tsx`
  - [x] Implement centered `getHoleOrdinal(n)` header capsule in `src/pages/RoundMapPage.tsx`
  - [x] Pass `onDistanceUpdate` callback from `src/components/CourseMap.tsx` to `src/pages/RoundMapPage.tsx`
  - [x] Render floating left-side Front/Center/Back distance cards and pace timer
  - [x] Render floating right-side vertical capsule action buttons
  - [x] Replace bottom sheet triggers with a sleek bottom profile/action bar
- [x] Implement Segmented Map Lines & Labels
  - [x] Add `teeMarkerRef` to render a white circle dot with a dark green border on the tee box in `src/components/CourseMap.tsx`
  - [x] Implement `updateLineAndLabels()` in `src/components/CourseMap.tsx` to route the path through drag markers
  - [x] Style labels on dots to read `XXXy / YYYy` (yards from me / yards to next target)
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
  - [x] Update `parseOverpassGeoJson` in `src/lib/importOverpass.ts` to auto-create fallback tee box coordinates from the first index of centerlines
  - [x] Update `seedBundledCourses` in `src/lib/seedCourses.ts` to wipe and re-seed courses if they have 0 tee boxes
- [x] Implement Post-Round Review & Aim Targets
  - [x] Implement `ReviewRoundsPage.tsx` to query and list completed rounds
  - [x] Add hole-by-hole navigation and shot review listings
  - [x] Bind click events on the map in review mode to update `aimPointOverride` for the selected shot in Dexie database
- [x] Verify UI & Functionality
  - [x] Verify that Innerkip/Tarandowah load correctly and map visual elements are positioned like the screenshot
  - [x] Verify review page list, map loading, and aim target placement

## Notes on scope/design calls made while executing

- **Right pill's scorecard button** shows a sheet with the *in-progress* round's scorecard so
  far (hole/par/score/+- across whichever holes have been played), not the post-round review
  page — that page only lists *completed* rounds, so an in-progress round wouldn't appear there
  yet. Reused the existing bottom-sheet pattern (`ScorecardSheet` in `RoundSheets.tsx`).
- **Player name/avatar** ("Colin"/"CH") is a hardcoded constant in `RoundMapPage.tsx` — this is a
  personal single-user app with no auth/profile system, so there's nothing to derive it from and
  no settings field exists to source it from either.
- **Map style toggle** cycles between the existing satellite style and Mapbox's `outdoors-v12`
  vector style. `CourseMap` now exports `SATELLITE_STYLE`/`OUTDOORS_STYLE` so the parent can drive
  the toggle while owning which style is "current."
- **ReviewMap is a new, separate component**, not more props bolted onto `CourseMap` — reviewing
  a completed round has a fundamentally different interaction model (fixed historical shot path,
  tap-to-set a planned aim point) than a live round (GPS-driven origin, tee-to-green line, measuring
  tool), and CourseMap is already fairly dense. Threading review-mode through it risked
  destabilizing the app's most-used, most-tested code path for comparatively little reuse.

## Extra fixes found during verification (not in original plan)

1. **React warning on the pill/tile active-state styles**: `pillButtonActiveStyle` and
   `tileActiveStyle` set `borderColor` alone while their base styles set the `border` shorthand —
   React warns about mixing shorthand/longhand for the same CSS property across re-renders ("can
   lead to styling bugs"), surfaced only once the set-target pill's actual click-to-toggle
   interaction was tested (not just typechecked). Fixed by using the full `border` shorthand in
   both active styles.
2. **ReviewMap camera never left its fallback location**: its mount effect set the camera once
   using whatever `shots`/`fallbackOrigin` happened to be on the very first render — but those
   come from async `useLiveQuery` chains in `ReviewRoundsPage` that are essentially never resolved
   yet at that point, so the camera permanently locked onto the generic `{43.55, -80.2}` fallback
   coordinates and the real shot markers/line rendered far outside the visible viewport. This is
   the same root-cause shape (async-derived data not ready at mount, in a `[]`-dep effect that
   only runs once) as two bugs fixed in earlier sessions on `CourseMap`/`RoundMapPage`. Fixed by
   adding a dedicated re-centering effect keyed on the real origin/finalPoint coordinates, using
   `jumpTo` (instant) for the first real placement and `easeTo` (animated) for subsequent changes
   — confirmed via direct IndexedDB inspection that the saved aim-point coordinates are now real
   Innerkip Highlands coordinates, not the fallback ones.
