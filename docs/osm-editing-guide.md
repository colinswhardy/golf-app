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
| Green | `golf=green` | Polygon | Must be a **closed** way. `name` is ignored entirely — see below. |
| Tee box | `golf=tee` + `teebox=<color>` | Polygon | `teebox` is the color name (`blue`, `white`, `red`, etc). If one physical tee serves multiple markers, join them with semicolons: `teebox=blue;white`. |
| Bunker | `golf=bunker` + `natural=sand` | Polygon | Greenside vs. fairway is inferred automatically (proximity to the nearest green) — no tag needed for that. |
| Rough | `golf=rough` | Polygon | Optional, but nice to have for lie detection. |
| Water hazard | `golf=water_hazard` or `golf=lateral_water_hazard` + `natural=water` | Polygon | Both map to the same "hazard" type in-app; no need to worry about getting the lateral distinction right. |
| Fringe/collar | `golf=fringe` | Polygon | Rarely mapped anywhere in OSM — nice-to-have, not expected. |

## Feature *names* are never read — don't rename anything

The importer keys off tags and geometry only. It never looks at `name` on a green, tee, fairway or
bunker, so renaming a green to "7 Green" or "Hole 7" has exactly zero effect on the import. OSM's
own community actively strips hole numbers back off these features — changeset
[146975987](https://www.openstreetmap.org/changeset/146975987) (`#GolfCleanUp`) did precisely that
across Legends of the Niagara — so such edits get reverted anyway.

What binds a green to a hole is **geometry, not a tag**. There is no "this green belongs to hole 7"
tag in the scheme and the importer wouldn't read one. Instead it projects the green's centroid onto
every `golf=hole` line, keeps the holes whose *back half* the green lands on, and takes the
perpendicular-closest (`importOverpass.ts:215`). Tee polygons work the same way against the front
half. So the `golf=hole` centerline — drawn tee→green with `ref` and `par` — is the one thing worth
getting right: fix it and the greens, tees and bunkers attach themselves.

Two geometry rules that cause silent data loss if you get them wrong:

- **Greens/tees/fairways/bunkers must be closed ways.** `importOverpass.ts:210` skips any
  golf-tagged feature that isn't a Polygon, with no warning. Overpass Turbo turns *any* closed way
  carrying a `golf=*` tag into a Polygon (`golf` is `polygon: all` in
  [osm-polygon-features](https://github.com/tyrasd/osm-polygon-features)), so no extra `landuse` or
  `area` tag is needed — but an accidentally-unclosed way vanishes.
- **`golf=hole` must stay an open line.** Direction doesn't matter; `importOverpass.ts:111`
  auto-reverses lines drawn green→tee.

## Don't bother tagging these — the app won't use them (yet)

- **Out of bounds.** There's no standard OSM tag for OB lines, and this app doesn't import them —
  you'll eventually draw OB directly in-app once the course editor exists. Mapping it in OSM now
  wouldn't help.
- **Pin position.** Changes daily — never a static OSM tag. The app handles this with a per-round
  "set today's pin" step instead.
- Cart paths, clubhouse, parking, driving range, etc. — fine to map for OSM's own sake, but this
  app ignores them.

## Multi-course facilities: export ONE course at a time

This is the biggest trap, and a plain bbox export walks straight into it.

At a 36- or 45-hole facility, OSM typically has **one** `leisure=golf_course` polygon for the whole
property and every course's holes underneath it, with `ref` numbering restarting per course. So
there are three `ref=1` ways, three `ref=2`s, and so on. The importer keys holes into a Map by `ref`
(`importOverpass.ts:103`), so **duplicates silently overwrite each other** — no warning, no error.
Import a whole-facility export and you get a Frankenstein 18 stitched from every course on site,
with greens and bunkers attached to whichever centerline happened to win.

A bounding box can't fix this when the courses interleave (they usually do). Select the holes you
want **by way ID** and pull everything near them:

```
[out:json][timeout:180];
way(id:<the 18 golf=hole way IDs for your course>)->.h;
(
  .h;
  way["golf"](around.h:50);
  way["waterway"](around.h:50);
  way["natural"="water"](around.h:50);
  way(<the leisure=golf_course boundary way ID>);
);
out geom;
```

To collect the IDs: in Overpass Turbo run `way["golf"="hole"](<bbox>);out tags center;`, then match
the `ref`/`par` sequence against the scorecard. Changeset comments are often the fastest way to tell
two courses apart — `https://api.openstreetmap.org/api/0.6/way/<id>.json` gives you the changeset,
and `.../changeset/<id>.json` its comment (that's how the two Legends 18s below were told apart).

The trailing `way(<boundary>)` matters: without a `leisure=golf_course` polygon in the export the
course imports as "Imported Course" with no location. Note the course still takes the *facility's*
name, and there's no rename in the app — `courseRepo.ts:39` derives name and slug from the parsed
boundary.

### Naming the courses at a multi-course facility

Tag every `golf=hole` way with **`golf:course:name=<course>`** — e.g. `golf:course:name=Pines`.
Each nine keeps its own `ref=1..9`; the tag is what stops three `ref=1`s colliding. The importer
then takes one course at a time (`parseOverpassGeoJson(fc, { courseName: "Pines" })`), and a bundled
entry gets a `courseName` alongside its `slug`, so one export file can supply three courses.

A note on why, because the OSM wiki disagrees. The wiki's *preferred* model is a `type=golf`
relation per course with the `golf=hole` ways as members, and it calls the per-hole tag the lesser
alternative. We cannot use the relation: it carries no geometry of its own, and Overpass Turbo's
**Export → GeoJSON only materialises relations that do** (multipolygons, boundaries), so relation
membership never survives into the file this app imports. Supporting it would mean moving the whole
pipeline off GeoJSON onto raw Overpass JSON. Tagging both is possible, but then the app follows the
tag and the relation can silently drift out of step with it.

Without the tag, an export covering more than one course still imports — but the parser now
**warns** that hole numbers appeared more than once and names the courses it found, instead of
silently handing you a Frankenstein course.

### Careful with the word "Creek" in a boundary name

`importOverpass.ts:28` treats any feature whose `name` matches `/creek|stream|drain/i` as a water
hazard, and `importOverpass.ts:206` skips only the *one* polygon it picked as the boundary. So if an
export contains two `leisure=golf_course` polygons and either is named something like "Ussher's
Creek", whichever one isn't chosen gets imported as a **course-sized water hazard**. Keep exactly
one boundary polygon per export.

## Specific gaps found in your courses

- **Tarandowah**: holes **12 and 13** have no `golf=hole` centerline at all in OSM, so the
  importer can't place them (or correctly assign their fairway/green/bunkers, which currently get
  pulled toward hole 11 or 14 instead). Adding just those two hole-line ways with `ref`/`par` would
  fix it completely.
- **Innerkip Highlands**: fully clean import, no gaps. One optional cleanup: its boundary is
  currently tagged `landuse=grass` rather than the more correct `leisure=golf_course`. The importer
  already handles this fine as a fallback, so this is a nice-to-have for OSM's own accuracy, not
  something blocking the app.
- **Legends of the Niagara** (`way/179197053`) — 45 holes across three courses sharing one boundary
  and one set of `ref` numbers. Pre-filtered exports live in `data/imports/`:
  - `usshers-creek.geojson` — hole ways `989365752`, `1089972014`, `1089976788`, `1090265431`,
    `1090284087`, `1090347545`, `1090347555`, `1090358375`, `1090361089`, `1547744712`,
    `1547744713`, `1547744714`, `1092167835`, `1092175409`, `1092181642`, `1092202045`,
    `1092210084`, `1092214551`. Complete as of 2026-08-06: 18 holes, par 72, ~7,120 yds, one green
    each, and the import raises no warnings. Holes 10/11/12 were unmapped until ways
    `1547744712`–`14` were traced; if you add more centerlines, add their IDs here too or they
    won't be in the export.
  - `legends-battlefield.geojson` — hole ways `1394241064`–`1394241065` and `1394241080`–`1394241095`.
    Complete: 18 holes, par 72, full stroke index, one green per hole.
  - The third course is the 9-hole short course (ways `1446413132`–`1446413140`, par 30), not
    exported.
  - Facility-wide gap: **none of the 175 tee polygons has a `teebox` tag**, so every tee box imports
    as a generic "Tee" with no colour. That's the most useful bulk edit for the whole property.

## After editing

Re-run your Overpass Turbo query — the same bbox query you used before, or the by-ID query above for
a multi-course facility — then **Export → GeoJSON** and re-import through Data Imports. It creates a
new version of the course rather than duplicating it, so nothing already recorded against the old
version breaks.

If you added new `golf=hole` centerlines, remember to add their way IDs to the by-ID query, or
they won't be in the export.

The import preview is worth reading rather than clicking past: hole count, per-type feature counts
and the warnings panel will tell you immediately if refs collided (fewer holes than expected) or
geometry got dropped (a green count below the hole count).
