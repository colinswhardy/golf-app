import * as turf from "@turf/turf";
import type { FeatureType, LatLng } from "../types/domain";

// Tags we recognize -> our feature_type enum. `bunker` isn't here because it
// needs the greenside/fairway heuristic (see classifyBunker below).
const DIRECT_TAG_MAP: Record<string, FeatureType> = {
  fairway: "fairway",
  green: "green",
  fringe: "fringe",
  rough: "rough",
  tee: "tee",
  water_hazard: "hazard",
  lateral_water_hazard: "hazard"
};

const GREENSIDE_BUNKER_THRESHOLD_YARDS = 30;
// Streams/creeks/drains are usually mapped as centerlines, not polygons — buffered to a thin
// corridor so they fit this app's polygon-only hazard model. Width is a guess (real width data
// isn't in OSM for most of these); good enough for lie detection and proximity warnings.
const WATERWAY_BUFFER_YARDS = 3;
const WATERWAY_NAME_PATTERN = /creek|stream|drain/i;

// Non-golf-tagged water features: OSM maps most streams/creeks/ponds without any golf=* tag at
// all, so they'd otherwise be invisible to lie detection and the water-hazard warning.
function isExpandedWaterFeature(props: any): boolean {
  if (props?.natural === "water") return true;
  if (typeof props?.water === "string") return true;
  if (typeof props?.waterway === "string") return true;
  if (typeof props?.name === "string" && WATERWAY_NAME_PATTERN.test(props.name)) return true;
  return false;
}

export interface ParsedHole {
  number: number;
  par: number;
  parInferred: boolean;
  defaultYardage: number | null;
}

export interface ParsedFeature {
  holeNumber: number;
  featureType: FeatureType;
  geometry: GeoJSON.Polygon;
}

export interface ParsedTeeBox {
  holeNumber: number;
  name: string;
  location: LatLng;
}

export interface ParsedCourse {
  name: string;
  location: LatLng | null;
  holes: ParsedHole[];
  features: ParsedFeature[];
  teeBoxes: ParsedTeeBox[];
  warnings: string[];
}

function centroidLatLng(geom: GeoJSON.Geometry): LatLng {
  const c = turf.centroid(turf.feature(geom));
  const [lng, lat] = c.geometry.coordinates;
  return { lat, lng };
}

function distanceYardsBetween(a: LatLng, b: LatLng): number {
  return turf.distance([a.lng, a.lat], [b.lng, b.lat], { units: "yards" });
}

