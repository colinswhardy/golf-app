# CaddyShot Feature Overhaul: Version Badge, Fixed Viewport Hole Fit, Waypoint Labels, Custom Hazards, & Dispersion Menu Removal

This plan details the implementation of five enhancements to the CaddyShot golf application:
1. **Global Version Badge**: Displays a version number `v1.00` fixed at the bottom-right of the screen on all pages, which will be manually upversioned by `0.01` with subsequent updates.
2. **Smooth Tee Block Dragging**: Prevents the round map from auto-panning/re-centering while dragging the tee box marker, making it behave identically to waypoint (measure marker) dragging.
3. **Dynamic Waypoint Label Offset**: Offsets distance labels to the right side of the marker *only* while dragging, restoring them underneath when dropped, preventing thumbs from blocking the label.
4. **Custom Hazard Drawing (Course Editor)**: Introduces a drawing manager in the Course Editor to place point, line, or area hazards (water/creeks) on the map, buffering them to polygons to fit the schema and warning math.
5. **Fixed Viewport Hole Fit**: Replaces the fixed zoom `easeTo` re-centering with a dynamic `fitBounds` that aligns the green with the `🎯` target icon at the top (104px padding) and the tee box with the bottom of the distance HUD card (122px padding) so the hole occupies the exact same vertical space on every screen.
6. **Dispersion Side Menu Removal**: Completely deletes the `📐` button from the round map and the `clubPickerStyle` side menu of clubs.

---

## User Review Required

> [!IMPORTANT]
> **Database Geometry Constraint & Buffering**
> The Supabase database schema enforces a strict polygon constraint on the `hole_features` table (`geometry geography(polygon, 4326)`). To prevent database failures and coordinate math crashes in the app's proximity warning algorithms (which expect polygon geometries), Point and Line hazards will be automatically converted to thin Polygons using Turf.js buffering (`turf.buffer`) before insertion:
> - **Point hazards**: Buffered by 3 meters (yielding a small circle).
> - **Line hazards**: Buffered by 1.5 meters (yielding a thin creek/pond channel).
> - **Area hazards**: Saved as standard closed polygons.

---

## Proposed Changes

### 1. Global Version Badge
#### [MODIFY] [App.tsx](file:///c:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/App.tsx)
* Append a fixed, semi-transparent text element at the bottom-right of the screen:
  ```tsx
  <div style={{
    position: "fixed",
    bottom: 4,
    right: 8,
    fontSize: 10,
    color: "rgba(255,255,255,0.35)",
    pointerEvents: "none",
    zIndex: 9999
  }}>
    v1.00
  </div>
  ```

---

### 2. Smooth Tee Marker Dragging & Dynamic Viewport Alignment
#### [MODIFY] [CourseMap.tsx](file:///c:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Tee Drag Panning Fix**: 
  - Add a ref `isDraggingTeeRef = useRef(false)`.
  - Bind `dragstart` and `dragend` listeners to `teeMarkerRef` to toggle `isDraggingTeeRef.current`.
  - In the camera update effect, change the condition to:
    `if (origin && target && !isDraggingTargetRef.current && !isDraggingTeeRef.current)`
* **Waypoint Label Offset**:
  - In `addMeasureMarker`, bind `dragstart` and `dragend` listeners to the waypoint marker.
  - On `dragstart`, change `label.style` coordinates to shift it to the right:
    `label.style.top = "10px"; label.style.left = "44px"; label.style.transform = "translateY(-50%)";`
  - On `dragend`, restore default styles:
    `label.style.top = "36px"; label.style.left = "50%"; label.style.transform = "translateX(-50%)";`
* **Consistent Vertical Hole Alignment**:
  - Replace `map.easeTo` in the camera update effect with `map.fitBounds`:
    ```typescript
    const bounds = new mapboxgl.LngLatBounds();
    bounds.extend([origin.lng, origin.lat]);
    bounds.extend([target.lng, target.lat]);
    map.fitBounds(bounds, {
      bearing: bearingDegrees(origin, target),
      pitch: 55,
      padding: { top: 104, bottom: 122, left: 60, right: 60 },
      duration: 600
    });
    ```

---

### 3. Hazard Drawing in Course Editor
#### [MODIFY] [courseRepo.ts](file:///c:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/courseRepo.ts)
* **Save Hazard Feature**: Add `saveCustomHazard(holeId: string, geometry: GeoJSON.Polygon)` to write a new feature to the `holeFeatures` table and queue it in `outbox` with `zOrder = 2`.
* **Delete Hazard Feature**: Add `deleteHoleFeature(featureId: string)` to delete a custom feature by ID and queue a delete entry in `outbox`.

#### [MODIFY] [CourseEditorPage.tsx](file:///c:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/CourseEditorPage.tsx)
* **Hazard Editing State**: Add states for `drawingMode: "none" | "point" | "line" | "area"`, `drawingCoords: LatLng[]`, and temporary preview features.
* **Map Draw Preview Layer**: Setup `draw-hazard-source` and corresponding fill/outline layers on map load.
* **Existing Hazards Layer**: Setup an `existing-hazards` GeoJSON layer to render all hazards on this hole in a translucent blue styling.
* **Draw Interaction**:
  - When `drawingMode !== "none"`, clicking the map pushes the coordinate to `drawingCoords`.
  - For **Point**: Save immediately by buffering the point by 3 meters.
  - For **Line** and **Area**: Show active preview vectors on clicked vertices. Render a "Finish Drawing" button that Buffers the line by 1.5m, or closes the area polygon, and writes to IndexedDB.
* **Hazard Management UI**:
  - Render an "Add Hazard" panel with Type Selectors.
  - Show a list of current hazards with a `🗑️` delete button next to each.
* **Tee Marker Math Offset**: Add `applyTouchDragOffset` function to the editor's tee marker drag handler to align it with waypoint interaction.

---

### 4. Remove Dispersion Picker Menu
#### [MODIFY] [RoundMapPage.tsx](file:///c:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Delete Dispersion Trigger**: Remove the `📐` button from `rightPillStyle`.
* **Delete Dispersion Picker UI**: Remove the `clubPickerStyle` side menu panel JSX.
* **Clean up States/Imports**: Delete `dispersionPickerOpen`, `activeClubId`, `dispersionEllipse` state hook calls, and associated get/set code.

---

## Verification Plan

### Automated Verification
- Run `npm run build` to confirm TypeScript compiles clean without any errors.

### Manual Verification
1. **Version Number**: Verify `v1.00` appears fixed at the bottom-right of all screens, stays on top of headers/buttons, but has `pointer-events: none` so clicks pass right through it.
2. **Tee Box Dragging**: Open a round, drag the white tee marker, and verify the map stays fixed and does NOT auto-pan/spin while dragging.
3. **Waypoint Labels**: Drag a measure dot. Check that the distance label moves to the right of the dot while dragging, and snaps back centered underneath on release.
4. **Consistent Viewport Alignment**: Navigate through multiple holes. Verify that the green target is always aligned vertically with the `🎯` pill button, the tee box is aligned with the bottom of the left card, and both are centered horizontally.
5. **Hazard Drawing**: Go to Course Editor -> Choose Course -> Hole.
   - Click "Add Point Hazard". Tap map. Confirm a blue circular polygon appears. Click Save and verify it persists.
   - Click "Add Line Hazard". Click multiple points. Click "Finish" and verify it saves as a line polygon (creek).
   - Verify existing hazards render blue and can be deleted by clicking `🗑️` next to them in the sidebar list.
6. **Dispersion Panel Absence**: Open the Round Map page and verify the `📐` button and side club panel are completely gone.
