import * as turf from "@turf/turf";
import type { FeatureType, HoleFeature, LatLng, Lie } from "../types/domain";

// hole_features types map 1:1 onto lie categories; anything unmatched is rough.
const FEATURE_TO_LIE: Record<FeatureType, Lie> = {
  fairway: "fairway",
  green: "green",
  fringe: "fringe",
  bunker_greenside: "bunker_greenside",
  bunker_fairway: "bunker_fairway",
  hazard: "hazard",
  ob: "ob",
  rough: "rough",
  tee: "tee"
};

export const ALL_LIES: Lie[] = [
  "tee",
  "fairway",
  "rough",
  "fringe",
  "green",
  "bunker_greenside",
  "bunker_fairway",
  "hazard",
  "ob",
  "recovery"
];

export const LIE_LABELS: Record<Lie, string> = {
  tee: "Tee",
  fairway: "Fairway",
  rough: "Rough",
  fringe: "Fringe",
  green: "Green",
  bunker_greenside: "Greenside bunker",
  bunker_fairway: "Fairway bunker",
  hazard: "Hazard",
  ob: "OB",
  recovery: "Recovery"
};

/**
 * Auto-detects the lie at a GPS point by testing it against the hole's polygons,
 * highest z-order first (so fringe beats green beats fairway where they overlap).
 * No hit → rough (DESIGN.md §5). The polygons are never drawn on the map — this
 * is their whole job.
 */
export function detectLie(point: LatLng, features: HoleFeature[]): Lie {
  const pt = turf.point([point.lng, point.lat]);
  const sorted = [...features].sort((a, b) => b.zOrder - a.zOrder);
  for (const f of sorted) {
    if (turf.booleanPointInPolygon(pt, turf.feature(f.geometry) as GeoJSON.Feature<GeoJSON.Polygon>)) {
      return FEATURE_TO_LIE[f.featureType];
    }
  }
  return "rough";
}
