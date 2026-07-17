# CaddyShot Core Overhauls: Map Fixes, Auto-Putter, and OSM Mapping Rules

This plan addresses:
1. **HUD Overlap Fix**: Moves the Mapbox HUD distance overlay below the absolute header.
2. **Auto-Select Putter on Green**: Automatically defaults the club to Putter when the ball lies on the green, reducing logging friction to a single tap.
3. **OSM Tee Box fallback**: Automatically derives fallback tee box coordinates from the start point of `golf=hole` centerlines if no `golf=tee` polygons exist in the imported data (fixing Innerkip and Tarandowah loading issues).
4. **Tee Box Visual Marker**: Adds a distinct tee box dot on the map at the hole's origin so the line doesn't start from empty space.
5. **GPS Logging Explanation**: Explains how GPS auto-saving coordinates are captured at the start of each shot.
6. **OpenStreetMap Mapping Guidelines**: Documents the OSM tag structure required for custom imports.

---

## 🧭 Concept Answers for the User

### 1. GPS Auto-Saving: Start vs End Coordinates
The app auto-saves coordinates at the **start** of each shot (i.e. where you hit the ball from):
* When you log **Shot 1**, it records your location on the tee box as the `startPoint` of Shot 1.
* When you log **Shot 2**, it captures your current coordinate (where the ball landed) as the `startPoint` of Shot 2, and automatically updates the `endPoint` of Shot 1 to match it.
* When you **Hole Out**, it captures the green pin location as the `endPoint` of your final shot.

### 2. Why the Tee Line and Dot Weren't Displaying
Because the imported GeoJSON files for **Innerkip** and **Tarandowah** did not contain explicit `golf=tee` polygon features. Without them:
* The database had no tee box coordinates (`fallbackOrigin` was `null`).
* The map did not know where the tee was, so it defaulted to centering on the green, could not calculate the rotation bearing from tee to green, and could not draw a line.
* **The Fix**: We will update the parser to automatically generate a fallback tee box using the **first coordinate of the hole centerline** if no tee polygon is found.

---

## Proposed Changes

### 1. HUD Positioning & Overlap Fix

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **HUD Styles**: Update `hudStyle` at the bottom of the file to use `top: 76px` instead of `top: 12px`, placing it cleanly below the header.
* **Tee Box Marker**: Add a `teeMarkerRef` state. If `fallbackOrigin` is present, create a white circle marker with a dark green border at `fallbackOrigin` and add it to the map.
```typescript
// Tee marker design style
"width:12px;height:12px;border-radius:50%;background:#ffffff;border:3px solid #2f5c3d;box-shadow:0 0 4px rgba(0,0,0,.4);"
```

---

### 2. Auto-Select Putter on Green

#### [MODIFY] [RoundSheets.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/RoundSheets.tsx)
* **Auto-Putter**: In `ShotSheet`, check if `props.detectedLie === "green"`. If so:
  - Initialize the selector state step directly to `"club"`.
  - Automatically highlight the `"Putter"` club as selected. Tapping it (or any other club) instantly logs and saves.
  - If a user changes the lie from "Green" to another lie, reset the auto-selected club.

---

### 3. OSM Centerline-to-Tee Fallbacks

#### [MODIFY] [importOverpass.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/importOverpass.ts)
* **Parser Fallback**: In `parseOverpassGeoJson()`, after processing polygon tee boxes, loop through holes 1 to `maxHoleNumber`. If a hole does not have a tee box assigned, check if it has a centerline (`golf=hole` LineString). If so, extract the first coordinate of the LineString and add it as a fallback tee box coordinate.

#### [MODIFY] [seedCourses.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/seedCourses.ts)
* **Database Seed Migration**: In `seedBundledCourses()`, add a check for existing courses. If an existing bundled course has **0 tee boxes** in the database, wipe the course version and associated records from Dexie so it re-seeds from the updated GeoJSON parser on next load.

---

## 🛠️ OpenStreetMap (OSM) Tagging Guidelines

To ensure your custom course imports work perfectly, map them in OpenStreetMap using the following tagging structure:

| Feature | OSM Tag Requirement | Geometry Type | Notes |
| :--- | :--- | :--- | :--- |
| **Course Boundary** | `leisure=golf_course` | Polygon / Relation | Must include a `name=*` tag. |
| **Holes Centerline** | `golf=hole` | LineString | **CRITICAL**: Must include `ref=<number>` (e.g. `ref=1`) and `par=*`. The first node represents the tee box, and the last node represents the green. |
| **Tee Boxes** | `golf=tee` | Polygon | Name by adding `teebox=blue;white`. Placed at the start of the centerline. |
| **Greens** | `golf=green` | Polygon | Placed at the end of the centerline. |
| **Fairways** | `golf=fairway` | Polygon | Drawn along the hole path. |
| **Fringe / Apron** | `golf=fringe` | Polygon | Surrounding the green. |
| **Sand Bunkers** | `golf=bunker` | Polygon | Classified as greenside if within 30 yards of a green. |
| **Water Hazards** | `golf=water_hazard` | Polygon | Represents lakes, ponds, or lateral hazards. |
