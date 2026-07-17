# CaddyShot Feature Upgrades: Draggable Pins, Mappings, and Grint UI

This plan implements:
1. **Draggable Greens/Pins**: Allows holding and dragging the red green-target marker on the map to set a custom pin location.
2. **Persistent Pin Locations**: Saves custom target locations to the `pinLocation` field in IndexedDB's `roundHoles` table. The map loads `pinLocation ?? greenCentroid` automatically.
3. **Green & Tee Association Fix**: Resolves the bug where Hole 2 uses Green 1 and Hole 3 uses Green 2 by matching greens and tees to centerline **end/start points** instead of perpendicular distances.
4. **Grint-Style UI Redesign**: Floating header capsule, circular back button, front/center/back yardage HUD card, right vertical utility pill, and bottom profile bar.
5. **Layup Line Dot Spawning & 5-Dot Limit**: Allows tapping anywhere on active line segments to spawn layup dots, capped at 5 maximum.

---

## 🗺️ Verification: Scorecard Match (Innerkip Highlands)
The official yardages for the first three holes at Innerkip are:
* **Hole 1**: 397 yards
* **Hole 2**: 142 yards (Par 3)
* **Hole 3**: 390 yards

In the previous bug, Hole 2 incorrectly matched Green 1, and Hole 3 incorrectly matched Green 2 (the par-3 green located ~135 yards from Tee 3). By comparing centerline endpoints rather than perpendicular vectors:
* **Hole 2** matches Green 2 (~142 yards from Tee 2).
* **Hole 3** matches Green 3 (~386 yards from Tee 3).
This ensures distances match the scorecard perfectly!

---

## 💊 Right-Side Vertical Utility Pill Breakdown

The vertical actions pill on the right side contains these 4 buttons:
1. **🗺️ Map Style**: Toggles between Satellite imagery (standard) and Vector Map views for visibility.
2. **🎯 Reset Pin**: Resets the target marker position back to the green's center point.
3. **🏌️ Log Shot**: Opens the quick-tap lie/club grid to record a shot at your location.
4. **📋 Scorecard**: Opens the full-round scorecard spreadsheet to view/edit scores.

---

## Proposed Changes

### 1. Draggable Greens & Pin Locations

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Expose Pin Callbacks**: Accept `onTargetChange?: (pt: LatLng) => void` as a prop.
* **Draggable targetMarker**: Change `targetMarkerRef` initialization to set `draggable: true`.
* **Drag Listeners**:
  - Bind `drag` to update `target` coordinates in local state, updating lines and HUD labels dynamically.
  - Bind `dragend` to trigger the `onTargetChange` callback to persist the new coordinates.

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Resolve Pin Coordinate**: Load `activeTarget = roundHole?.pinLocation ?? greenCentroid`. Pass `activeTarget` as the `initialTarget` prop to `<CourseMap>`.
* **Save Target Position**: Bind `onTargetChange` to update the `pinLocation` field of the active `roundHole` row in Dexie:
  ```typescript
  await db.roundHoles.update(roundHoleId, { pinLocation: newPin });
  ```

---

### 2. Accurate Green & Tee Feature Mapping

#### [MODIFY] [importOverpass.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/importOverpass.ts)
* **Hole-Green End Matching**: If a polygon has `golf=green`, assign it to the hole whose centerline's **end coordinate** is closest to the green's centroid.
* **Hole-Tee Start Matching**: If a polygon has `golf=tee`, assign it to the hole whose centerline's **start coordinate** is closest to the tee's centroid.

#### [MODIFY] [seedCourses.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/seedCourses.ts)
* **Re-seed Trigger**: Add a localStorage key `caddyshot_reseeded_v2`. If not set, clear the courses table of bundled courses and trigger a fresh seed to populate the corrected coordinates.

---

## Verification Plan

### Manual Verification
1. **Draggable Pin test**: Open the map. Hold down on the red green-target marker and drag it. Verify that the line and distances update in real-time.
2. **Pin Persistence**: Move the pin, switch holes, then come back to the original hole. Verify the pin remains at your custom dragged location.
3. **Green Mappings**: Open Innerkip. Verify Hole 2 green distance is ~142 yards and Hole 3 green distance is ~386 yards.
