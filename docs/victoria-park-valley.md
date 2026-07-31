# Victoria Park Valley — tracing geometry when OSM has none

Victoria Park Valley is the first course on the import list where the OSM pipeline can't supply
geometry at all. The audit in `data/osm-survey/osm-victoria-park-valley.json` has the detail and
the verdict: way `353716100` is an untagged-but-for-`leisure=golf_course` outline with **zero**
`golf=*` features inside it. Nothing to export, so nothing to import.

Confirmed again against the live Overpass API on 2026-07-31, independently of the 2026-08-06
audit — same polygon, same zero counts.

Scorecard data for all 27 holes already lives in `data/scorecards/card-victoria-park-valley.json`.
That file was read off the operator's own scorecard scan; a second independent reading of the same
scan agreed on all 135 values (par, stroke index and Blue/White/Red yardages across all 27 holes),
so it can be treated as solid.

This note only covers the part that isn't written down anywhere else: getting the **geometry**
from satellite imagery instead.

## Three nines, and which is which

The Lakes, The Pines, The Valley — each par 31, executive length. Import them with the
`golf:course:name=` scheme in `docs/osm-editing-guide.md`; refs collide otherwise, since each nine
numbers 1..9.

Identification does not have to be inferred from imagery. The club publishes its own hole-by-hole
yardage book, and every page is captioned with its nine and par:
`victoriaparkgolf.com/wp-content/uploads/2021/05/{lakes-1-4, lakes-5-8, lakes-9-pines-1-3,
pines-4-7, pines-8-9-valley-1-2, valley-3-6, valley-7-9}.jpg`. Those pages also give each hole's
shape, hazards and green depth, which is what makes them worth having when matching traced
geometry to a hole number.

**Don't cross-check the nine labels against Hole19 or golfpass.** Their "Lakes" and "Pines" cards
are the same physical nine at two different tee sets, mislabelled — every hole sits at a uniform
~9.6 % ratio to its counterpart, which is the giveaway. The club's own card and yardage book are
the authority; golfify matches them exactly.

Useful fingerprints when matching a traced loop to a card:

- Lakes `3,4,4,3,3,3,3,5,3` — the only par 5 anywhere on the property (8th, 512y)
- Pines `3,3,3,4,3,4,4,3,4` — opens with three consecutive par 3s
- Valley `4,3,3,4,3,3,4,3,4` — opens with a par 4; longest par 3 on site (8th, 181y)

## Tracing

`tools/coursetrace/` stitches Mapbox satellite tiles for a bbox and segments greens, bunkers and
water out of them. Thresholds were calibrated by sampling known features in this course's imagery
and are worth re-checking on a different course or imagery capture:

| Feature | greenness (G − (R+B)/2) | brightness | texture (local σ, 9 px) |
|---|---|---|---|
| Putting green | 46–53 | 88–113 | 1–2 |
| Fairway | ~34 | ~102 | ~20 |
| Rough / scrub | ~26 | ~65 | ~9 |
| Bunker sand | ~21 | ~152 | ~30 |
| Trees | ~47 | ~53 | varies |

Greens read *darker and more saturated* than fairway on this imagery, not brighter. The useful
discriminators are greenness and smoothness; brightness on its own is actively misleading.

## Two approaches that didn't work

Recorded so they aren't retried.

**Brightness-based green detection.** Picks up the smooth grass fields *outside* the course, which
are as uniform as a putting surface and brighter than one. The first pass put most of its
candidates in scrub beyond the boundary.

**Solving the routing arithmetically from hole lengths.** `green(N) → tee(N+1)` is a short walk and
`tee(N+1) → green(N+1)` is exactly the card yardage, so consecutive green-to-green distances are
constrained to `[L−walk, L+walk]`. It looks like it should pin the ordering. It doesn't: on a site
this compact, greens sit 42–70 m apart, so almost any pair of greens satisfies almost any hole.
Even a 35 m walk limit left thousands of zero-error orderings. Routing has to be read off the
imagery; the card yardages are then the *check* on each traced hole, which is what they're
genuinely good for.

That same 42–70 m spacing also means candidate count can't tell you when the segmenter has split
one green in two — two fragments of a single green and two adjacent greens look identical by
distance. Confirm visually.

## Status

- [x] OSM audited — nothing importable (`data/osm-survey/`)
- [x] Scorecard for all 27 holes (`data/scorecards/`), independently double-read
- [x] Nine identification established from the club's own yardage book
- [x] Imagery pipeline + green/bunker/water segmentation (`tools/coursetrace/`)
- [ ] Per-hole tee and green placement, each verified against its card yardage
- [ ] Emit GeoJSON tagged `golf:course:name=` per nine, bundle via `seedCourses.ts`
