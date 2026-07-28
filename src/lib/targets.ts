import * as turf from "@turf/turf";
import { bearingDegrees, distanceYards, fromDownrangeOffline } from "./geo";
import type { FeatureType, LatLng, Shot, TargetSource } from "../types/domain";

/**
 * Default target-line resolution (REVISION-SPEC 4.2). Pure. A shot's target defaults, applied
 * automatically whenever targetPoint is unset:
 *   - tee shot on a par 4/5 → the point on the hole centerline at the club's median distance
 *     ("default_fairway")
 *   - approach → the round-hole pin, falling back to green centroid ("default_pin"/"default_green")
 *   - putt → the pin
 * Manual targets (targetSource "manual") are never overwritten.
 */

/** Fallback aiming distance when a club has no usable median yet (or no club was recorded). */
const FALLBACK_TEE_TARGET_YARDS = 230;

export interface TargetContext {
  par: number;
  pin: LatLng | null;
  greenCentroid: LatLng | null;
  teeLocation: LatLng | null;
  /** The hole's centerline (LineString), when one is stored. */
  centerline: GeoJSON.LineString | null;
  /** Median full-swing distance for a club id, yards — stats-backed; null when unknown. */
  clubMedianYards: (clubId: string) => number | null;
}

export interface HoleFeatureLike {
  featureType: FeatureType;
  geometry: GeoJSON.Polygon | GeoJSON.LineString;
}

export function centerlineOf(features: HoleFeatureLike[]): GeoJSON.LineString | null {
  const f = features.find((x) => x.featureType === "centerline" && x.geometry.type === "LineString");
  return (f?.geometry as GeoJSON.LineString) ?? null;
}

export function greenCentroidOf(features: HoleFeatureLike[]): LatLng | null {
  const green =
    features.find((f) => f.featureType === "green" && f.geometry.type === "Polygon") ??
    features.find((f) => f.featureType === "fairway" && f.geometry.type === "Polygon");
  if (!green) return null;
  const [lng, lat] = turf.centroid(turf.feature(green.geometry)).geometry.coordinates;
  return { lat, lng };
}

/** Point on the centerline `yards` down its length from the start (clamped to its end). Without
 * a centerline, projects straight along the start→green line instead. */
function pointAlongLine(
  centerline: GeoJSON.LineString | null,
  start: LatLng,
  green: LatLng | null,
  yards: number
): LatLng | null {
  if (centerline) {
    const line = turf.lineString(centerline.coordinates);
    const lengthYards = turf.length(line, { units: "yards" });
    const along = turf.along(line, Math.min(yards, lengthYards), { units: "yards" });
    const [lng, lat] = along.geometry.coordinates;
    return { lat, lng };
  }
  if (!green) return null;
  const d = Math.min(yards, distanceYards(start, green));
  return fromDownrangeOffline(start, bearingDegrees(start, green), d, 0);
}

/**
 * Resolves the default target for one shot, or null when there's nothing to aim it at (no pin,
 * no green, no centerline — a bare placeholder hole). Never called for manual targets.
 */
export function defaultTargetForShot(
  shot: Pick<Shot, "shotNumber" | "swingType" | "clubId">,
  ctx: TargetContext
): { point: LatLng; source: TargetSource } | null {
  if (shot.swingType === "putt") {
    return ctx.pin ? { point: ctx.pin, source: "default_pin" } : null;
  }

  const isTeeShot = shot.shotNumber === 1 && ctx.par >= 4;
  if (isTeeShot && ctx.teeLocation) {
    const median = shot.clubId ? ctx.clubMedianYards(shot.clubId) : null;
    const point = pointAlongLine(
      ctx.centerline,
      ctx.teeLocation,
      ctx.pin ?? ctx.greenCentroid,
      median ?? FALLBACK_TEE_TARGET_YARDS
    );
    if (point) return { point, source: "default_fairway" };
  }

  if (ctx.pin) return { point: ctx.pin, source: "default_pin" };
  if (ctx.greenCentroid) return { point: ctx.greenCentroid, source: "default_green" };
  return null;
}
