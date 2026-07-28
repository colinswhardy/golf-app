import { useEffect, useState } from "react";
import { db } from "../lib/db";
import { PageHeader } from "../components/PageHeader";
import { computeAndPersistClubDistances } from "../lib/statsRunner";
import { computePartialWedges, type ClubDistanceSummary, type ConfidenceTier, type PartialBucketSummary } from "../lib/stats";
import { demElevationMap } from "../lib/elevation";
import { baselineRowCount } from "../lib/sg";
import type { LatLng } from "../types/domain";

/**
 * Per-club distance + partial-wedge statistics (REVISION-SPEC Phase 5). Recomputed on every
 * open: DEM elevations resolved (cache-first), MAD outliers re-derived and persisted, then the
 * typical / flushed numbers rendered with their confidence tiers.
 */

const CONFIDENCE_LABELS: Record<ConfidenceTier, string> = {
  none: "collecting",
  low: "low",
  medium: "medium",
  high: "high",
  confident: "confident"
};

const CONFIDENCE_COLORS: Record<ConfidenceTier, string> = {
  none: "#8fa395",
  low: "#fca5a5",
  medium: "#f5d90a",
  high: "#8fd694",
  confident: "#10b981"
};

export function StatsPage() {
  const [distances, setDistances] = useState<ClubDistanceSummary[] | null>(null);
  const [partials, setPartials] = useState<PartialBucketSummary[] | null>(null);
  const [sgRows, setSgRows] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [shots, clubs, roundHoles] = await Promise.all([
          db.shots.toArray(),
          db.clubs.toArray(),
          db.roundHoles.toArray()
        ]);

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
        setPartials(
          computePartialWedges(shots, clubs, (s) => s.targetPoint ?? pinByRoundHole.get(s.roundHoleId) ?? null)
        );
        setSgRows(await baselineRowCount());
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ padding: 16, maxWidth: 640, margin: "0 auto" }}>
      <PageHeader title="Stats" />
      {error && <p style={{ color: "#fca5a5" }}>{error}</p>}
      {!distances && !error && <p style={{ opacity: 0.6 }}>Crunching…</p>}

      {distances && (
        <>
          <h2 style={sectionStyle}>Club distances (flat-equivalent)</h2>
          <p style={hintStyle}>
            <strong>Typical</strong> = median of retained shots — pick clubs off this number.{" "}
            <strong>Flushed</strong> = 80th percentile. The gap between them is how much you're
            leaving out there.
          </p>
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Club</th>
                  <th style={thStyle}>Typical</th>
                  <th style={thStyle}>Flushed</th>
                  <th style={thStyle}>Gap</th>
                  <th style={thStyle}>Shots</th>
                  <th style={thStyle}>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {distances.map((d) => (
                  <tr key={d.clubId}>
                    <td style={tdStyle}>{d.clubName}</td>
                    <td style={{ ...tdStyle, fontWeight: 700 }}>{d.typicalYards !== null ? `${d.typicalYards}y` : "—"}</td>
                    <td style={tdStyle}>{d.flushedYards !== null ? `${d.flushedYards}y` : "—"}</td>
                    <td style={tdStyle}>
                      {d.typicalYards !== null && d.flushedYards !== null ? `${d.flushedYards - d.typicalYards}y` : "—"}
                    </td>
                    <td style={tdStyle}>{d.count}</td>
                    <td style={{ ...tdStyle, color: CONFIDENCE_COLORS[d.confidence], fontWeight: 600 }}>
                      {CONFIDENCE_LABELS[d.confidence]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {partials && partials.length > 0 && (
        <>
          <h2 style={sectionStyle}>Partial wedges (by intended distance)</h2>
          <p style={hintStyle}>
            Proximity = median leave from the pin. Bias negative = coming up short; lateral
            negative = missing left.
          </p>
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Club</th>
                  <th style={thStyle}>Bucket</th>
                  <th style={thStyle}>Proximity</th>
                  <th style={thStyle}>Bias</th>
                  <th style={thStyle}>Lateral</th>
                  <th style={thStyle}>Shots</th>
                  <th style={thStyle}>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {partials.map((p) => (
                  <tr key={`${p.clubId}-${p.bucketYards}`}>
                    <td style={tdStyle}>{p.clubName}</td>
                    <td style={tdStyle}>{p.bucketYards}y</td>
                    <td style={{ ...tdStyle, fontWeight: 700 }}>{p.proximityYards}y</td>
                    <td style={tdStyle}>{p.biasYards}y</td>
                    <td style={tdStyle}>{p.lateralBiasYards}y</td>
                    <td style={tdStyle}>{p.count}</td>
                    <td style={{ ...tdStyle, color: CONFIDENCE_COLORS[p.confidence], fontWeight: 600 }}>
                      {CONFIDENCE_LABELS[p.confidence]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {partials && partials.length === 0 && (
        <p style={{ ...hintStyle, marginTop: 16 }}>
          No partial-wedge data yet — partials are detected automatically once wedge shots inside
          the 56°/50° thresholds are captured.
        </p>
      )}

      <h2 style={sectionStyle}>Strokes gained</h2>
      <p style={hintStyle}>
        {sgRows > 0
          ? `Baseline loaded (${sgRows} rows).`
          : "No baseline loaded — import an expected-strokes CSV in Settings to enable strokes gained."}
      </p>
    </div>
  );
}

const sectionStyle: React.CSSProperties = { fontSize: 16, margin: "20px 0 4px" };
const hintStyle: React.CSSProperties = { fontSize: 12.5, opacity: 0.7, marginBottom: 10 };
const tableWrapStyle: React.CSSProperties = { overflowX: "auto", border: "1px solid #2f5c3d", borderRadius: 10 };
const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  background: "#1a3a24",
  borderBottom: "1px solid #2f5c3d",
  whiteSpace: "nowrap"
};
const tdStyle: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px solid #16241a", whiteSpace: "nowrap" };
