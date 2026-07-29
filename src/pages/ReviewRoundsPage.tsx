import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { getHolesForVersion } from "../lib/courseRepo";
import {
  addPenaltyStroke,
  correctShot,
  listCompletedRounds,
  listShotsForRoundHole,
  removePenaltyStroke,
  setShotExcluded,
  setShotTargetPoint
} from "../lib/roundRepo";
import { saveWatchData, setReviewFlagStatus } from "../lib/captureRepo";
import { parseFit } from "../lib/fit";
import { reconcileRound } from "../lib/reconcileRunner";
import { ALL_LIES, LIE_LABELS } from "../lib/lie";
import { distanceYards } from "../lib/geo";
import { ReviewMap } from "../components/ReviewMap";
import { ScorecardSheet } from "../components/RoundSheets";
import { AppBar, Badge, EmptyState, Icon, Page, Stat, relativeToParLabel, scoreToneClass } from "../components/ui";
import type { LatLng, PenaltyType, ReviewFlag, Shot } from "../types/domain";

/** How far apart the FIT time range and the round's shot timestamps may sit before the file is
 * rejected as belonging to a different round — generous, clocks drift by seconds not hours. */
const FIT_OVERLAP_SLACK_MS = 30 * 60 * 1000;

const PENALTY_OPTIONS: { value: PenaltyType; label: string }[] = [
  { value: "lost_ball", label: "Lost ball" },
  { value: "penalty_red", label: "Penalty area (red)" },
  { value: "penalty_yellow", label: "Penalty area (yellow)" },
  { value: "ob", label: "Out of bounds" },
  { value: "unplayable", label: "Unplayable" },
  { value: "stroke_distance", label: "Stroke and distance" }
];

const POSITION_SOURCE_LABELS: Record<Shot["positionSource"], string> = {
  gps: "phone GPS",
  watch_lap: "watch lap",
  watch_track: "watch track",
  manual: "manual",
  tee_fallback: "tee fallback"
};

