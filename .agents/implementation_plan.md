# CaddyShot Feature Overhaul: Mathematical Touch Offset, Setup Tees, & Map Fit

This plan implements:
1. **Mathematical Touch Drag Offset**: Overhauls marker dragging in Mapbox GL JS to use screen-to-map pixel offsets. When dragging a dot (layup or green pin):
   - We capture the pointer's screen coordinates `(x, y)`.
   - We subtract `50px` (approx. 1 cm) from the `y` coordinate to get `(x, y - 50)`.
   - We unproject this offset coordinate back to Mapbox LngLat.
   - The visual dot, target lines, distance labels, and final drop coordinate are all updated and saved at this **offset coordinate**, keeping your finger completely clear of the target area during the entire drag-and-drop interaction.
2. **Hide Teebox Selector During Round**: Displays the teebox selector dropdown in [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx) only during the pre-round setup view. Once the round starts (`round.status === "in_progress"`), the selector disappears completely.
3. **Hole viewport Auto-Fit**: Configures Mapbox `fitBounds` with vertical paddings:
   `padding: { top: 120, bottom: 180, left: 60, right: 60 }`
   This aligns the tee box close to the bottom of the screen and the green near the top, mirroring the viewport layout in your screenshot.
4. **Global Tap-Away for Club Selectors**: Ensures the shot logging club selector sheets close immediately when tapping anywhere else on the map canvas.

---

## Proposed Changes

### 1. Mathematical Drag Offsets

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Custom Drag Handler**: Implement custom drag handlers for target and layup markers:
  - On `drag`, get the cursor's current screen pixel coordinate using `map.project(e.lngLat)`.
  - Calculate the offset pixel coordinate: `const offsetPixel = [cursorPx.x, cursorPx.y - 50]`.
  - Convert back to coordinates: `const offsetLngLat = map.unproject(offsetPixel)`.
  - Update the marker's position using `offsetLngLat` and trigger line/distance recalculations at this offset point.
  - On `dragend`, set and save the final position at this offset coordinate.

---

### 2. Teebox Selector Lifecycle & Map Fit

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Tee Selector Visibility**: Render the teebox selector dropdown conditional on `!round` (or `round.status !== "in_progress"`). Once the round is active, do not render the selector.

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Viewport padding**: Set the `fitBounds` options to:
  ```typescript
  map.fitBounds(bounds, {
    padding: { top: 120, bottom: 180, left: 60, right: 60 },
    pitch: 55,
    bearing: bearingDegrees(origin, target),
    duration: 600
  });
  ```

---

### 3. Tap-Away Dismissals

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Tap-Away Callback**: Expose `onDismiss` to the `<CourseMap>` component. Inside `onDismiss`, check if a drag interaction is active; if not, close the active `ShotSheet` or notes popovers by setting their open states to `false`/`null`.

---

## Verification Plan

### Manual Verification
1. **Mathematical Drag Offset**: Drag a custom layup dot. Verify that:
   - The dot sits about 1 cm (`50px`) above your finger during the entire drag.
   - When you release your finger, the dot drops exactly at the offset coordinate, and the lines update to connect to that offset point.
2. **Tee Dropdown Lifecycle**: Open the course map. Verify the teebox dropdown is visible. Click "Start Round" and confirm the dropdown disappears from the bottom-right of the screen.
3. **Map Bounds**: Open a hole. Verify the tee box and green are positioned like the screenshot.
