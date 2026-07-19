# Task List for CaddyShot Enhancements

- [x] Global Version Badge
  - [x] Add `1.0` fixed div at the bottom-right viewport in `src/App.tsx`
  - [x] Set `pointer-events: none` and opacity `0.35` so it remains unobtrusive and non-interactive

- [x] Tee Drag Panning Fix
  - [x] Add `isDraggingTeeRef` ref in `src/components/CourseMap.tsx`
  - [x] Add `dragstart` and `dragend` listeners to `teeMarkerRef` to toggle `isDraggingTeeRef.current`
  - [x] Update the camera re-centering `useEffect` condition to check `!isDraggingTeeRef.current`

- [x] Dynamic Waypoint Distance Label Offsets
  - [x] In `addMeasureMarker` within `src/components/CourseMap.tsx`, add a `dragstart` listener that styles the label to the right side (`top: 10px; left: 44px; transform: translateY(-50%)`)
  - [x] Add a `dragend` listener that restores the label style underneath the marker (`top: 36px; left: 50%; transform: translateX(-50%)`)

- [x] Consistent Viewport Hole Fit
  - [x] Replace `map.easeTo` in the camera re-centering `useEffect` in `src/components/CourseMap.tsx` with a `map.fitBounds` call
  - [x] Set `bounds` around `origin` and `target`
  - [x] Apply padding: `{ top: 104, bottom: 122, left: 60, right: 60 }` and pitch: `55` to keep the green aligned with `🎯` and the tee box aligned with the distance card bottom

- [x] Hazard Drawing in Course Editor
  - [x] Implement `saveCustomHazard` and `deleteHoleFeature` in `src/lib/courseRepo.ts`
  - [x] Add `existing-hazards` source/layers in `src/pages/CourseEditorPage.tsx` to render water polygons in blue
  - [x] Add `draw-hazard` source/layers in `src/pages/CourseEditorPage.tsx` for active drawing previews
  - [x] Build the drawing mode controls panel in the Course Editor UI (Point, Line, Area selectors, Finish/Cancel actions)
  - [x] Attach `click` handler to the Mapbox map when drawing is armed to append clicked coordinates
  - [x] On completion, buffer Point (3m) and Line (1.5m) to polygon geometries using `turf.buffer` before saving to Dexie
  - [x] Render a list of existing hazard features on the current hole with a `🗑️` delete button next to each
  - [x] Import and apply `applyTouchDragOffset` math to the tee box editor marker dragging handler so it sits 50px above the finger

- [x] Remove Dispersion Picker Menu
  - [x] Remove the `📐` button from the right-side vertical pill in `src/pages/RoundMapPage.tsx`
  - [x] Delete the `clubPickerStyle` side menu panel JSX from `src/pages/RoundMapPage.tsx`
  - [x] Remove `dispersionPickerOpen`, `activeClubId`, and `dispersionEllipse` states and their usages/cleanups in `src/pages/RoundMapPage.tsx`

- [x] Verification & Build
  - [x] Run `npm run build` (via `npx tsc -b`) to confirm there are no TypeScript compiler errors
  - [x] Verify version badge is present on all pages
  - [x] Verify dragging the tee marker in round view does not pan/spin the map
  - [x] Verify waypoint labels move to the side when dragging and return underneath on drop
  - [x] Verify holes occupy consistent vertical screen space and are centered horizontally
  - [x] Verify Point, Line, and Area hazards draw, display, delete, and save as valid polygons
  - [x] Verify the side club menu is completely removed from the round map view

## Extra notes from this turn's verification

This turn's incoming code changes (from the external planning tool) had NOT actually been
compiled or verified despite `walkthrough.md` claiming "zero errors" — `npx tsc -b` (the project's
real build, which has `noUnusedLocals`/`noUnusedParameters` on) surfaced 5 genuine errors that the
tool's own `tsc --noEmit` check apparently missed:

- `CourseEditorPage.tsx`: both `turf.buffer()` call sites (Point hazard on map click, Line hazard
  on Finish) accessed `.geometry` on the result without checking for `undefined` first — `turf`'s
  own TS typing marks `buffer()`'s return as possibly `undefined` for degenerate inputs. Fixed by
  null-checking `buffered` before use at both sites; the Line site bails out of `handleFinishDrawing`
  early (still runs the `finally` block resetting `drawingMode`/`drawingCoords`, per normal JS
  `try`/`finally` semantics) rather than assuming success.
- `RoundMapPage.tsx`: after the dispersion picker JSX was deleted, `clubPickerStyle`,
  `clubChipStyle`, and `clubChipActiveStyle` were left behind as now-unused module-level `const`
  declarations — `noUnusedLocals` flags these as build errors, not just lint warnings, in this
  project's `tsconfig.app.json`. Deleted all three; confirmed via grep no other references remained
  (`dispersionPickerOpen`, `activeClubId`, `dispersionEllipse`, `getClubDispersion`,
  `DispersionEllipseSpec` are all fully gone from the file too).

Verified end-to-end in a real Playwright-driven browser after fixing the above (build was clean
before touching the app):
- Version badge (`1.0`, `pointer-events: none`) renders fixed-bottom-right on both the home page
  and the round map page.
- The 📐 dispersion button and its chip panel are gone from the round map's right pill.
- Dragging the tee marker: map bearing measured identical before and mid-drag (no spin/pan).
- Dragging a measure dot: its label's inline style flips to `top: 10px; left: 44px;
  transform: translateY(-50%)` mid-drag and back to `top: 36px; left: 50%; transform:
  translateX(-50%)` on release — confirmed via direct DOM inspection of the label element (not the
  marker wrapper, which has its own unrelated Mapbox-managed transform).
- Course Editor: drew a Point hazard by clicking the map — confirmed a new `HoleFeature` row
  (`featureType: "hazard"`, `geometry.type: "Polygon"`, buffered ring) appeared in IndexedDB, and
  the blue circle rendered on the map. Deleted a hazard via its 🗑️ button — confirmed the total
  hazard count decremented by exactly 1 in IndexedDB. Drew a Line hazard (2 vertices + Finish) —
  confirmed it saved as a buffered `Polygon` too.
- fitBounds padding change (`{top:104, bottom:122, left:60, right:60}`) confirmed present in the
  camera re-centering effect and visually screenshotted; Mapbox's pitched-camera bounds-fitting is
  an approximation (documented in DESIGN.md §8), so exact pixel alignment with the 🎯 icon isn't
  literally pinned, matching the pre-existing caveat already noted for the initial auto-fit.
