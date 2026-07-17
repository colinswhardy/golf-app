# CaddyShot Feature Upgrades: Advanced Math, Map UX, Hole Notes, and Dispersion

Overhaul multiple complex math and UI logic flows to add segment-based layup measurements, water/bunker hazards checking, caddy notes, touch-drag optimizations, and dispersion overlays.

---

## 🧭 Concept Answers for the User

### 1. Dispersion Pattern & Ellipse Status Update
* **Current Backend**: Standard deviation and covariance calculations are complete in [geo.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/geo.ts) to construct 90% confidence ellipses from recorded shots.
* **This Upgrade Plan**: We are defining the UI layers:
  1. **Map Overlay**: Draws a shaded 90% confidence ellipse around your target pin (or aim point), showing where your shots will land. You can drag this overlay around to find the safest aim path.
  2. **Settings Customization**: A Settings page where you can edit your manual dispersion parameters (e.g. 7-Iron dispersion: ±10 yards long/short, ±8 yards left/right) and toggle between your manual values vs. real app-recorded data.

### 2. Fast-Response Touch Dragging & Offsets
To prevent your thumb from blocking the dot you are positioning:
* We wrap the visual dot (`16px`) in an invisible `44px` touch target.
* When active (`:active`), the visual dot pops up **30px above your finger** and turns green so you can see exactly where it is being placed.
* Text copy/pasting selection is disabled globally (`user-select: none`) to prevent accidental popups on double-taps.

---

## Proposed Changes

### 1. Segment-to-Segment Layup Math

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* Update `updateLineAndLabels()` to calculate segment-to-segment distances:
  - First dot distance: from `origin` (tee/GPS) to Dot 1.
  - Second dot distance: from Dot 1 to Dot 2 (instead of Tee to Dot 2).
  - Dot $i$ distance: from Dot $i-1$ to Dot $i$.

---

### 2. Clean Teebox Options

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Exclude generic "Tee"**: When populating the teebox dropdown, if there are specific color sets available (e.g., `Blue`, `White`, `Gold`), filter out the generic `"Tee"` option. If no color sets are available, fallback to `"Tee"`.

---

### 3. Hazard & Bunker Distance Checks

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Water Intersection Check**: Test if the current aim line crosses any water features (`featureType: "hazard"`).
  - Use `@turf/line-intersect` to find the crossing points.
  - Find the closest intersection to the user and draw a warning label on the map and HUD: `Water: XXXy`.
* **Bunker Front/Middle/Back Card**:
  - Add click handlers on bunker polygons (`bunker_greenside`, `bunker_fairway`).
  - When clicked, calculate and display Front (closest boundary point to user), Middle (centroid), and Back (furthest boundary point) distances in a floating capsule.

---

### 4. Fast Green-Putter Logging & Fairway Misses

#### [MODIFY] [RoundSheets.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/RoundSheets.tsx)
* **Instant Green Save**: If you tap "Green" as the lie (or if it is auto-detected), immediately trigger `onSave` with `"Putter"` and close the sheet (0 clicks in club selection).
* **Fairway Miss Selector**: On the hole scoring sheet (for Par 4+ holes), render a 5-way selector: `🎯 Hit | ⬅️ Left | ➡️ Right | ⬇️ Short | ⬆️ Long` and save it to the `RoundHole` object.

---

### 5. Persistent Per-Hole Caddy Notes

#### [MODIFY] [domain.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/types/domain.ts)
* Add `notes?: string | null` to the `Hole` interface.

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Notes Card**: Render an expandable notes tile in the header.
* **Notes Auto-Save**: Save notes directly to the `Hole` row in Dexie when modified, so they load automatically the next time you play the course.

---

### 6. Dispersion Map Overlay & Settings

#### [MODIFY] [SettingsPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/SettingsPage.tsx)
* Build a table of clubs showing columns for **Manual Dispersion** (Front/Back Range, Left/Right Range) and **Actual Dispersion** (calculated from recorded shots). Let users edit these ranges and select which data source to use.

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* Draw a semi-transparent, draggable ellipse overlay centered on your target pin. Rotate and scale the ellipse based on the active club's dispersion metrics.

---

## Verification Plan

### Manual Verification
1. **Green Auto-Putter**: Verify tapping "Green" instantly logs the shot and closes the selector.
2. **Notes Persistence**: Open Hole 1, type a note, refresh the page, and confirm it is still there.
3. **Segment Yardages**: Confirm dot labels show segment lengths (e.g. Tee to Dot 1 is 220, Dot 1 to Dot 2 is 100).
4. **Touch Drag Offset**: Drag a map dot. Verify the visual circle shifts 30px above your thumb and turns green.
