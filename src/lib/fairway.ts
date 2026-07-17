import * as turf from "@turf/turf";
import { bearingDegrees, toDownrangeOffline } from "./geo";
import type { FairwayResult, LatLng } from "../types/domain";

/**
 * Classifies a tee shot's landing point (Shot 2's start / Shot 1's end) against the fairway
 * polygon and the tee->green line: inside the fairway polygon -> "hit". Otherwise, projects the
 * point into the tee->green (downrange, offline) frame: past either end of the fairway polygon's
 * own downrange span along that line -> "short"/"long"; still within that span but off to the
 * side -> "left"/"right" by the sign of offlineYards.
 */
export function classifyFairwayResult(
  fairwayGeometry: GeoJSON.Polygon,
  tee: LatLng,
  green: LatLng,
  landingPoint: LatLng
): FairwayResult {
  const turfPolygon = turf.polygon(fairwayGeometry.coordinates);
  if (turf.booleanPointInPolygon(turf.point([landingPoint.lng, landingPoint.lat]), turfPolygon)) {
    return "hit";
  }

  const bearing = bearingDegrees(tee, green);
  const { downrangeYards, offlineYards } = toDownrangeOffline(tee, bearing, landingPoint);

  const fairwayDownranges = fairwayGeometry.coordinates[0].map(
    ([lng, lat]) => toDownrangeOffline(tee, bearing, { lat, lng }).downrangeYards
  );
  const minDownrange = Math.min(...fairwayDownranges);
  const maxDownrange = Math.max(...fairwayDownranges);

  if (downrangeYards < minDownrange) return "short";
  if (downrangeYards > maxDownrange) return "long";
  return offlineYards > 0 ? "right" : "left";
}
