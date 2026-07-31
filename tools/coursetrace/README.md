# coursetrace

Builds course geometry from satellite imagery, for courses OpenStreetMap doesn't have. The normal
path is `docs/osm-editing-guide.md` — use this only when there is genuinely nothing in OSM to
export (see `docs/victoria-park-valley.md` for the case this was written for).

Not part of the app build. Python 3 + `pillow`, `numpy`, `scipy`.

## Use

Put a Mapbox token in `token.txt` next to the scripts (gitignored) (a public `pk.` token is fine — it only
fetches tiles).

```
python3 fetchmap.py OUT ZOOM MINLAT MINLON MAXLAT MAXLON [gridstep_deg]
```

Stitches `mapbox.satellite` tiles for the bbox into `OUT.png`, plus `OUT.json` holding the affine
transform so pixel coordinates convert back to lat/lng. Pass a grid step to overlay labelled
lat/lon lines. Tiles are cached in `tilecache/`, so re-running at a different crop is cheap.

Zoom 16 ≈ 0.87 m/px (whole course), 17 ≈ 0.43 (a nine), 18 ≈ 0.22 (individual holes).

```
python3 features.py OUT
```

Segments putting greens, tee pads and bunkers out of `OUT.png` and writes `OUT_feat2.json`
(lat/lng centroids) plus `OUT_map.png` with everything circled and numbered for eyeballing.

## Calibrate before trusting it

The thresholds in `features.py` were tuned against one course's imagery. Different imagery
captures differ enough in exposure to move them. Sample a few known features first — a green, a
fairway, a bunker, scrub outside the course — and check they separate on greenness
(`G − (R+B)/2`) and local texture before relying on the output. On the imagery this was built
against, greens read *darker* than fairway, so brightness alone is not a discriminator.

Over-generate and prune. Getting ~32 candidates for 27 real greens is a good outcome; tightening
the filters until the count matches exactly will drop real greens. Adjacent greens on a compact
course sit 40–70 m apart, which is also how far apart two fragments of a single split green sit,
so candidate count and spacing can't tell you which is which — confirm visually.

## What it won't do

It won't work out the routing. Hole lengths from the scorecard constrain consecutive
green-to-green distances but not nearly enough to pin an ordering (see `docs/victoria-park-valley.md`).
Read the routing off the imagery and use the card yardages to verify each traced hole.
