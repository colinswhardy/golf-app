# CaddyShot Feature Upgrades: Teebox Selector, Mappings, and Spawning Limits

Implement core adjustments for teebox selection preferences, feature mapping calculations, and layup map mechanics:
1. **Teebox Selector**: Let users choose a tee set (e.g. White, Blue) when setting up the round, persisting this preference in localStorage.
2. **Backmost Tee Default**: Default course views to the backmost tee (furthest distance to the green) unless a different tee set is explicitly chosen.
3. **Green & Tee Association Fix**: Overhaul the Overpass GeoJSON importer so that green and tee features map to the closest centerline **endpoint/startpoint** rather than using generic perpendicular line distances, preventing hole-shifting bugs.
4. **Layup Line Dot Spawning & 5-Dot Limit**: Support tapping anywhere on the segmented line to spawn a new dot, capping the total number of layup dots to 5.
5. **Database Reset**: Force a re-seed of Tarandowah and Innerkip to apply these layout and mapping fixes on app start.

---

## Proposed Changes

### 1. Accurate Green & Tee Feature Mapping

#### [MODIFY] [importOverpass.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/importOverpass.ts)
* **Hole-Green End Matching**: Update the feature parser loop. If a polygon is tagged as `golf=green`, assign it to the hole whose centerline's **end coordinate** is closest to the green's centroid.
* **Hole-Tee Start Matching**: If a polygon is tagged as `golf=tee`, assign it to the hole whose centerline's **start coordinate** is closest to the tee's centroid.
* **Fallback Assigning**: Leave other general features (fairways, rough, bunkers) to map to the nearest point on the centerline as normal.

---

### 2. Teebox Selector & Backmost Tee Defaults

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Tee Name State**: Add a state for `selectedTeeName` (representing the chosen teebox set, e.g., "Blue"), initialized from localStorage.
* **Tee Dropdown Setup**: When a round is not yet active (`!round`), display a modern styled dropdown selector above the "Start Round" button, populated with all unique teebox names found on the course.
* **Active Tee Filtering**:
  - Filter `teeBoxes` for the current hole.
  - If a `selectedTeeName` is set, select the tee box matching that name.
  - If no tee matches or no selection is set, sort the tee boxes by their distance to the green centroid descending and select the **first (backmost) tee box** by default.
* **Preference Persistence**: Save the preferred tee set selection to localStorage when changed.

#### [MODIFY] [seedCourses.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/seedCourses.ts)
* **Re-seed Trigger**: Add a one-time localStorage version checker `caddyshot_reseeded_v2`. If not set, wipe the existing Dexie records for Tarandowah and Innerkip and trigger a fresh seed using the updated parser rules.

---

### 3. Segmented Line Spawning & 5-Dot Limit

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Spawning on Segmented Lines**: Update the map click listener.
  - First, verify that `measureMarkersRef.current.size < 5` to enforce the 5-dot maximum.
  - Sort the current dots to form the complete segmented path: `[origin, ...sortedDots, target]`.
  - Loop through each segment in the path. Test if the click is within the tolerance range (`ON_LINE_TOLERANCE_METERS`) of that segment.
  - If a hit is found, spawn a new draggable layup dot at that projected point and exit the loop.

---

## Verification Plan

### Manual Verification
1. **Reset Database Verify**: Verify that upon starting the app, the seeded courses are refreshed.
2. **Hole Feature Match Check**: Select Innerkip or Tarandowah, and step through holes 1 to 3. Confirm that Green 2 maps correctly to Hole 2 and Green 3 maps to Hole 3 (no coordinates pointing to the wrong green).
3. **Teebox Dropdown**: Verify a dropdown appears in the Setup view. Confirm changing the selection updates the active tee box and persists when reloading the page.
4. **Tee Defaults**: Confirm that if no tee preference is set, the map starts at the backmost tee box.
5. **Segmented Line Click Spawning**: Tap on the line to spawn a dot. Tap on the newly bent line segments to spawn more. Verify no more than 5 dots can be created.
