# Editing OpenStreetMap for this app

A quick reference for tagging golf course features in OSM so they import cleanly. This follows
OSM's existing Golf tagging scheme (the same tags already used on Tarandowah and Innerkip
Highlands) — it's also *exactly* what `src/lib/importOverpass.ts` reads, so anything tagged this
way will show up correctly next time you re-export from Overpass Turbo.

## How to edit

Go to **openstreetmap.org**, find the course, click **Edit** (opens the browser-based **iD**
editor). Trace shapes over the satellite imagery layer (iD has a built-in imagery switcher — Esri
World Imagery is usually the sharpest). For anything fiddly, **JOSM** (a downloadable editor) gives
more precise control. Save each edit with a short changeset comment (e.g. "add hole 12/13
fairways"). Edits appear on openstreetmap.org almost immediately; give it a few minutes before
re-running your Overpass Turbo query, since the Overpass mirror lags slightly behind the live
database.

## Quick reference

| App feature | OSM tag(s) | Geometry | Notes |
|---|---|---|---|
| Course boundary/name | `leisure=golf_course` + `name=...` | Polygon | Preferred tag. See note below on Innerkip. |
| Hole centerline | `golf=hole` + `ref=<1-18>` + `par=<3\|4\|5>` | Line, tee → green | `ref` and `par` are both required — without a valid `ref` the importer can't place the hole at all, and without `par` it silently defaults to 4. Add `handicap=<1-18>` (stroke index) too if you know it, though the app doesn't use it yet. |
| Fairway | `golf=fairway` | Polygon | |
| Green | `golf=green` | Polygon | |
| Tee box | `golf=tee` + `teebox=<color>` | Polygon | `teebox` is the color name (`blue`, `white`, `red`, etc). If one physical tee serves multiple markers, join them with semicolons: `teebox=blue;white`. |
| Bunker | `golf=bunker` + `natural=sand` | Polygon | Greenside vs. fairway is inferred automatically (proximity to the nearest green) — no tag needed for that. |
| Rough | `golf=rough` | Polygon | Optional, but nice to have for lie detection. |
| Water hazard | `golf=water_hazard` or `golf=lateral_water_hazard` + `natural=water` | Polygon | Both map to the same "hazard" type in-app; no need to worry about getting the lateral distinction right. |
| Fringe/collar | `golf=fringe` | Polygon | Rarely mapped anywhere in OSM — nice-to-have, not expected. |

## Don't bother tagging these — the app won't use them (yet)

- **Out of bounds.** There's no standard OSM tag for OB lines, and this app doesn't import them —
  you'll eventually draw OB directly in-app once the course editor exists. Mapping it in OSM now
  wouldn't help.
- **Pin position.** Changes daily — never a static OSM tag. The app handles this with a per-round
  "set today's pin" step instead.
- Cart paths, clubhouse, parking, driving range, etc. — fine to map for OSM's own sake, but this
  app ignores them.

## Specific gaps found in your two courses

- **Tarandowah**: holes **12 and 13** have no `golf=hole` centerline at all in OSM, so the
  importer can't place them (or correctly assign their fairway/green/bunkers, which currently get
  pulled toward hole 11 or 14 instead). Adding just those two hole-line ways with `ref`/`par` would
  fix it completely.
- **Innerkip Highlands**: fully clean import, no gaps. One optional cleanup: its boundary is
  currently tagged `landuse=grass` rather than the more correct `leisure=golf_course`. The importer
  already handles this fine as a fallback, so this is a nice-to-have for OSM's own accuracy, not
  something blocking the app.

## After editing

Re-run your Overpass Turbo query (same bbox query you used before), **Export → GeoJSON**, and
re-import through Data Imports — it'll create a new version of the course rather than duplicating
it, so nothing already recorded against the old version breaks.
