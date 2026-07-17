import { db } from "./db";
import { bearingDegrees, computeDispersionEllipse, toDownrangeOffline } from "./geo";
import type { DispersionEllipseSpec } from "../components/CourseMap";
import type { Club } from "../types/domain";

/**
 * Manual dispersion as a simple axis-aligned ellipse: front/back and left/right are already
 * expressed in the shot's own downrange/offline frame, so rotationRad is 0 — no extra rotation
 * needed on top of the bearing-based rotation CourseMap applies when drawing it.
 */
export function manualDispersion(club: Club): DispersionEllipseSpec | null {
  if (club.manualFrontBackYards == null || club.manualLeftRightYards == null) return null;
  return {
    semiMajorYards: club.manualFrontBackYards / 2,
    semiMinorYards: club.manualLeftRightYards / 2,
    rotationRad: 0
  };
}

/**
 * Actual dispersion computed from this club's shot history: for every recorded shot that has
 * both an end point and an aim point (set during post-round review), projects the end point into
 * the shot's own (downrange, offline) frame relative to its start->aim bearing, then fits a 90%
 * confidence ellipse across all of them. Shots without an aim point are skipped — there's no
 * meaningful "offline" axis without knowing what was being aimed at.
 */
export async function computeActualDispersion(clubId: string): Promise<DispersionEllipseSpec | null> {
  const shots = await db.shots.where("clubId").equals(clubId).toArray();
  const points: { downrangeYards: number; offlineYards: number }[] = [];

  for (const s of shots) {
    if (!s.endPoint || !s.aimPointOverride) continue;
    const bearing = bearingDegrees(s.startPoint, s.aimPointOverride);
    points.push(toDownrangeOffline(s.startPoint, bearing, s.endPoint));
  }

  const ellipse = computeDispersionEllipse(points, 0.9);
  if (!ellipse) return null;
  return { semiMajorYards: ellipse.semiMajor, semiMinorYards: ellipse.semiMinor, rotationRad: ellipse.rotationRad };
}

/** Resolves a club's dispersion overlay per its useActualDispersion flag, falling back to the
 * manual values when actual computation isn't enabled or there isn't enough shot history yet. */
export async function getClubDispersion(club: Club): Promise<DispersionEllipseSpec | null> {
  if (club.useActualDispersion) {
    const actual = await computeActualDispersion(club.id);
    if (actual) return actual;
  }
  return manualDispersion(club);
}
