# CaddyShot Feature Overhaul: Dynamic Dispersion, Bottom HUD, & PGA SG Standards

This plan implements:
1. **Dynamic Dispersion Ellipse Centering**: Centers the dispersion overlay on the coordinate of the target you are *currently playing to*:
   - **Shot 1**: Centers on the first layup dot (if present), otherwise defaults to the green pin.
   - **Shot 2**: Centers on the second layup dot (if present), otherwise defaults to the green pin.
   - **Shot 3 / Approach**: Centers on the green pin.
2. **Strokes Gained Analytics Alignment (PGA Standard)**:
   - On **Par 3 holes** (and holes < 250 yards), disable fairway hit/miss tracking. The scorecard/hole finishing sheet will skip the fairway result question entirely, keeping your SG:Off-The-Tee (SG:OTT) and SG:Approach (SG:APP) metrics clean and PGA-standard compliant.
   - On **Par 4 and Par 5 holes**, enable the auto-detector to classify fairway hits/misses (left, right, short, long) when Shot 2 is logged, with manual overrides in the scorecard.
3. **Bottom HUD Stack & Touch Lock**:
   - The **Bottom Profile Bar** spans the very bottom.
   - The **Notes Preview Bar** sits directly above it, spanning full width.
   - The **HUD Card Stack** (Green Front/Center/Back and Water alerts) floats on the left side, starting just above the Notes bar.
   - **Tap-Away Lock**: Ensures panning or dragging the map *does not* dismiss active popups. Only explicit clicks on the empty map canvas will close overlays.
4. **Course Editor (4th Home Tile)**: Edit and override teebox locations hole-by-hole, writing changes to the `teeBoxes` table.
5. **Variable Zoom (fitBounds)**: Dynamically scales map views so the hole fits the screen perfectly every time.
6. **Automatic Fairway Midpoints**: Spawns default landing dots in the middle of fairways (for Par 4/5 holes) on load.
7. **Tooltip Pill Helpers**: Shows tooltip details for right-capsule buttons.

---

## Proposed Changes

### 1. Dynamic Dispersion Centering & PGA SG Standard

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Active target Centering**: Calculate the list of current custom layup dots sorted from the tee.
  - If `shotNumber === 1`, center the dispersion ellipse overlay on `dots[0] ?? target`.
  - If `shotNumber === 2`, center on `dots[1] ?? target`.
  - If `shotNumber >= 3`, center on `target` (the green pin).

#### [MODIFY] [RoundSheets.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/RoundSheets.tsx)
* **Par 3 Skip**: In `HoleScoreSheet`, accept `par: number` as a prop. If `par === 3`, hide the fairway miss selector tiles entirely.

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* Pass `currentHole.par` to `HoleScoreSheet`.
* In `handleSaveShot`, compute `fairwayResult` only if `currentHole.par >= 4`. If the hole is a Par 3, set `fairwayResult` to `null` to bypass off-the-tee mapping.

---

### 2. HUD Positioning, Overlaps, & Tap-Away Locks

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Left HUD Card Stack**: Position the HUD Card Stack at the bottom-left, starting above the notes snippet card.
* **Tee Selector Dismissal**: Toggling a tee set from the selection dropdown instantly toggles `showTeeSelector` off to clear the screen.
* **Tap-Away Lock**: Restrict `setOpenSheet(null)` to static, non-drag mouseup/touchend events on the empty map canvas.

#### [MODIFY] [index.css](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/index.css)
* **Disable Copy selection**: Add `user-select: none; -webkit-user-select: none;` to prevent text selection overlays on mobile double-taps.

---

## Verification Plan

### Manual Verification
1. **Par 3 Scorecard**: Start a round, go to Hole 2 (Par 3 at Innerkip). Record your shots and tap "Hole Out". Verify the "Fairway Miss" selector does not appear on the score sheet.
2. **Par 4 Scorecard**: Go to Hole 1 (Par 4 at Innerkip). Tap "Hole Out" and verify the "Fairway Miss" selector appears.
3. **Dynamic Dispersion**: Place two layup dots on the map. Verify that for Shot 1, the dispersion ellipse is centered on the first layup dot. Advance to Shot 2, and verify the ellipse shifts to the second layup dot.
4. **Bottom HUD Stack**: Verify the Front/Center/Back green card sits above the notes preview at the bottom left without overlap.
