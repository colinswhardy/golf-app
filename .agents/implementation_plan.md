# CaddyShot Upgrades: Auto-Fit Map, Fairway Midpoints, Water Scans, & Drag Offsets

This plan implements:
1. **Dynamic Map Fit & Zoom**: Replaces static zoom with Mapbox `fitBounds` using bearing and pitch so that the tee box is positioned close to the bottom of the screen and the green near the top.
2. **Draggable Tees (No Memory)**: Makes the tee marker draggable to dynamically adjust the line and yardages, but resets its position when changing holes or reloading (does not write to the database).
3. **OSM Centerline Direction Correction**: Checks if the green centroid is closer to the start of the centerline than the end (indicating a backward-drawn OSM way). If so, it reverses the coordinates before parsing, fixing detection bugs on Tarandowah's Holes 1, 9, and 11.
4. **Creek, Stream, & Waterway Detection**: Expands OSM query mappings to detect stream, creek, natural water, and drainage tags as water hazards.
5. **Closest Water HUD Card**: Calculates the distance to the closest point on the boundary of any water hazard on the hole. Displays `Water: XXXy` in the bottom-left HUD card, and replaces the line label with a clean, textless exclamation point `!` marker on the hazard edge.
6. **Automatic 275-Yard Fairway Landing Dot**:
   - For Par 3s and holes < 300 yards: Do not auto-spawn any dots.
   - For holes >= 300 yards: Project a point on the centerline 275 yards from the tee. If it lands in the fairway, place the layup dot there. If not, place it at the fairway point closest to the tee.
7. **Tooltips & Tap-Away Dismissals**: Add descriptive title tooltips to all utility buttons on long-press, and let tapping the map dismiss any active popups (notes, club grids).
8. **Green Front/Center/Back Placement**: Position green distances in the bottom-left.

---

## 💊 Right-Side Vertical Utility Pill Breakdown

Long-pressing any of these buttons displays a tooltip title and description:

1. **🗺️ Map Style** (*"Toggle Map Type"*): Switch between satellite view and vector maps.
2. **🎯 Reset Pin** (*"Center Pin"*): Resets the pin back to the middle of the green.
3. **📐 Layup Ruler** (*"Target Lines"*): Toggle target measuring lines and custom dots.
4. **📝 Caddy Notes** (*"Hole Notes"*): View, edit, or save caddy notes for this hole.
5. **🏌️ Log Shot** (*"Record Stroke"*): Save your current shot's lie and club.
6. **📋 Scorecard** (*"Score Summary"*): View the full round scorecard.

---

## Proposed Changes

### 1. Auto-Reversing Centerlines & Expanded Water Tags

#### [MODIFY] [importOverpass.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/importOverpass.ts)
* **Water Tag Expansion**: Check for any tags matching `natural=water`, `water=*`, `waterway=*`, or names containing `creek`, `stream`, or `drain` and map them to `"hazard"`.
* **Direction Corrector**: Compare the distance from the green centroid to the first centerline coordinate vs. the last. If the first coordinate is closer, reverse the centerline coordinates before saving.

---

### 2. Auto-Fit viewport & Draggable Tees

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Auto-Fit viewport**: Replace static map constructor zoom with a dynamic `fitBounds` call. Position the tee near the bottom and the green near the top using vertical paddings:
  `padding: { top: 80, bottom: 120, left: 50, right: 50 }`.
* **Temporary Draggable Tee**: Initialize the tee marker with `draggable: true`. Dragging it updates `origin` state but does not write to IndexedDB.

---

### 3. Fairway landing dot (275y) & Distance Segment math

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Fairway Dot**: On Par 4/5 holes >= 300 yards:
  - Generate a point 275 yards down the centerline.
  - If inside the fairway, place the layup dot there. Else, place it on the closest fairway edge.
* **Segment Math**: Update dot labels to show segment lengths: Dot $i$'s label displays the distance from Dot $i-1$ (or origin).
* **Pointer offset**: Shift active visual dots `55px` (0.75 - 1cm) above the thumb on drag.

---

### 4. Closest Water Hazard HUD

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Closest Point calculation**: Find the closest point on the boundary of any hazard polygon to the user/origin coordinate.
* **Expose Distance**: Send this warning distance via callback to the bottom-left HUD.

---

### 5. Notes snippet and Dismiss callbacks

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Hole Notes Snippet**: Display a text snippet of the hole notes at the bottom. Tapping it opens the editor popover.
* **Tap-Away Dismissal**: Tap events on the map container close active popups.
* **Remove Pace line**: Delete the `0m · Hole X` line from the bottom-left HUD.
