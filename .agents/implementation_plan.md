# CaddyShot Overhaul: Grint-Style Map UI, Post-Round Aim targets, & OSM Retrieval

This plan details:
1. **OSM Retrieval Instructions**: Guide on how to export and import the user's favorite local courses using Overpass Turbo.
2. **Grint-Style UI Redesign**: Adapts [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx) to match the layout of the popular Grint app.
3. **Post-Round Review & Aim Targets**: Implements [ReviewRoundsPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/ReviewRoundsPage.tsx) to allow review of completed rounds and option to place/save custom `aimPointOverride` targets.
4. **Dispersion ellipse status report**: Reviews state of shot dispersion features.

---

## 📋 OSM Retrieval Guide for Favorite Courses

To get detailed data for **Granite Ridge**, **Mount Nemo**, **Savannah Golf Links**, and **Victoria Park East**:

1. Open [Overpass Turbo](https://overpass-turbo.eu/) in your browser.
2. Search for the course name (e.g. "Granite Ridge Golf Club, Milton") to center the map on the course.
3. Paste the following query into the left code editor:
   ```query
   [out:json][timeout:25];
   (
     nwr["leisure"="golf_course"]({{bbox}});
     nwr["golf"]({{bbox}});
   );
   out body;
   >;
   out skel qt;
   ```
4. Click **Run** at the top left to load the vectors on the map.
5. Click **Export** -> **download as GeoJSON**.
6. Open your local CaddyShot app, navigate to **Data Imports**, and upload the file. It will automatically parse holes, greens, and fallback tee boxes!

---

## 🎯 Dispersion ellipse status
* **Math module**: Complete. The covariance matrix formulas and confidence ellipse coordinates are fully coded in `computeDispersionEllipse` inside [geo.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/geo.ts).
* **UI layer**: Missing. No charts or map overlays currently call this function. A dispersion ellipse visualization task is added to the checklist.

---

## Proposed Changes

### 1. Grint-Style Round Map Redesign

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
Redesign the layout to match the provided layout photo:
* **Floating Header Capsule**: Centered top pill containing:
  - Navigation arrows: `<` and `>` on left and right.
  - Large Ordinal Hole (e.g., `⛳ 1ST`, `⛳ 2ND`) using a `getHoleOrdinal(n)` helper.
  - Subtitle inside: `Par X · YYY Yards`.
* **Top Left Back Button**: White circular button floating on the top left with a black back arrow (`←`).
* **Left Floating Green Card**: Displays distance to the center, back (+15 yards), and front (-15 yards) in a green capsule vertically stacked above a small pace timer (`0m · Hole X`).
* **Right Floating Utility Pill**: Vertical capsule containing controls for setting/moving targets, toggling map styles, and reviewing scorecard.
* **Bottom Profile & Score Bar**: Dark bar spanning the bottom containing:
  - User initials circular avatar `CH` and name `Colin`, along with current round relative score (e.g., `E (0)`).
  - Clean action buttons for recording shots: `🏌️ Shot X` and `🏁 Hole Out`.

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **HUD Distance Callback**: Expose an `onDistanceUpdate?: (dist: number | null) => void` callback so the parent page can display center, back, and front yardages in the left-hand capsule.
* **Measure Dot Distance Labels**: Render the segmented distance labels directly on the measure markers (`XXXy / YYYy`) in a stylish black capsule.

---

### 2. Post-Round Review & Planned Aim Points

#### [MODIFY] [ReviewRoundsPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/ReviewRoundsPage.tsx)
Build a full-featured post-round review workspace:
* **Round List View**: Displays all completed rounds stored in `db.rounds` with name and date. Clicking one enters review mode.
* **Hole-by-Hole review**: Let users step through holes 1 to 18.
* **Map integration**: Load `<CourseMap>` for the selected hole in review mode, rendering the line segments of all shots recorded on this hole.
* **Aim Target Setter**: Under the map, list all shots. Include a toggle "🎯 Set Aim Target" next to each. If toggled, clicking the map sets the planned coordinate (`aimPointOverride`) for that shot in IndexedDB, which displays as a target icon on the map.

---

## Verification Plan

### Manual Verification
1. **Grint Layout Checks**: Verify the page has a centered header capsule, top-left back button, left-side front/center/back distance capsules, right-side utility panel, and bottom profile bar.
2. **Review Mode Aim Points**: Go to "Review Rounds", select a completed round. Step through a hole, click "Set Aim Target" for a shot, tap the map, and confirm the target is saved and displayed.
