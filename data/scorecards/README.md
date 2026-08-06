# Scorecard reference data

Per-hole par, stroke index and per-tee yardages for every course the app knows about, plus the
courses queued for import. Gathered from published scorecards (operator websites and PDFs first,
cross-checked against Golf Canada / mscorecard where possible); each file lists its own `sources`.

This is **reference data, not imported data**. The OSM pipeline (`docs/osm-editing-guide.md`)
supplies geometry, par and — where mappers have tagged `handicap=` — stroke index, but it carries
no per-tee yardages at all, and in practice almost no course has `teebox=` colours tagged either.
These files fill that gap for the scorecard view.

## Shape

```json
{
  "course": "...", "holeCount": 18, "par": 72, "measurement": "yards",
  "teeSets": [{ "name": "Blue", "totalYards": 6505, "par": 72, "rating": 71.5, "slope": 126 }],
  "holes": [{ "number": 1, "par": 4, "handicap": 13, "yards": { "Blue": 287, "White": 265 } }],
  "sources": ["https://..."], "notes": "..."
}
```

## Caveats worth knowing before trusting a number

- **Multi-course facilities are the weak spot.** Royal Niagara (Old Canal / Escarpment / Iron
  Bridge) and Victoria Park Valley (Valley / Pines / Lakes) are 27-hole sites, so a single 18-hole
  card here represents *one combination of two nines* — check the file's `notes` for which. The same
  care applies to Ussher's Creek, whose sister course at Legends on the Niagara is Battlefield.
- Yardages are the operator's published card. Where a course has been re-measured or re-teed since,
  the card and the OSM centerline length will disagree; the centerline is the one the app measures
  against in play.
- `par` at the top level is not always populated even where every hole carries one — sum the holes
  rather than relying on it.

Sibling directory `data/osm-survey/` holds the matching OSM data-quality audit per facility: what is
mapped, what is missing, and the `golf=hole` way IDs needed for a by-ID Overpass export.
