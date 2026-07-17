# CaddyShot Upgrades: Bottom-Left HUD, Right Notes, and Automatic Fairway Targets

This plan implements:
1. **Bottom-Left HUD Cards**: Moves the Green Front/Center/Back card and the Water Warning card to the bottom-left of the viewport.
2. **Minimalist Water Marker (`!`)**: Replaces the text warning on the map aim line with a small, clean marker containing an exclamation mark (`!`) placed right at the boundary intersection of the water hazard.
3. **Notes in Right-Side Capsule**: Moves the caddy notes text box from the header to a popover toggled by a new Notes button (`📝`) in the right-side capsule.
4. **Target Selector Dismiss**: Ensures the layup measuring panel/carpenter's square tool can be clicked to toggle it off, dismissing any active custom overlays.
5. **Automatic Fairway Layup Point**: Automatically calculates and places a layup target dot at the **geometric middle of the fairway** along the centerline when a hole is opened, allowing it to be dragged or customized as normal.
6. **Detailed Explanation of Right-Side Actions**: Explains the exact purpose of each icon in the vertical utility panel.

---

## 💊 Right-Side Vertical Utility Pill Breakdown

The vertical capsule floating on the right side of the screen contains these 6 tools:

1. **🗺️ Map Style**: Toggles between Satellite imagery (default) and standard Vector Map views to optimize path visibility.
2. **🎯 Reset Pin**: Resets the green target pin position back to the green's geometric center.
3. **📐 Layup Ruler (Carpenter's Square)**: Toggles the multi-point measuring line on and off. Clicking it a second time dismisses the ruler overlay.
4. **📝 Hole Notes**: Opens a popover where you can read, add, or edit your persistent caddy notes for the current hole.
5. **🏌️ Log Shot**: Opens the quick-tap bottom sheet for selecting lies and clubs to record your shots.
6. **📋 Scorecard**: Opens the full-round scorecard spreadsheet to view/edit scores.

---

## Proposed Changes

### 1. Bottom-Left HUD & Minimalist Water Warnings

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Water Intersection Marker**: If the aim line intersects a water feature (`featureType: "hazard"`), identify the boundary crossing coordinate using `@turf/line-intersect`.
  - Draw a small circular marker with a red background and a white exclamation mark (`!`) at that coordinate on the map.
  - Do not render any yardage text labels on the line itself.
* **Expose HUD Callbacks**: Expose `onWaterDistanceUpdate?: (dist: number | null) => void` and `onGreenDistanceUpdate?: (dist: { front: number; center: number; back: number } | null) => void` to pass these yardages to the parent container.

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Bottom-Left HUD Layout**: Render the Front/Center/Back green distance card and the Water Warning card (`⚠️ Water: XXXy`) in a stacked, translucent dark container floating on the **bottom-left** of the screen (positioned just above the bottom profile bar).

---

### 2. Right-Side Notes & Tool Toggles

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Capsule Notes Button**: Add a `📝` icon button to the right-side vertical actions pill.
* **Notes Popover**: Add a state for `showNotesPopover`. If active, display a small floating card next to the pill containing the editable notes textarea for the current hole.
* **Ruler Dismiss**: Ensure the measuring toggle state is fully dismissable when clicking the ruler tool button.

---

### 3. Automatic Fairway Layup Points

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Fairway Midpoint Projection**: During map initialization, check if there is a fairway feature (`featureType: "fairway"`).
  - Compute the centroid of the fairway polygon.
  - Project the centroid onto the centerline segment using `nearestPointOnSegment` to find the fairway midpoint.
  - Automatically initialize the first layup dot at this coordinate. This counts as one of the 5 allowed dots, which the user can drag or double-click to delete.

---

## Verification Plan

### Manual Verification
1. **Bottom-Left HUD check**: Verify that the green front/center/back card and water alerts are visible at the bottom-left of the screen and do not overlap the header.
2. **Water Marker**: Verify that if a water hazard is between you and the green, a small `!` icon is drawn on the line, and the bottom-left HUD reads e.g., `Water: 185y`.
3. **Right Notes Popover**: Click `📝` in the right pill. Verify the notes popup displays, edits, and saves successfully.
4. **Ruler Dismiss**: Click the ruler icon to activate, place a dot, and click it again to confirm it toggles off.
5. **Automatic Fairway Dot**: Open a hole (e.g. Hole 1). Confirm a layup dot is automatically placed in the center of the fairway. Verify it can be dragged.
