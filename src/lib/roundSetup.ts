import type { TeeBox } from "../types/domain";

/**
 * Pre-round choices: how many holes, and off which tees. Pure so both the setup screen and the
 * round map agree on what a choice means (the map replays the stored range off the Round row).
 */

export type NineChoice = "full" | "front" | "back";

export interface HoleRange {
  start: number;
  end: number;
}

/** The holes a round covers. Mirrors the range semantics rounds were already stored with. */
export function holeRangeFor(choice: NineChoice, firstHole: number, lastHole: number): HoleRange {
  if (choice === "front") return { start: firstHole, end: Math.min(9, lastHole) };
  if (choice === "back") return { start: 10, end: lastHole };
  return { start: firstHole, end: lastHole };
}

/** Picking a nine only means anything once there's a back nine to pick. */
export function offersNines(lastHole: number): boolean {
  return lastHole >= 18;
}

export interface TeeSetSummary {
  name: string;
  /** How many holes actually have a tee box under this name. */
  holes: number;
}

/** What the importer names a tee box when OSM carries no `teebox=` colour for it. */
export const PLACEHOLDER_TEE_NAME = "Tee";

/**
 * Whether there's a real choice to offer. A course whose only "set" is the unnamed placeholder
 * has one tee per hole, so picking it means exactly what the backmost fallback already does —
 * offering both is a decision with no consequence.
 */
export function offersTeeChoice(teeSets: TeeSetSummary[]): boolean {
  if (teeSets.length === 0) return false;
  return !(teeSets.length === 1 && teeSets[0].name === PLACEHOLDER_TEE_NAME);
}

/**
 * The tee sets on offer, with their coverage.
 *
 * The importer falls back to the name "Tee" for any hole OSM left without a `teebox=` colour, so
 * a course can carry a mix of real colour sets and that placeholder. Real colours win when they
 * exist; the placeholder is only offered when it's all there is. Coverage is worth surfacing
 * because a colour mapped on three holes out of eighteen is a bad thing to pick unaware —
 * the round map silently falls back to the backmost tee on every hole that lacks it.
 */
export function summariseTeeSets(teeBoxes: TeeBox[]): TeeSetSummary[] {
  const holesByName = new Map<string, Set<string>>();
  for (const t of teeBoxes) {
    let holes = holesByName.get(t.name);
    if (!holes) holesByName.set(t.name, (holes = new Set()));
    holes.add(t.holeId);
  }
  const all = [...holesByName.entries()].map(([name, holes]) => ({ name, holes: holes.size }));
  const colours = all.filter((t) => t.name !== "Tee");
  return (colours.length ? colours : all).sort((a, b) => a.name.localeCompare(b.name));
}
