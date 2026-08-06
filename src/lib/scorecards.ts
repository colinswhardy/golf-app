/**
 * Published scorecard reference data — par, stroke index and per-tee yardages.
 *
 * Deliberately NOT sourced from the OSM import. OSM carries par (and occasionally `handicap`), but
 * it has no per-tee yardages at all, and in practice essentially no course has `teebox=` colours
 * tagged — so an imported course knows its hole lengths only as centerline distances and its tee
 * boxes only as an undifferentiated row of "Tee". These files come from the operators' own
 * published cards instead; see data/scorecards/README.md for provenance and caveats.
 *
 * Bundled rather than fetched: the whole point of this app is working with no signal on the course,
 * and the set is ~200 KB across every course. `import.meta.glob(eager)` means dropping a new
 * card-<slug>.json into data/scorecards/ picks it up with no code change — the same "add the file,
 * add nothing else" property the bundled course GeoJSON has.
 */

export interface ScorecardTeeSet {
  name: string;
  totalYards?: number | null;
  outYards?: number | null;
  inYards?: number | null;
  par?: number | null;
  rating?: number | null;
  slope?: number | null;
}

export interface ScorecardHole {
  number: number;
  par: number | null;
  handicap: number | null;
  /** Yardage keyed by tee-set name. A tee set may legitimately be missing on a hole. */
  yards: Record<string, number | null>;
}

export interface Scorecard {
  slug: string;
  course: string;
  location?: string | null;
  holeCount?: number | null;
  par?: number | null;
  measurement?: string | null;
  teeSets: ScorecardTeeSet[];
  holes: ScorecardHole[];
  sources: string[];
  notes?: string | null;
}

const modules = import.meta.glob<{ default: Omit<Scorecard, "slug"> }>("../../data/scorecards/card-*.json", {
  eager: true
});

function slugFromPath(path: string): string {
  return path.replace(/^.*\/card-/, "").replace(/\.json$/, "");
}

const BY_SLUG: Record<string, Scorecard> = {};
for (const [path, mod] of Object.entries(modules)) {
  const raw = (mod as { default: Omit<Scorecard, "slug"> }).default;
  const slug = slugFromPath(path);
  BY_SLUG[slug] = {
    ...raw,
    slug,
    teeSets: raw.teeSets ?? [],
    holes: (raw.holes ?? []).slice().sort((a, b) => a.number - b.number),
    sources: raw.sources ?? []
  };
}

export function getScorecard(slug: string | undefined | null): Scorecard | null {
  return slug ? BY_SLUG[slug] ?? null : null;
}

export function listScorecards(): Scorecard[] {
  return Object.values(BY_SLUG).sort((a, b) => a.course.localeCompare(b.course));
}

/**
 * Tee sets actually worth rendering as columns: any set that carries at least one hole yardage.
 * Cards routinely list a tee in the header that has no per-hole numbers published (combo tees like
 * "Blue/White" especially), and an all-blank column is worse than no column on a phone.
 */
export function usableTeeSets(card: Scorecard): ScorecardTeeSet[] {
  return card.teeSets.filter((t) => card.holes.some((h) => typeof h.yards?.[t.name] === "number"));
}

/** Out (1-9), In (10-18) and total for a tee, summed from the holes rather than trusting the
 * header — the two disagree on some published cards, and the holes are what's displayed. */
export function teeTotals(card: Scorecard, teeName: string) {
  const sum = (from: number, to: number) =>
    card.holes
      .filter((h) => h.number >= from && h.number <= to)
      .reduce((acc, h) => acc + (typeof h.yards?.[teeName] === "number" ? (h.yards[teeName] as number) : 0), 0);
  const out = sum(1, 9);
  const inn = sum(10, 18);
  return { out, in: inn, total: out + inn };
}

export function parTotals(card: Scorecard) {
  const sum = (from: number, to: number) =>
    card.holes.filter((h) => h.number >= from && h.number <= to).reduce((a, h) => a + (h.par ?? 0), 0);
  const out = sum(1, 9);
  const inn = sum(10, 18);
  return { out, in: inn, total: out + inn };
}
