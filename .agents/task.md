# Enhancement Tasks

- [x] Clean Up Header Layout & Formatting
  - [x] Remove redundant course name in `src/pages/RoundMapPage.tsx`
  - [x] Remove top-right absolute `✕` close button in `src/pages/RoundMapPage.tsx`
  - [x] Replace `y` distance label suffix with ` Yards` in `src/pages/RoundMapPage.tsx`
- [x] Implement Segmented Map Lines & Labels
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
  - [x] Add 2-column Lie grid and 3-column Club grid tiles
  - [x] Add click-to-transition flow (one-tap lie changes to club, one-tap club triggers instant save)
- [x] Verify UI & Functionality
  - [x] Verify all layouts, buttons, and custom club listings work

## Extra fix found during verification (not in original plan)

Real-browser testing surfaced a club-seeding data-integrity bug: `ensureDefaultClubs()` did an
unguarded read-check-write (`toArray()` then `bulkPut()`), and React's `StrictMode` double-invokes
effects in dev, so both concurrent calls saw "not seeded yet" and each wrote a full batch —
every club ended up duplicated (24 rows instead of 12). Confirmed via a direct IndexedDB read after
opening a round page fresh. Fixed by wrapping the whole check in a single `db.transaction("rw",
db.clubs, ...)` so IndexedDB serializes concurrent callers instead of letting them race. Verified
both the fresh-seed path and the legacy-list migration path (pre-seeding the old 14-club list and
confirming it gets cleared and replaced) after the fix, both correct with no duplicates.
