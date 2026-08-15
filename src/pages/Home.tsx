import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { getHolesForVersion } from "../lib/courseRepo";
import { discardRound } from "../lib/roundRepo";
import { Badge, Icon, Page, Section, Stat, relativeToParLabel } from "../components/ui";

/**
 * "Play" — the app's home. Resume an in-progress round, start a new one on a
 * recent course, and glance at the last round's result. Everything else lives
 * behind the tab bar.
 */
export function Home() {
  const navigate = useNavigate();
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const courses = useLiveQuery(async () => (await db.courses.toArray()).filter((c) => !c.deletedAt), []);

  // The one round still in progress, if any, resolved through to its course name.
  const activeRound = useLiveQuery(async () => {
    const round = (await db.rounds.where("status").equals("in_progress").toArray())[0];
    if (!round) return null;
    const version = await db.courseVersions.get(round.courseVersionId);
    const course = version ? await db.courses.get(version.courseId) : undefined;
    const roundHoles = await db.roundHoles.where("roundId").equals(round.id).toArray();
    const played = roundHoles.filter((rh) => rh.score !== null).length;
    return { round, course, played };
  }, []);

  // Last completed round, with its to-par summary. Partial rounds (ended early, saved for
  // metrics only) are skipped — this card is a score, and they don't have one.
  const lastRound = useLiveQuery(async () => {
    const rounds = (await db.rounds.where("status").equals("completed").toArray())
      .filter((r) => !r.partial)
      .sort((a, b) => b.playedOn.localeCompare(a.playedOn));
    const round = rounds[0];
    if (!round) return null;
    const version = await db.courseVersions.get(round.courseVersionId);
    const course = version ? await db.courses.get(version.courseId) : undefined;
    const holes = version ? await getHolesForVersion(version.id) : [];
    const roundHoles = await db.roundHoles.where("roundId").equals(round.id).toArray();
    let toPar = 0;
    let strokes = 0;
    let scored = 0;
    for (const h of holes) {
      const rh = roundHoles.find((r) => r.holeId === h.id);
      if (rh?.score != null) {
        toPar += rh.score - h.par;
        strokes += rh.score;
        scored++;
      }
    }
    const shotIds = roundHoles.map((rh) => rh.id);
    const shots = shotIds.length ? await db.shots.where("roundHoleId").anyOf(shotIds).toArray() : [];
    const putts = shots.filter((s) => s.swingType === "putt").length;
    return { round, courseName: course?.name ?? "Unknown course", toPar, strokes, scored, putts, totalRounds: rounds.length };
  }, []);

  const featured = useMemo(() => {
    if (!courses) return [];
    return [...courses].sort((a, b) => {
      const ta = a.lastSelectedAt ? Date.parse(a.lastSelectedAt) : 0;
      const tb = b.lastSelectedAt ? Date.parse(b.lastSelectedAt) : 0;
      if (tb !== ta) return tb - ta;
      return a.name.localeCompare(b.name);
    });
  }, [courses]);

  async function startOn(courseId: string) {
    await db.courses.update(courseId, { lastSelectedAt: new Date().toISOString() });
    navigate(`/round/${courseId}/setup`);
  }

  return (
    <Page>
      <header className="mb-3">
        <div className="row row--between">
          <div>
            <div className="tiny faint bold" style={{ letterSpacing: "0.18em", textTransform: "uppercase" }}>
              CaddyShot
            </div>
            <h1 className="app-bar__title" style={{ fontSize: 27, marginTop: 2 }}>
              Ready to play
            </h1>
          </div>
          <div className="avatar">CH</div>
        </div>
      </header>

      {/* Resume banner takes priority over everything else on the screen. */}
      {activeRound && activeRound.round && (
        <div className="card card--accent">
          <button
            className="row row--between"
            style={{ width: "100%", textAlign: "left" }}
            onClick={() => navigate(`/round/${activeRound.course?.id ?? ""}`)}
          >
            <span className="grow">
              <Badge tone="accent">Round in progress</Badge>
              <span className="card__title mt-1" style={{ display: "block" }}>
                {activeRound.course?.name ?? "Round"}
              </span>
              <span className="card__meta" style={{ display: "block" }}>
                {activeRound.played} {activeRound.played === 1 ? "hole" : "holes"} scored · tap to continue
              </span>
            </span>
            <Icon.chevron size={20} />
          </button>
          {/* Without a way out, a round started by mistake is permanent and this banner nags forever. */}
          {confirmDiscard ? (
            <div className="mt-2">
              <div className="small mb-2">Discard this round and everything recorded in it?</div>
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn btn--sm btn--danger"
                  onClick={async () => {
                    await discardRound(activeRound.round.id);
                    setConfirmDiscard(false);
                  }}
                >
                  Discard
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => setConfirmDiscard(false)}>
                  Keep
                </button>
              </div>
            </div>
          ) : (
            <button className="tiny faint mt-2" onClick={() => setConfirmDiscard(true)}>
              Discard round
            </button>
          )}
        </div>
      )}

      <Section title="Start a round">
        {!courses ? (
          <div className="card dim small">Loading courses…</div>
        ) : featured.length === 0 ? (
          <div className="card">
            <div className="card__title">No courses yet</div>
            <div className="card__meta mt-1">
              Import one from an Overpass export in <Link to="/imports" className="accent bold">Data Imports</Link>.
            </div>
          </div>
        ) : (
          <div className="stack">
            {featured.map((c) => (
              <button key={c.id} className="card card--interactive card--tight" onClick={() => startOn(c.id)}>
                <div className="row">
                  <div
                    className="row"
                    style={{
                      width: 40,
                      height: 40,
                      flex: "none",
                      borderRadius: 12,
                      background: "var(--surface-3)",
                      border: "1px solid var(--line)",
                      justifyContent: "center",
                      color: "var(--accent)"
                    }}
                  >
                    <Icon.flag size={20} />
                  </div>
                  <div className="grow">
                    <div className="card__title truncate">{c.name}</div>
                    <div className="card__meta">
                      {c.lastSelectedAt
                        ? `Last played ${new Date(c.lastSelectedAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric"
                          })}`
                        : "Not played yet"}
                    </div>
                  </div>
                  <Icon.chevron size={18} />
                </div>
              </button>
            ))}
          </div>
        )}
      </Section>

      {lastRound && (
        <Section
          title="Last round"
          action={
            <Link to="/rounds" className="tiny accent bold">
              Review →
            </Link>
          }
        >
          <div className="card">
            <div className="row row--between mb-2">
              <div className="grow">
                <div className="card__title truncate">{lastRound.courseName}</div>
                <div className="card__meta">
                  {new Date(lastRound.round.playedOn).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric"
                  })}
                </div>
              </div>
              <div className="accent" style={{ fontSize: 28, fontWeight: 750, letterSpacing: "-0.03em" }}>
                {relativeToParLabel(lastRound.toPar)}
              </div>
            </div>
            <div className="stat-row">
              <Stat value={lastRound.strokes || "—"} label="Strokes" />
              <Stat value={lastRound.putts || "—"} label="Putts" />
              <Stat value={`${lastRound.scored}`} label="Holes" />
            </div>
          </div>
        </Section>
      )}

      <Section title="Course tools">
        <div className="stack">
          <Link to="/courses" className="list-row">
            <span className="row">
              <Icon.list size={18} />
              <span>All courses</span>
            </span>
            <Icon.chevron size={16} />
          </Link>
          <Link to="/scorecards" className="list-row">
            <span className="row">
              <Icon.list size={18} />
              <span>Scorecards</span>
            </span>
            <Icon.chevron size={16} />
          </Link>
          <Link to="/course-editor" className="list-row">
            <span className="row">
              <Icon.edit size={18} />
              <span>Course editor</span>
            </span>
            <Icon.chevron size={16} />
          </Link>
          <Link to="/imports" className="list-row">
            <span className="row">
              <Icon.upload size={18} />
              <span>Data imports</span>
            </span>
            <Icon.chevron size={16} />
          </Link>
        </div>
      </Section>
    </Page>
  );
}
