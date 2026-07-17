# CaddyShot Feature Enhancements: Map Layups, Fast Logging, & Header Tweaks

Overhaul multiple core layout and tracking logic items in the CaddyShot app to implement segmented line math, fast lie-to-club selector tiles, custom club seeding, and cleaner headers.

---

## Proposed Changes

### 1. Header Cleanup & Yardage Unit

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Remove Redundant Course Name**: Delete or hide line 150 (`{course && <div style={{ fontSize: 11, opacity: 0.7 }}>{course.name}</div>}`) inside the header block.
* **Remove Floating Close Button**: Delete lines 136-138 (the floating absolute `✕` link).
* **Format Distance Unit**: Update line 148 to say `Yards` instead of `y` (e.g. `currentHole.defaultYardage ? " · " + currentHole.defaultYardage + " Yards" : ""`).

---

### 2. Robust GPS Shot Saving

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Always-Enabled Shot Button**: Remove `!lastPositionRef.current` check from the disabled attribute of the "Shot" action button (around line 188) to prevent locking the interface when indoors or before GPS lock.
* **GPS Fallback**: Update the `handleSaveShot` function to fallback to `fallbackOrigin` (tee box) if `lastPositionRef.current` is null, ensuring the shot coordinate is still saved for strokes gained baselines.

---

### 3. Map Segmented Layup Lines & Distance Indicators

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Segmented Pathing**: Change the Mapbox LineString source dataset update logic to route through all placed measure dots.
  - Sort all placed markers by their distance from `origin` (tee/GPS).
  - Create the coordinate path array: `[origin, ...sortedDots, target]`.
* **Dynamic Distance Labels**: Overhaul the distance tags on measuring dots to read `XXXy / YYYy`:
  - `XXXy` = Distance from origin (user/tee) to the dot.
  - `YYYy` = Distance from the dot to the next dot in the sorted sequence, or the green target if it is the last dot.
* **Events update**: Run the segmented line updates on marker `drag`, double-click deletion, and initialization.

---

### 4. Custom Club Seeding

#### [MODIFY] [courseRepo.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/courseRepo.ts)
* **Club Schema Reset**: Update `ensureDefaultClubs()` to check if the old default clubs (like `3 Wood` or `PW`) are loaded in the database. If so, wipe the `clubs` table to trigger a migration.
* **Seed Custom Wedge List**: Re-seed the database with the requested list:
  `Driver, 5 Wood, 4 Iron, 5 Iron, 6 Iron, 7 Iron, 8 Iron, 9 Iron, 50°, 56°, 60°, Putter`.

---

### 5. Quick-Tap Lie & Club Selector Tiles

#### [MODIFY] [RoundSheets.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/RoundSheets.tsx)
* **Fast Select Flow**: Re-architect `ShotSheet` to work in two steps:
  - **Shot 1**: Skip Lie selection entirely (auto-saves as `"tee"`). Only display Club tiles.
  - **Shot > 1**:
    1. **Step 1 (Lie Tile Grid)**: Display a 2-column grid of tiles with 6 options: `Fairway, Rough, Sand Bunker, Water Hazard, Fringe, Green`.
    2. **Step 2 (Club Tile Grid)**: Upon tapping a lie, save it to state and transition directly to a 3-column grid of Club tiles.
    3. **Instant Save**: Tapping a club instantly triggers `onSave` (no manual "Save" click needed!).
* **Bunker Resolution**:
  - Tapping "Sand Bunker" outputs `bunker_greenside` to the handler.
  - In `handleSaveShot` inside [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx), resolve `bunker_greenside` to `bunker_fairway` if the shot's distance to `greenCentroid` is greater than 40 yards.

---

## Verification Plan

### Manual Verification
1. **Club List Verify**: Open the app and verify the seeded club list has updated, replacing `3 Wood` and wedges with `5 Wood` and `50°/56°/60°`.
2. **Shot 1 Flow**: Open a round, tap "Shot 1". Verify that the lie selection step is skipped and only club tiles appear. Tapping a club should save the shot immediately.
3. **Shot > 1 Flow**: Tap "Shot 2". Verify that the 6 lie tiles appear in a grid. Tapping a lie should instantly switch to the 12-club grid. Tapping a club should save the shot immediately.
4. **Header Cleanup**: Confirm the floating `✕` button is gone, "Yards" is written out, and the course name is removed from the header.
5. **Segmented Map Lines**: Tap on the line to place a dot. Drag the dot and confirm the line breaks and follows your dot instead of passing straight to the green. Confirm the dot label reads e.g. `220y / 150y`.
