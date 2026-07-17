# CaddyShot Upgrades: Auto-Fairway Stats, Slim Headers, Touch Offsets, and Map Biling

This plan implements:
1. **Slim Capsule Header**: A single-line centered pill formatted as `Xth - Par Y - ZZZ Yards` with no emojis/icons.
2. **Auto-Detect Fairway Misses**: Automates fairway stats by testing if the landing coordinate of Shot 1 (start of Shot 2) is inside the fairway polygon. If not, it uses offline/downrange projection math in [geo.ts](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/lib/geo.ts) to classify it as `left / right / short / long` automatically, displaying it on the scorecard sheet with manual override buttons.
3. **Map Touch Offset (`55px`)**: Increases the translation offset of active markers to `55px` above your thumb when dragging.
4. **Bottom Notes Snippet**: Displays a small preview of the caddy notes at the bottom of the map screen if notes exist. Tapping this snippet automatically triggers the Notes editor popover.
5. **Unified Sleek Aesthetic**: Overhauls the app's visual style with pitch-black backgrounds, high-contrast typography, and thin dark-green borders.
6. **Map Biling Guide**: Confirms Mapbox API costs and explains why interactions are free.

---

## 💸 Mapbox API Biling & Usage Clarification
Mapbox GL JS charges based on **Map Loads** (sessions), not per-interaction:
* **Billed once**: A single load session is billed when the map container is initialized on the page.
* **100% Free client-side actions**: Changing holes, panning, zooming, dragging pins, and drawing layup lines are handled locally inside WebGL on your device's GPU. **No additional API requests or billing charges are generated during these actions.**

---

## Proposed Changes

### 1. Slim Capsule Header & Visual Clean-up

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Clean Capsule Header**: Replace the header block. It should render a single-line text block formatted as `Xth - Par Y - ZZZ Yards` (using `getHoleOrdinal(n)`). Remove all emojis.
* **Premium Sleek Theme**: Apply pitch-black styles (`#000000`) to background containers, and introduce thin emerald green styling borders.

---

### 2. Auto-Detect Fairway Hit/Miss

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Auto-Calculate Miss Direction**: On Par 4 and Par 5 holes, when Shot 2 is logged:
  - Check if the Shot 2 start coordinate is inside the fairway polygon feature. If yes, auto-detect as `"hit"`.
  - If no, use `toDownrangeOffline()` to compute the offset relative to the tee-to-green target line:
    * `offlineYards > 0` -> `"right"`
    * `offlineYards < 0` -> `"left"`
    * `downrangeYards` too short/long relative to fairway bounds -> `"short"` / `"long"`.
  - Save this auto-detected value to the `fairwayResult` column on the `RoundHole` object.
* **Scorecard Override**: Render the fairway miss selector in the hole finishing sheet showing the auto-detected result pre-selected, allowing the user to override it.

---

### 3. Drag Offset & Text Copy Locks

#### [MODIFY] [CourseMap.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/components/CourseMap.tsx)
* **Offset Translate**: Set the active visual dot styling to shift `55px` above the thumb (`transform: translateY(-55px) scale(1.25)`).

#### [MODIFY] [index.css](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/index.css)
* **Disable User Selection**: Add `user-select: none; -webkit-user-select: none;` to the body element to prevent text selection overlays on mobile double-taps.

---

### 4. Bottom Notes Snippet

#### [MODIFY] [RoundMapPage.tsx](file:///C:/Users/Colin%27s%20PC/Documents/Projects/golf-app/src/pages/RoundMapPage.tsx)
* **Notes Snippet Card**: If a note is saved on the active `Hole` object, display a small horizontal preview card at the bottom of the map view (e.g. `📝 Notes: Always take 1 more...`).
* **Click to Edit**: Tapping the preview card sets `showNotesPopover` to `true` to open the notes editor card. Position the notes editor card on the right so it doesn't overlap the HUD.

---

## Verification Plan

### Manual Verification
1. **Touch Drag Offset**: Drag a map dot. Verify the visual circle shifts `55px` above your thumb.
2. **Auto-Fairway Miss**: Place Shot 2 in the rough. Open the scorecard sheet and verify the miss direction (e.g. Left/Right) is pre-selected.
3. **Notes Preview**: Write a note on Hole 1. Close it, and verify the preview bar appears at the bottom. Tap the preview bar to open the editor.
4. **Header Cleanliness**: Confirm the header says e.g. `1st - Par 4 - 397 Yards` with no emojis.
