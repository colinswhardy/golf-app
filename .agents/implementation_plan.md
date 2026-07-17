# Map Positioning & Orientation Overhaul (Tee-at-Bottom & First Tee Focus)

Improve the initial loading behavior of the Mapbox satellite map when a course is selected. Currently, the map initializes top-down (North-up, 0° pitch) centered on the green before easing to the tee. This plan modifies the map initialization to center immediately on the first tee box, tilted and rotated towards the green.

---

## Proposed Changes

### [Course Map Component]

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
Update the Mapbox map constructor inside the `useEffect` initialization block to:
1. **Initial Center**: Center on the `fallbackOrigin` (the selected tee box) instead of the target green centroid.
2. **Initial Bearing**: Compute the bearing from the tee box to the green centroid (`bearingDegrees(fallbackOrigin, initialTarget)`) and set it as the constructor's initial `bearing`.
3. **Initial Pitch**: Set the constructor's initial `pitch` to `55` degrees (matching the requested tilted orientation).
4. **Fallback logic**: If tee box coordinates are missing (e.g. in demo mode), degrade gracefully to a default location with 0° pitch and 0° bearing.

```typescript
// Proposed constructor parameters:
const initialCenter = fallbackOrigin ?? initialTarget ?? { lat: 43.55, lng: -80.2 };
const initialBearing = fallbackOrigin && initialTarget ? bearingDegrees(fallbackOrigin, initialTarget) : 0;
const initialPitch = fallbackOrigin && initialTarget ? 55 : 0;

const map = new mapboxgl.Map({
  container: containerRef.current,
  style: "mapbox://styles/mapbox/satellite-streets-v12",
  center: [initialCenter.lng, initialCenter.lat],
  zoom: 17,
  pitch: initialPitch,
  bearing: initialBearing
});
```

---

## Verification Plan

### Manual Verification
1. **Initialize Map**: Navigate to the Courses page and click on a course (e.g., Innerkip Highlands).
2. **First Tee View Check**: Verify that when the map screen opens, it does not do a rotating animation. Instead, it should start immediately focused on the **1st Tee box**, facing towards the green with a **55-degree tilted camera pitch**.
3. **Demo Mode Stability**: Select "Preview demo round map view" and verify the map loads without errors at the fallback coordinate with normal flat pitch.