export function parseOverpassGeoJson(fc: GeoJSON.FeatureCollection): ParsedCourse {
  const warnings: string[] = [];
  const features = fc.features;

  // --- 1. Course boundary / name ---
  const boundary = features.find(
    (f) => (f.properties as any)?.leisure === "golf_course" && (f.properties as any)?.name
  ) ?? features.find((f) => (f.properties as any)?.landuse === "grass" && (f.properties as any)?.name);

  const name = (boundary?.properties as any)?.name ?? "Imported Course";
  const location = boundary ? centroidLatLng(boundary.geometry) : null;
  if (!boundary) warnings.push("Couldn't find a course boundary feature — using a generic name and no location.");

  // --- 2. Hole centerlines (golf=hole) ---
  const holeLines = features.filter((f) => (f.properties as any)?.golf === "hole" && f.geometry.type === "LineString");

  const holeLineByNumber = new Map<number, GeoJSON.Feature<GeoJSON.LineString>>();
  let maxHoleNumber = 0;
  for (const f of holeLines) {
    const ref = parseInt((f.properties as any)?.ref, 10);
    if (!Number.isFinite(ref)) continue;
    holeLineByNumber.set(ref, f as GeoJSON.Feature<GeoJSON.LineString>);
    maxHoleNumber = Math.max(maxHoleNumber, ref);
  }
  if (maxHoleNumber === 0) {
    warnings.push("No golf=hole centerlines with a usable ref number were found — falling back to 18 holes, par 4, with no shape data.");
    maxHoleNumber = 18;
  }

  // --- 2b. Auto-correct backward-drawn centerlines: some OSM ways for golf=hole are digitized
  // green-to-tee instead of tee-to-green, which silently breaks nearestHoleByCenterlineHalf's
  // start/end-fraction matching below (green/tee end up assigned to the wrong "half"). For each
  // hole's line, find the closest green POLYGON by raw point-to-line distance (independent of any
  // half-matching, which is what we're correcting) and check whether it sits nearer the line's
  // first or last coordinate — nearer the first means the line runs green-to-tee, so reverse it.
  // Found via real data: fixes Tarandowah's holes 1, 9, and 11.
  const greenFeatures = features.filter((f) => (f.properties as any)?.golf === "green" && f.geometry.type === "Polygon");
  for (const line of holeLineByNumber.values()) {
    let closestGreen: LatLng | null = null;
    let closestGreenDistance = Infinity;
    for (const g of greenFeatures) {
      const centroid = centroidLatLng(g.geometry);
      const d = turf.pointToLineDistance(turf.point([centroid.lng, centroid.lat]), line, { units: "meters" });
      if (d < closestGreenDistance) {
        closestGreenDistance = d;
        closestGreen = centroid;
      }
    }
    if (!closestGreen) continue;
    const coords = line.geometry.coordinates;
    const firstPt: LatLng = { lat: coords[0][1], lng: coords[0][0] };
    const lastPt: LatLng = { lat: coords[coords.length - 1][1], lng: coords[coords.length - 1][0] };
    if (distanceYardsBetween(closestGreen, firstPt) < distanceYardsBetween(closestGreen, lastPt)) {
      line.geometry.coordinates = [...coords].reverse();
    }
  }

  // --- 3. Build Hole rows 1..maxHoleNumber, filling gaps where OSM has no centerline ---
  const holes: ParsedHole[] = [];
  const missingCenterlineHoles: number[] = [];
  for (let n = 1; n <= maxHoleNumber; n++) {
    const line = holeLineByNumber.get(n);
    if (!line) {
      missingCenterlineHoles.push(n);
      holes.push({ number: n, par: 4, parInferred: true, defaultYardage: null });
      continue;
    }
    const parTag = parseInt((line.properties as any)?.par, 10);
    const par = Number.isFinite(parTag) ? parTag : 4;
    const yardage = Math.round(turf.length(line, { units: "yards" }));
    holes.push({ number: n, par, parInferred: !Number.isFinite(parTag), defaultYardage: yardage });
  }
  if (missingCenterlineHoles.length) {
    warnings.push(
      `Holes ${missingCenterlineHoles.join(", ")} have no OSM centerline — created as empty placeholders (par defaulted to 4). ` +
        `Any fairway/green/bunker features that actually belong to them got approximately assigned to the nearest hole that does have a centerline; verify these manually once the course editor exists.`
    );
  }

  // --- 4. Assign every other relevant polygon feature to the nearest hole centerline ---
  const holeLineList = [...holeLineByNumber.entries()];
  function nearestHoleNumber(point: GeoJSON.Feature<GeoJSON.Point>): { number: number; distanceMeters: number } | null {
    let best: { number: number; distanceMeters: number } | null = null;
    for (const [num, line] of holeLineList) {
      const d = turf.pointToLineDistance(point, line, { units: "meters" });
      if (!best || d < best.distanceMeters) best = { number: num, distanceMeters: d };
    }
    return best;
  }

  // Greens/tees get matched to whichever hole's centerline they project onto the correct HALF
  // of (green -> back half, near the green end; tee -> front half, near the tee end) — among
  // holes that qualify, picks whichever is perpendicular-closest; falls back to plain
  // nearest-whole-line if nothing qualifies. A naive "nearest raw endpoint coordinate" version
  // of this was tried first and rejected: real course centerlines are only 2-4 vertices
  // approximating the true fairway path, so a genuinely-correct green can legitimately sit
  // 100-300m from its own hole's literal last vertex, while an unrelated neighboring hole's
  // vertex happens to be closer by coincidence — matching a *position along the line* rather
  // than a *raw coordinate* avoids that. Verified against the real Tarandowah/Innerkip data:
  // every case where this disagrees with plain nearest-whole-line has the plain approach
  // landing at the WRONG end of its chosen hole's line (e.g. a "green" matched to a hole where
  // it actually sits at fraction ~0.0 — right at that hole's tee, not a plausible green spot),
  // while this approach lands at the correct end of the correct hole instead.
  function nearestHoleByCenterlineHalf(centroid: LatLng, half: "start" | "end"): { number: number; distanceMeters: number } | null {
    const pt = turf.point([centroid.lng, centroid.lat]);
    let best: { number: number; distanceMeters: number } | null = null;
    for (const [num, line] of holeLineList) {
      const snapped = turf.nearestPointOnLine(line, pt, { units: "meters" });
      const totalLength = turf.length(line, { units: "meters" });
      const fraction = totalLength > 0 ? (snapped.properties.location as number) / totalLength : 0;
      const qualifies = half === "end" ? fraction >= 0.5 : fraction <= 0.5;
      if (!qualifies) continue;
      const d = snapped.properties.dist as number;
      if (!best || d < best.distanceMeters) best = { number: num, distanceMeters: d };
    }
    return best ?? nearestHoleNumber(pt);
  }

  const rawFeatures: { holeNumber: number; featureType: FeatureType; geometry: GeoJSON.Polygon; centroid: LatLng }[] = [];
  const bunkers: { geometry: GeoJSON.Polygon; centroid: LatLng; holeNumber: number }[] = [];
  let lowConfidenceCount = 0;
  let ignoredCount = 0;

  for (const f of features) {
    if (f === boundary) continue;
    const golfTag = (f.properties as any)?.golf as string | undefined;

    if (golfTag) {
      if (f.geometry.type !== "Polygon") continue;
      const centroid = centroidLatLng(f.geometry);
      const centroidPt = turf.point([centroid.lng, centroid.lat]);
      const nearest =
        golfTag === "green"
          ? nearestHoleByCenterlineHalf(centroid, "end")
          : golfTag === "tee"
            ? nearestHoleByCenterlineHalf(centroid, "start")
            : nearestHoleNumber(centroidPt);
      if (!nearest) continue; // no centerlines at all — shouldn't happen given the maxHoleNumber fallback above
      if (nearest.distanceMeters > 100) lowConfidenceCount++;

      if (golfTag === "bunker") {
        bunkers.push({ geometry: f.geometry, centroid, holeNumber: nearest.number });
        continue;
      }

      const featureType = DIRECT_TAG_MAP[golfTag];
      if (!featureType) {
        ignoredCount++;
        continue;
      }
      rawFeatures.push({ holeNumber: nearest.number, featureType, geometry: f.geometry, centroid });
      continue;
    }

    // Non-golf-tagged water: natural=water, water=*, waterway=*, or a creek/stream/drain name.
    if (!isExpandedWaterFeature(f.properties)) continue;
    let hazardGeometry: GeoJSON.Polygon | null = null;
    if (f.geometry.type === "Polygon") {
      hazardGeometry = f.geometry;
    } else if (f.geometry.type === "LineString") {
      const buffered = turf.buffer(f as GeoJSON.Feature<GeoJSON.LineString>, WATERWAY_BUFFER_YARDS, { units: "yards" });
      if (buffered && buffered.geometry.type === "Polygon") hazardGeometry = buffered.geometry;
    }
    if (!hazardGeometry) continue;

    const centroid = centroidLatLng(hazardGeometry);
    const nearest = nearestHoleNumber(turf.point([centroid.lng, centroid.lat]));
    if (!nearest) continue;
    if (nearest.distanceMeters > 100) lowConfidenceCount++;
    rawFeatures.push({ holeNumber: nearest.number, featureType: "hazard", geometry: hazardGeometry, centroid });
  }

  // --- 5. Bunker greenside/fairway classification: distance from bunker centroid to nearest green centroid on the same hole ---
  const greensByHole = new Map<number, LatLng[]>();
  for (const rf of rawFeatures) {
    if (rf.featureType !== "green") continue;
    const arr = greensByHole.get(rf.holeNumber) ?? [];
    arr.push(rf.centroid);
    greensByHole.set(rf.holeNumber, arr);
  }
  for (const b of bunkers) {
    const greens = greensByHole.get(b.holeNumber) ?? [];
    const minDist = greens.length ? Math.min(...greens.map((g) => distanceYardsBetween(b.centroid, g))) : Infinity;
    const featureType: FeatureType = minDist <= GREENSIDE_BUNKER_THRESHOLD_YARDS ? "bunker_greenside" : "bunker_fairway";
    rawFeatures.push({ holeNumber: b.holeNumber, featureType, geometry: b.geometry, centroid: b.centroid });
  }

  if (lowConfidenceCount) {
    warnings.push(`${lowConfidenceCount} feature(s) were more than 100m from any hole centerline — their hole assignment may be wrong.`);
  }
  if (ignoredCount) {
    warnings.push(`Ignored ${ignoredCount} other OSM feature(s) not tracked by this app (cart paths, driving range, etc.).`);
  }

  // --- 6. Tee boxes: centroid point + name from `teebox` tag (color), separate from the tee polygon feature itself ---
  const teeBoxes: ParsedTeeBox[] = [];
  for (const f of features) {
    if ((f.properties as any)?.golf !== "tee" || f.geometry.type !== "Polygon") continue;
    const centroid = centroidLatLng(f.geometry);
    const nearest = nearestHoleByCenterlineHalf(centroid, "start");
    if (!nearest) continue;
    const teebox = (f.properties as any)?.teebox as string | undefined;
    const name = teebox ? teebox.split(";").map((s) => s.trim()).join(" / ") : "Tee";
    teeBoxes.push({ holeNumber: nearest.number, name, location: centroid });
  }

  // --- 7. Fallback: any hole with no golf=tee polygon gets a tee box synthesized from the
  // first coordinate of its centerline, so the map always has a line/camera origin — real
  // courses' OSM data sometimes maps hole centerlines without ever mapping tee polygons.
  const holesWithTeeBox = new Set(teeBoxes.map((t) => t.holeNumber));
  const fallbackTeeHoles: number[] = [];
  for (let n = 1; n <= maxHoleNumber; n++) {
    if (holesWithTeeBox.has(n)) continue;
    const line = holeLineByNumber.get(n);
    if (!line) continue;
    const [lng, lat] = line.geometry.coordinates[0];
    teeBoxes.push({ holeNumber: n, name: "Tee (approx.)", location: { lat, lng } });
    fallbackTeeHoles.push(n);
  }
  if (fallbackTeeHoles.length) {
    warnings.push(
      `Holes ${fallbackTeeHoles.join(", ")} have no golf=tee polygon in OSM — used the centerline's starting point as an approximate tee location instead.`
    );
  }

  return {
    name,
    location,
    holes,
    features: rawFeatures.map(({ holeNumber, featureType, geometry }) => ({ holeNumber, featureType, geometry })),
    teeBoxes,
    warnings
  };
}
