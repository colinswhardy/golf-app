import { useEffect, useState } from "react";
import { db } from "../lib/db";
import { computeAndPersistClubDistances } from "../lib/statsRunner";
import { computePartialWedges, type ClubDistanceSummary, type ConfidenceTier, type PartialBucketSummary } from "../lib/stats";
import { demElevationMap } from "../lib/elevation";
import { baselineRowCount } from "../lib/sg";
import { AppBar, Badge, EmptyState, Page, Section, Stat } from "../components/ui";
import type { LatLng } from "../types/domain";

/**
 * Per-club distance + partial-wedge statistics. Recomputed on every open: DEM elevations
 * resolved (cache-first), MAD outliers re-derived and persisted, then the typical / flushed
 * numbers rendered with their confidence tiers.
 */

const CONFIDENCE_LABEL: Record<ConfidenceTier, string> = {
  none: "collecting",
  low: "low",
  medium: "medium",
  high: "high",
  confident: "confident"
};

const CONFIDENCE_TONE: Record<ConfidenceTier, "neutral" | "danger" | "warn" | "accent"> = {
  none: "neutral",
  low: "danger",
  medium: "warn",
  high: "accent",
  confident: "accent"
};

export function StatsPage() {
  const [distances, setDistances] = useState<ClubDistanceSummary[] | null>(null);
  const [partials, setPartials] = useState<PartialBucketSummary[] | null>(null);
  const [sgRows, setSgRows] = useState(0);
  const [totals, setTotals] = useState<{ rounds: number; shots: number; putts: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [shots, clubs, roundHoles, rounds] = await Promise.all([
          db.shots.toArray(),
          db.clubs.toArray(),
          db.roundHoles.toArray(),
          db.rounds.where("status").equals("completed").toArray()
        ]);
        if (cancelled) return;
        setTotals({
          rounds: rounds.length,
          shots: shots.filter((s) => s.swingType !== "putt" && s.penaltyType === null).length,
          putts: shots.filter((s) => s.swingType === "putt").length
        });

        // Resolve DEM elevations for every relevant endpoint up front (cache-first; null offline).
        const points: LatLng[] = [];
        for (const s of shots) {
          if (s.endPoint) points.push(s.endPoint);
          if (s.elevationM === null) points.push(s.startPoint);
        }
        const elevationAt = await demElevationMap(points);
        if (cancelled) return;

        const summaries = await computeAndPersistClubDistances(elevationAt);
        if (cancelled) return;
        setDistances(summaries);

        const pinByRoundHole = new Map(roundHoles.map((rh) => [rh.id, rh.pinLocation]));
        setPartials(computePartialWedges(shots, clubs, (s) => s.targetPoint ?? pinByRoundHole.get(s.roundHoleId) ?? null));
        setSgRows(await baselineRowCount());
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const withData = distances?.filter((d) => d.count > 0) ?? [];
  const collecting = distances?.filter((d) => d.count === 0) ?? [];

  return (
    <Page>
      <AppBar title="Stats" subtitle={totals ? `${totals.rounds} rounds logged` : undefined} />

      {error && <div className="note note--danger mb-3">{error}</div>}

      {totals && (
        <div className="stat-row mb-3">
          <Stat value={totals.rounds} label="Rounds" />
          <Stat value={totals.shots} label="Shots" />
          <Stat value={totals.putts} label="Putts" />
        </div>
      )}

      {!distances && !error && (
        <div className="card row dim small">
          <span className="spinner" /> Crunching your shots…
        </div>
      )}

      {distances && withData.length === 0 && (
        <EmptyState icon="📊" title="No club data yet">
          Distances appear once shots with a known club and end point are recorded. Four shots with
          a club unlock its first number.
        </EmptyState>
      )}

      {withData.length > 0 && (
        <Section
          title="Club distances"
          hint={
            <>
              <strong className="accent">Typical</strong> is the median — the number to club off.{" "}
              <strong>Flushed</strong> is your 80th percentile. All distances are flat-equivalent,
              corrected for elevation.
            </>
          }
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Club</th>
                  <th>Typical</th>
                  <th>Flushed</th>
                  <th>Gap</th>
                  <th>n</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {withData.map((d) => (
                  <tr key={d.clubId}>
                    <td className="is-primary">{d.clubName}</td>
                    <td className="is-primary accent">{d.typicalYards !== null ? `${d.typicalYards}` : "—"}</td>
                    <td>{d.flushedYards !== null ? `${d.flushedYards}` : "—"}</td>
                    <td className="dim">
                      {d.typicalYards !== null && d.flushedYards !== null ? `+${d.flushedYards - d.typicalYards}` : "—"}
                    </td>
                    <td className="dim">{d.count}</td>
                    <td>
                      <Badge tone={CONFIDENCE_TONE[d.confidence]}>{CONFIDENCE_LABEL[d.confidence]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {collecting.length > 0 && (
            <p className="tiny faint mt-2">Still collecting: {collecting.map((c) => c.clubName).join(", ")}</p>
          )}
        </Section>
      )}

      {partials && partials.length > 0 && (
        <Section
          title="Partial wedges"
          hint="Bucketed by the distance you were trying to hit, not the result. Proximity is your median leave; negative bias means short, negative lateral means left."
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Club</th>
                  <th>Target</th>
                  <th>Proximity</th>
                  <th>Bias</th>
                  <th>Lateral</th>
                  <th>n</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {partials.map((p) => (
                  <tr key={`${p.clubId}-${p.bucketYards}`}>
                    <td className="is-primary">{p.clubName}</td>
                    <td className="dim">{p.bucketYards}y</td>
                    <td className="is-primary accent">{p.proximityYards}y</td>
                    <td className={p.biasYards !== null && p.biasYards < 0 ? "warn" : ""}>{p.biasYards}y</td>
                    <td className="dim">{p.lateralBiasYards}y</td>
                    <td className="dim">{p.count}</td>
                    <td>
                      <Badge tone={CONFIDENCE_TONE[p.confidence]}>{CONFIDENCE_LABEL[p.confidence]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title="Strokes gained">
        <div className="note">
          {sgRows > 0
            ? `Baseline loaded — ${sgRows} rows. Strokes gained will compute against it.`
            : "No baseline loaded. Import an expected-strokes CSV in Settings to turn this on — the app deliberately ships without one."}
        </div>
      </Section>
    </Page>
  );
}
