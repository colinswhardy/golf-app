import { db } from "./db";
import type { Lie, SgBaselineScratch } from "../types/domain";

/**
 * Strokes-gained lookup against the sgBaselineScratch table (REVISION-SPEC 5.6). The table
 * ships EMPTY — the user imports their own baseline CSV (Settings), because published
 * expected-strokes values are proprietary. Everything here is inert until rows exist.
 *
 * SG(shot) = expected(lieStart, distToPinStart) − expected(lieEnd, distToPinEnd) − 1 − penalties.
 * The LIE decides the baseline category, never the club — a putt from the fringe scores against
 * the around-the-green baseline, not putting (putts are real Shot rows with real lies, 1.5).
 */

/** Linear interpolation between the two bracketing distance rows for a lie. Clamps outside the
 * table's range to the nearest row. Null when the lie has no rows at all. */
export function interpolateExpectedStrokes(rows: SgBaselineScratch[], lie: Lie, distanceYards: number): number | null {
  const forLie = rows.filter((r) => r.lie === lie).sort((a, b) => a.distanceYards - b.distanceYards);
  if (!forLie.length) return null;
  if (distanceYards <= forLie[0].distanceYards) return forLie[0].expectedStrokes;
  const last = forLie[forLie.length - 1];
  if (distanceYards >= last.distanceYards) return last.expectedStrokes;
  for (let i = 0; i < forLie.length - 1; i++) {
    const a = forLie[i];
    const b = forLie[i + 1];
    if (distanceYards >= a.distanceYards && distanceYards <= b.distanceYards) {
      const t = (distanceYards - a.distanceYards) / (b.distanceYards - a.distanceYards);
      return a.expectedStrokes + t * (b.expectedStrokes - a.expectedStrokes);
    }
  }
  return last.expectedStrokes;
}

export async function expectedStrokes(lie: Lie, distanceYards: number): Promise<number | null> {
  const rows = await db.sgBaselineScratch.toArray();
  return interpolateExpectedStrokes(rows, lie, distanceYards);
}

export async function baselineRowCount(): Promise<number> {
  return db.sgBaselineScratch.count();
}

/**
 * Parses a baseline CSV — `lie,distanceYards,expectedStrokes` with an optional header row —
 * and REPLACES the table. Throws with a row-numbered message on malformed input.
 */
export async function importBaselineCsv(text: string): Promise<number> {
  const VALID_LIES = new Set<string>([
    "tee",
    "fairway",
    "rough",
    "bunker_greenside",
    "bunker_fairway",
    "hazard",
    "ob",
    "green",
    "fringe",
    "recovery"
  ]);
  const rows: SgBaselineScratch[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim());
    if (i === 0 && parts[0].toLowerCase() === "lie") continue; // header
    if (parts.length < 3) throw new Error(`Line ${i + 1}: expected "lie,distanceYards,expectedStrokes".`);
    const [lie, dist, exp] = parts;
    if (!VALID_LIES.has(lie)) throw new Error(`Line ${i + 1}: unknown lie "${lie}".`);
    const distanceYards = parseInt(dist, 10);
    const expectedStrokes = parseFloat(exp);
    if (!Number.isFinite(distanceYards) || !Number.isFinite(expectedStrokes)) {
      throw new Error(`Line ${i + 1}: non-numeric distance or expected strokes.`);
    }
    rows.push({ lie: lie as Lie, distanceYards, expectedStrokes });
  }
  if (!rows.length) throw new Error("No data rows found.");
  await db.transaction("rw", db.sgBaselineScratch, async () => {
    await db.sgBaselineScratch.clear();
    await db.sgBaselineScratch.bulkPut(rows);
  });
  return rows.length;
}
