import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { listCourses } from "../lib/courseRepo";
import { getScorecard, listScorecards, parTotals, teeTotals, usableTeeSets } from "../lib/scorecards";
import { AppBar, Badge, EmptyState, Icon, Page } from "../components/ui";

/**
 * Read-only published scorecards: hole, par, stroke index and yardage from every tee.
 *
 * Separate from the round scorecard in Review (which shows what you actually scored) and from the
 * course geometry (which knows centerline lengths, not tee-by-tee yardages). Cards exist for
 * courses that are not imported yet too — the data is useful on its own, and it is how you check a
 * course's numbers before deciding whether its OSM data is worth fixing.
 */
export function ScorecardsPage() {
  const [slug, setSlug] = useState<string | null>(null);
  const courses = useLiveQuery(() => listCourses(), []);
  const importedSlugs = useMemo(() => new Set((courses ?? []).map((c) => c.slug)), [courses]);
  const cards = useMemo(() => listScorecards(), []);
  const card = getScorecard(slug);

  if (!card) {
    return (
      <Page>
        <AppBar title="Scorecards" subtitle={`${cards.length} courses`} />
        {cards.length === 0 ? (
          <EmptyState title="No scorecards bundled" />
        ) : (
          <div className="stack">
            {cards.map((c) => (
              <button key={c.slug} className="card card--interactive" onClick={() => setSlug(c.slug)}>
                <div className="row row--between">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="card__title truncate">{c.course}</div>
                    <div className="card__meta">
                      {c.holes.length} holes · par {parTotals(c).total || "—"} ·{" "}
                      {usableTeeSets(c).length} tee{usableTeeSets(c).length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {importedSlugs.has(c.slug) ? <Badge tone="accent">In app</Badge> : <Badge>Card only</Badge>}
                    <Icon.chevron size={16} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Page>
    );
  }

  const tees = usableTeeSets(card);
  const par = parTotals(card);
  const front = card.holes.filter((h) => h.number <= 9);
  const back = card.holes.filter((h) => h.number > 9);

  // Nine-by-nine so a phone shows a readable column count, with an OUT/IN subtotal under each —
  // the shape a paper card actually has.
  const renderNine = (rows: typeof card.holes, label: string) => {
    if (rows.length === 0) return null;
    const from = label === "OUT" ? 1 : 10;
    const to = label === "OUT" ? 9 : 18;
    const nineParTotal = rows.reduce((a, h) => a + (h.par ?? 0), 0);
    return (
      <div className="table-wrap mb-3">
        <table className="table">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Hole</th>
              <th>Par</th>
              <th>SI</th>
              {tees.map((t) => (
                <th key={t.name}>{t.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.number}>
                <td style={{ textAlign: "left" }} className="bold">
                  {h.number}
                </td>
                <td>{h.par ?? "—"}</td>
                <td className="dim">{h.handicap ?? "—"}</td>
                {tees.map((t) => (
                  <td key={t.name}>{h.yards?.[t.name] ?? "—"}</td>
                ))}
              </tr>
            ))}
            <tr className="scorecard-row--total">
              <td style={{ textAlign: "left" }} className="bold">
                {label}
              </td>
              <td className="bold">{nineParTotal || "—"}</td>
              <td />
              {tees.map((t) => {
                const totals = teeTotals(card, t.name);
                const v = label === "OUT" ? totals.out : totals.in;
                return (
                  <td key={t.name} className="bold">
                    {v || "—"}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
        <div className="tiny faint mt-1">
          Holes {from}–{to}
        </div>
      </div>
    );
  };

  return (
    <Page>
      <AppBar
        title={card.course}
        subtitle={`Par ${par.total || "—"}${card.location ? ` · ${card.location}` : ""}`}
        onBack={() => setSlug(null)}
      />

      <div className="row row--wrap mb-3" style={{ gap: 6 }}>
        {tees.map((t) => {
          const totals = teeTotals(card, t.name);
          return (
            <Badge key={t.name}>
              {t.name} {totals.total || t.totalYards || "—"}
              {t.rating ? ` · ${t.rating}/${t.slope ?? "—"}` : ""}
            </Badge>
          );
        })}
      </div>

      {renderNine(front, "OUT")}
      {renderNine(back, "IN")}

      <div className="card">
        <div className="row row--between">
          <span className="dim small">Total</span>
          <span className="bold num">
            par {par.total || "—"}
            {tees.length > 0 && ` · ${teeTotals(card, tees[0].name).total || "—"} yds (${tees[0].name})`}
          </span>
        </div>
      </div>

      {card.notes && (
        <div className="tiny faint mt-2" style={{ lineHeight: 1.5 }}>
          {card.notes}
        </div>
      )}
      {card.sources.length > 0 && (
        <div className="tiny faint mt-2" style={{ lineHeight: 1.5 }}>
          Source{card.sources.length === 1 ? "" : "s"}: {card.sources.map((s) => s.replace(/^https?:\/\//, "").split("/")[0]).join(", ")}
        </div>
      )}
    </Page>
  );
}