export function ReviewRoundsPage() {
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [holeNumber, setHoleNumber] = useState(1);
  const [armedShotId, setArmedShotId] = useState<string | null>(null);
  const [armedPenaltyType, setArmedPenaltyType] = useState<PenaltyType | null>(null);
  const [showScorecard, setShowScorecard] = useState(false);
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  const [fitBusy, setFitBusy] = useState(false);
  const [fitMessage, setFitMessage] = useState<string | null>(null);
  const fitInputRef = useRef<HTMLInputElement>(null);

  const completedRounds = useLiveQuery(async () => {
    const rounds = await listCompletedRounds();
    return Promise.all(
      rounds.map(async (round) => {
        const version = await db.courseVersions.get(round.courseVersionId);
        const course = version ? await db.courses.get(version.courseId) : undefined;
        const holes = version ? await getHolesForVersion(version.id) : [];
        const roundHoles = await db.roundHoles.where("roundId").equals(round.id).toArray();
        // Total to-par across only the holes actually scored, so a partial round still summarises.
        let toPar = 0;
        let strokes = 0;
        let scoredHoles = 0;
        for (const h of holes) {
          const rh = roundHoles.find((r) => r.holeId === h.id);
          if (rh?.score != null) {
            toPar += rh.score - h.par;
            strokes += rh.score;
            scoredHoles += 1;
          }
        }
        const flags = await db.reviewFlags.where("roundId").equals(round.id).toArray();
        const openFlags = flags.filter((f) => f.status !== "resolved").length;
        return { round, courseName: course?.name ?? "Unknown course", toPar, strokes, scoredHoles, openFlags };
      })
    );
  }, []);

  const selectedRound =
    useLiveQuery(() => (selectedRoundId ? db.rounds.get(selectedRoundId) : undefined), [selectedRoundId]) ?? null;

  // A round always renders against the geometry it was played on: holes come from the round's
  // own courseVersionId, never "latest".
  // Only the holes the round covers: a nine shouldn't make you step through nine empty holes, and
  // its scorecard shouldn't list them. Rounds recorded before nines existed carry no range and
  // get the whole course, which is what they were.
  const holes = useLiveQuery(async () => {
    if (!selectedRound) return [];
    const all = await getHolesForVersion(selectedRound.courseVersionId);
    return all.filter(
      (h) => h.number >= (selectedRound.startHole ?? -Infinity) && h.number <= (selectedRound.endHole ?? Infinity)
    );
  }, [selectedRound?.courseVersionId, selectedRound?.startHole, selectedRound?.endHole]);
  const currentHole = useMemo(() => holes?.find((h) => h.number === holeNumber), [holes, holeNumber]);
  const firstHoleNumber = holes?.length ? Math.min(...holes.map((h) => h.number)) : 1;
  const maxHoleNumber = holes?.length ? Math.max(...holes.map((h) => h.number)) : 18;

  // Land on the round's first hole rather than hole 1, which a nine may not include.
  useEffect(() => {
    setHoleNumber((n) => Math.min(Math.max(n, firstHoleNumber), maxHoleNumber));
  }, [firstHoleNumber, maxHoleNumber]);

  const allRoundHoles = useLiveQuery(
    () => (selectedRound ? db.roundHoles.where("roundId").equals(selectedRound.id).toArray() : []),
    [selectedRound?.id]
  );
  const currentRoundHole = useMemo(
    () => allRoundHoles?.find((rh) => rh.holeId === currentHole?.id),
    [allRoundHoles, currentHole?.id]
  );

  const shots = useLiveQuery(
    () => (currentRoundHole ? listShotsForRoundHole(currentRoundHole.id) : []),
    [currentRoundHole?.id]
  );

  const teeBoxes = useLiveQuery(
    () => (currentHole ? db.teeBoxes.where("holeId").equals(currentHole.id).toArray() : []),
    [currentHole?.id]
  );
  const fallbackOrigin = teeBoxes?.[0]?.location ?? null;

  const clubs = useLiveQuery(() => db.clubs.toArray(), []);

  const flags = useLiveQuery(
    () => (selectedRound ? db.reviewFlags.where("roundId").equals(selectedRound.id).toArray() : []),
    [selectedRound?.id]
  );
  const pendingFlags = useMemo(() => (flags ?? []).filter((f) => f.status !== "resolved"), [flags]);

  const scorecardEntries = useMemo(() => {
    if (!holes) return [];
    return [...holes]
      .sort((a, b) => a.number - b.number)
      .map((h) => ({
        holeNumber: h.number,
        par: h.par,
        score: allRoundHoles?.find((rh) => rh.holeId === h.id)?.score ?? null
      }));
  }, [holes, allRoundHoles]);

  const roundTotals = useMemo(() => {
    const played = scorecardEntries.filter((e) => e.score !== null);
    const strokes = played.reduce((s, e) => s + (e.score as number), 0);
    const toPar = played.reduce((s, e) => s + ((e.score as number) - e.par), 0);
    return { strokes, toPar, holes: played.length };
  }, [scorecardEntries]);

  useEffect(() => {
    setArmedShotId(null);
    setArmedPenaltyType(null);
    setEditingShotId(null);
  }, [selectedRoundId, currentHole?.id]);
  useEffect(() => {
    setShowScorecard(false);
    setFitMessage(null);
  }, [selectedRoundId]);

  async function handleMapClick(point: LatLng) {
    if (armedShotId) {
      await setShotTargetPoint(armedShotId, point);
      setArmedShotId(null);
      return;
    }
    if (armedPenaltyType && currentRoundHole) {
      await addPenaltyStroke(currentRoundHole.id, armedPenaltyType, point);
      setArmedPenaltyType(null);
    }
  }

  function jumpToFlag(flag: ReviewFlag) {
    const rh = allRoundHoles?.find((r) => r.id === flag.roundHoleId);
    const hole = holes?.find((h) => h.id === rh?.holeId);
    if (hole) setHoleNumber(hole.number);
    if (flag.shotId) setEditingShotId(flag.shotId);
  }

  // --- FIT ingest: parse, overlap-guard, store, compute clock offset, reconcile ---
  async function handleFitFile(file: File) {
    if (!selectedRound) return;
    setFitBusy(true);
    setFitMessage(null);
    try {
      const parsed = await parseFit(file, selectedRound.id);

      const roundHoleIds = (allRoundHoles ?? []).map((rh) => rh.id);
      const roundShots = roundHoleIds.length ? await db.shots.where("roundHoleId").anyOf(roundHoleIds).toArray() : [];
      if (parsed.range) {
        const times = roundShots.map((s) => Date.parse(s.recordedAt)).filter(Number.isFinite);
        if (times.length) {
          const shotStart = Math.min(...times);
          const shotEnd = Math.max(...times);
          if (parsed.range.end < shotStart - FIT_OVERLAP_SLACK_MS || parsed.range.start > shotEnd + FIT_OVERLAP_SLACK_MS) {
            throw new Error(
              `This file covers ${new Date(parsed.range.start).toLocaleString()} – ${new Date(parsed.range.end).toLocaleString()}, ` +
                `but the round's shots span ${new Date(shotStart).toLocaleString()} – ${new Date(shotEnd).toLocaleString()}. Wrong file?`
            );
          }
        } else {
          const fitDay = new Date(parsed.range.start).toISOString().slice(0, 10);
          if (fitDay !== selectedRound.playedOn) {
            throw new Error(`This file is from ${fitDay}, but the round was played on ${selectedRound.playedOn}. Wrong file?`);
          }
        }
      }

      // Clock offset from the calibration press when one was made; reconcile estimates otherwise.
      let clockOffsetMs: number | null = null;
      if (selectedRound.watchCalibrationAt && parsed.laps.length) {
        const calibT = Date.parse(selectedRound.watchCalibrationAt);
        let nearest = parsed.laps[0];
        for (const lap of parsed.laps) {
          if (Math.abs(Date.parse(lap.tWatch) - calibT) < Math.abs(Date.parse(nearest.tWatch) - calibT)) nearest = lap;
        }
        clockOffsetMs = Date.parse(nearest.tWatch) - calibT;
      }

      await saveWatchData({
        roundId: selectedRound.id,
        laps: parsed.laps,
        track: parsed.track,
        activityId: parsed.activityId,
        clockOffsetMs
      });
      const summary = await reconcileRound(selectedRound.id);
      setFitMessage(
        `Ingested ${parsed.laps.length} laps → ${summary.shotCount} shots, ${summary.flagCount} flag(s). ` +
          `Clock offset ${(summary.clockOffsetMs / 1000).toFixed(1)}s (${summary.clockOffsetMethod.replace(/_/g, " ")}).`
      );
    } catch (e) {
      setFitMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setFitBusy(false);
    }
  }

  async function handleRerunReconcile() {
    if (!selectedRound) return;
    setFitBusy(true);
    try {
      const summary = await reconcileRound(selectedRound.id);
      setFitMessage(`Re-reconciled: ${summary.shotCount} shots, ${summary.flagCount} flag(s).`);
    } catch (e) {
      setFitMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setFitBusy(false);
    }
  }

  // ---------------------------------------------------------------- round list
  if (!selectedRoundId) {
    return (
      <Page>
        <AppBar title="Rounds" subtitle={completedRounds ? `${completedRounds.length} completed` : undefined} />
        {!completedRounds ? (
          <div className="card dim small">Loading rounds…</div>
        ) : completedRounds.length === 0 ? (
          <EmptyState icon="🏁" title="No completed rounds yet">
            Finish a round — hole out on the last hole — and it lands here for review.
          </EmptyState>
        ) : (
          <div className="stack">
            {completedRounds.map(({ round, courseName, toPar, strokes, scoredHoles, openFlags }) => (
              <button
                key={round.id}
                className="card card--interactive"
                onClick={() => {
                  setSelectedRoundId(round.id);
                  setHoleNumber(1);
                }}
              >
                <div className="row row--between mb-2">
                  <div className="grow">
                    <div className="card__title truncate">{courseName}</div>
                    <div className="card__meta">
                      {new Date(round.playedOn).toLocaleDateString(undefined, {
                        weekday: "short",
                        year: "numeric",
                        month: "short",
                        day: "numeric"
                      })}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="accent num" style={{ fontSize: 24, fontWeight: 750, letterSpacing: "-0.03em" }}>
                      {relativeToParLabel(toPar)}
                    </div>
                    <div className="tiny faint num">{strokes} strokes</div>
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Badge>{scoredHoles} holes</Badge>
                  {round.fitIngestedAt && <Badge tone="info">Watch data</Badge>}
                  {openFlags > 0 && <Badge tone="warn">{openFlags} to review</Badge>}
                </div>
              </button>
            ))}
          </div>
        )}
      </Page>
    );
  }

  // Round selected but the row hasn't resolved yet — hold the frame rather than
  // flashing the list back at the user.
  if (!selectedRound) {
    return (
      <Page>
        <AppBar title="Round" onBack={() => setSelectedRoundId(null)} />
        <div className="card dim small row">
          <span className="spinner" /> Loading round…
        </div>
      </Page>
    );
  }

  // -------------------------------------------------------------- round detail
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", flex: "0 0 42%", minHeight: 240 }}>
        <button
          className="map-btn glass"
          onClick={() => setSelectedRoundId(null)}
          style={{ position: "absolute", top: "calc(12px + var(--safe-t))", left: 12, zIndex: 4 }}
          aria-label="Back to rounds"
        >
          <Icon.back size={19} />
        </button>
        <button
          className="btn btn--sm glass"
          onClick={() => setShowScorecard(true)}
          style={{ position: "absolute", top: "calc(12px + var(--safe-t))", right: 12, zIndex: 4 }}
        >
          Scorecard
        </button>
        {currentHole && (
          <div className="hole-bar glass">
            <button
              className="hole-bar__nav"
              onClick={() => setHoleNumber((n) => Math.max(firstHoleNumber, n - 1))}
              disabled={holeNumber <= firstHoleNumber}
            >
              ‹
            </button>
            <span className="hole-bar__label">
              {currentHole.number}
              <span className="hole-bar__par">
                {" · "}Par {currentHole.par}
              </span>
            </span>
            <button
              className="hole-bar__nav"
              onClick={() => setHoleNumber((n) => Math.min(maxHoleNumber, n + 1))}
              disabled={holeNumber >= maxHoleNumber}
            >
              ›
            </button>
          </div>
        )}
        {armedPenaltyType && (
          <div className="toast glass" style={{ top: "auto", bottom: 12, color: "var(--warn)" }}>
            Tap the map where the penalty happened
          </div>
        )}
        <ReviewMap
          shots={shots ?? []}
          fallbackOrigin={fallbackOrigin}
          armedShotId={armedShotId}
          clickArmed={armedPenaltyType !== null}
          onMapClick={handleMapClick}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto", background: "var(--bg)" }}>
        <div style={{ padding: "14px 16px 28px", maxWidth: 720, margin: "0 auto" }}>
          {/* Round summary */}
          <div className="stat-row mb-3">
            <Stat value={roundTotals.strokes || "—"} label="Strokes" />
            <Stat value={relativeToParLabel(roundTotals.toPar)} label="To par" />
            <Stat
              value={
                currentRoundHole?.score != null ? (
                  <span className={scoreToneClass(currentRoundHole.score, currentHole?.par ?? 4)}>{currentRoundHole.score}</span>
                ) : (
                  "—"
                )
              }
              label={`Hole ${holeNumber}`}
            />
          </div>

          {/* Watch ingest */}
          <div className="row row--wrap mb-2" style={{ gap: 8 }}>
            <input
              ref={fitInputRef}
              type="file"
              accept=".fit,application/octet-stream"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) handleFitFile(file);
              }}
            />
            <button className="btn btn--sm" onClick={() => fitInputRef.current?.click()} disabled={fitBusy}>
              <Icon.watch size={15} /> {selectedRound.fitIngestedAt ? "Re-attach watch file" : "Attach watch file"}
            </button>
            {selectedRound.fitIngestedAt && (
              <button className="btn btn--sm btn--ghost" onClick={handleRerunReconcile} disabled={fitBusy}>
                Re-run reconciliation
              </button>
            )}
            {fitBusy && <span className="spinner" />}
          </div>
          {fitMessage && (
            <div className="mb-3">
              <div className="note note--ok">{fitMessage}</div>
            </div>
          )}

          {/* Flag queue */}
          {pendingFlags.length > 0 && (
            <div className="mb-3">
              <div className="section__title mb-2">
                {pendingFlags.length} item{pendingFlags.length === 1 ? "" : "s"} to review
              </div>
              <div className="stack" style={{ gap: 6 }}>
                {pendingFlags.map((f) => {
                  const rh = allRoundHoles?.find((r) => r.id === f.roundHoleId);
                  const hole = holes?.find((h) => h.id === rh?.holeId);
                  return (
                    <div key={f.id} className="list-row" style={{ borderColor: "rgba(255,192,67,.28)", background: "var(--warn-soft)" }}>
                      <button className="row grow" style={{ background: "none", border: "none", textAlign: "left", padding: 0 }} onClick={() => jumpToFlag(f)}>
                        <Badge tone="warn">H{hole?.number ?? "?"}</Badge>
                        <span className="small grow">{f.detail}</span>
                      </button>
                      <button className="map-btn" style={{ width: 30, height: 30, color: "var(--accent)" }} onClick={() => setReviewFlagStatus(f.id, "resolved")} title="Mark resolved">
                        <Icon.check size={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Penalty entry */}
          <div className="row mb-3" style={{ gap: 8 }}>
            <span className="small dim" style={{ flex: "none" }}>
              Penalty
            </span>
            <select
              className="field grow"
              value={armedPenaltyType ?? ""}
              onChange={(e) => setArmedPenaltyType((e.target.value || null) as PenaltyType | null)}
              style={{ padding: "8px 10px" }}
            >
              <option value="">Add… then tap the map</option>
              {PENALTY_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Shot list */}
          <div className="section__title mb-2">Shots</div>
          {!shots?.length ? (
            <div className="note">No shots recorded for this hole.</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {shots.map((s) => {
                const club = clubs?.find((c) => c.id === s.clubId);
                const isEditing = editingShotId === s.id;
                // Putts are measured in feet, everything else in yards — the units golfers
                // actually use, and the ones the rest of the app stores.
                const rawYards = s.endPoint ? distanceYards(s.startPoint, s.endPoint) : null;
                const distLabel =
                  rawYards === null ? null : s.swingType === "putt" ? `${Math.round(rawYards * 3)}ft` : `${Math.round(rawYards)}y`;
                const badPosition = s.positionSource === "tee_fallback" || (s.accuracyM !== null && s.accuracyM > 15);
                return (
                  <div key={s.id} className="card card--tight">
                    <div className="row row--between">
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <span className="bold">
                            {s.penaltyType
                              ? PENALTY_OPTIONS.find((p) => p.value === s.penaltyType)?.label ?? "Penalty"
                              : `${s.shotNumber}. ${club?.name ?? (s.reconciliation === "lap_only" ? "Club?" : "—")}`}
                          </span>
                          {s.swingType === "putt" && <Badge>putt</Badge>}
                          {s.swingType === "partial" && <Badge tone="info">partial</Badge>}
                          {s.penaltyType && <Badge tone="danger">+1</Badge>}
                          {s.excluded && <Badge tone="warn">excluded</Badge>}
                        </div>
                        <div className="tiny faint mt-1">
                          {s.lieStart ? LIE_LABELS[s.lieStart] : "—"}
                          {distLabel !== null && !s.penaltyType ? ` · ${distLabel}` : ""}
                          {` · ${POSITION_SOURCE_LABELS[s.positionSource]}`}
                          {s.targetPoint ? ` · target ${s.targetSource.replace("default_", "")}` : ""}
                          {s.userEdited ? " · edited" : ""}
                        </div>
                        {badPosition && (
                          <div className="tiny danger mt-1">
                            {s.positionSource === "tee_fallback" ? "No GPS — recorded at the tee box" : "Low GPS accuracy"} · not in stats
                          </div>
                        )}
                      </div>
                      <button className="btn btn--sm btn--ghost" onClick={() => setEditingShotId(isEditing ? null : s.id)}>
                        {isEditing ? "Done" : "Edit"}
                      </button>
                    </div>

                    {isEditing && (
                      <div className="mt-2">
                        {s.penaltyType ? (
                          <button className="btn btn--sm btn--danger" onClick={() => removePenaltyStroke(s.id)}>
                            <Icon.trash size={14} /> Remove penalty
                          </button>
                        ) : (
                          <>
                            <div className="tiny faint mb-1">Club</div>
                            <div className="chip-row mb-2">
                              {clubs?.map((c) => (
                                <button
                                  key={c.id}
                                  className={`chip chip--sm${s.clubId === c.id ? " chip--active" : ""}`}
                                  onClick={() => correctShot(s.id, { clubId: c.id })}
                                >
                                  {c.name}
                                </button>
                              ))}
                            </div>
                            <div className="tiny faint mb-1">Lie</div>
                            <div className="chip-row mb-2">
                              {ALL_LIES.map((l) => (
                                <button
                                  key={l}
                                  className={`chip chip--sm${s.lieStart === l ? " chip--active" : ""}`}
                                  onClick={() => correctShot(s.id, { lieStart: l })}
                                >
                                  {LIE_LABELS[l]}
                                </button>
                              ))}
                            </div>
                            <div className="row row--wrap" style={{ gap: 8 }}>
                              <button
                                className={`btn btn--sm${armedShotId === s.id ? " btn--primary" : ""}`}
                                onClick={() => setArmedShotId((id) => (id === s.id ? null : s.id))}
                              >
                                <Icon.target size={14} /> {armedShotId === s.id ? "Tap map…" : "Set target"}
                              </button>
                              <button className="btn btn--sm btn--ghost" onClick={() => setShotExcluded(s.id, s.excluded === null)}>
                                {s.excluded === null ? "Exclude from stats" : "Include in stats"}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showScorecard && <ScorecardSheet entries={scorecardEntries} onClose={() => setShowScorecard(false)} />}
    </div>
  );
}
