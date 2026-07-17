# Map Initialization Tasks

- [x] Modify Mapbox Constructor Parameters in `src/components/CourseMap.tsx`
  - [x] Calculate `initialCenter` based on `fallbackOrigin ?? initialTarget`
  - [x] Calculate `initialBearing` using `bearingDegrees(fallbackOrigin, initialTarget)`
  - [x] Calculate `initialPitch` (set to `55` if coordinates are present)
  - [x] Update the `new mapboxgl.Map(...)` properties to use these values
- [x] Verify UI & Smooth Load
  - [x] Start the Vite dev server and open a course
  - [x] Confirm the map initializes instantly centered at the first tee and facing the green with 55° tilt

## Extra fix found during verification (not in original plan)

Real-browser testing (Playwright, not just type-checking) surfaced a second bug: `RoundMapPage.tsx`
rendered `<CourseMap>` as soon as `currentHole` existed, without waiting for the `holeFeatures`/
`teeBoxes` Dexie queries backing `greenCentroid`/`fallbackOrigin` to resolve. Since `CourseMap`'s
map-init effect only runs once (on mount), it was capturing `null` for both and permanently locking
onto the flat/default-coordinate fallback — the 55° tee-facing-green camera never actually appeared
for real course data, only in the (untested) case where props happened to be ready synchronously.

Fixed by gating the `<CourseMap>` render on `greenCentroid && fallbackOrigin` directly (the derived
values) rather than on `holeFeatures !== undefined && teeBoxes !== undefined` (the query-resolved
flags) — the latter was also tried and found unreliable, since Dexie's live-query hook briefly
emits a genuinely-empty `[]` for each before converging on the real rows.
