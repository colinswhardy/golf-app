import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { getFeaturesForHole, getHolesForVersion } from "../lib/courseRepo";
import { greenCentroidOf } from "../lib/targets";
import {
  addPenaltyStroke,
  correctShot,
  deleteHandEnteredShot,
  discardRound,
  insertShot,
  listCompletedRounds,
  listShotsForRoundHole,
  moveShotStart,
  removePenaltyStroke,
  saveGreenMarks,
  setRoundHoleScore,
  setShotExcluded,
  setShotTargetPoint,
  swapShotOrder
} from "../lib/roundRepo";
import { saveWatchData, setReviewFlagStatus } from "../lib/captureRepo";
import { parseFit } from "../lib/fit";
import { reconcileRound } from "../lib/reconcileRunner";
import { ALL_LIES, LIE_LABELS, detectLie } from "../lib/lie";
import { distanceYards } from "../lib/geo";
import { getTeePreference } from "../lib/settings";
import { ReviewMap } from "../components/ReviewMap";
import { GreenMap } from "../components/GreenMap";
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

/** " (N laps matched shots you logged)" for the ingest message, or nothing when none did. */
function describeMerges(n: number): string {
  if (n === 0) return "";
  return ` (${n} lap${n === 1 ? "" : "s"} matched shots you logged on the phone)`;
}

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
  // The shot waiting for a map tap, and what the tap will do to it: set where it was aimed, or
  // move where it was played from (the watch pressed late, a phone fix that drifted).
  const [armed, setArmed] = useState<{ shotId: string; action: "target" | "move" } | null>(null);
  const [armedPenaltyType, setArmedPenaltyType] = useState<PenaltyType | null>(null);
  // "Add shot": the next map tap becomes a new stroke on this hole (forgot to log one at the time).
  const [addingShot, setAddingShot] = useState(false);
  const [greenEditorOpen, setGreenEditorOpen] = useState(false);
  const [showScorecard, setShowScorecard] = useState(false);
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [fitBusy, setFitBusy] = useState(false);
  const [fitMessage, setFitMessage] = useState<string | null>(null);
  // Abandoning a COMPLETED round. Home already offers this for a round still in progress
  // (Home.tsx), but a finished one had no way out — so every test round stayed in the history and
  // in the stats averages forever. Same `discardRound` cascade behind it.
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);
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
  const holeFeatures = useLiveQuery(() => (currentHole ? getFeaturesForHole(currentHole.id) : []), [currentHole?.id]);
  // Where "Move to tee" puts a shot — the same box the round map plays from: the chosen tee set
  // when this hole has it, otherwise the backmost one (courses map a dozen unnamed "Tee" points
  // per hole, so offering each would be noise).
  const teeLocation = useMemo(() => {
    if (!teeBoxes?.length) return null;
    const preferred = teeBoxes.find((t) => t.name === getTeePreference());
    if (preferred) return preferred.location;
    const green = currentHole?.greenPoint ?? (holeFeatures?.length ? greenCentroidOf(holeFeatures) : null);
    if (!green) return teeBoxes[0].location;
    return [...teeBoxes].sort((a, b) => distanceYards(b.location, green) - distanceYards(a.location, green))[0].location;
  }, [teeBoxes, holeFeatures, currentHole?.greenPoint]);

  const clubs = useLiveQuery(() => db.clubs.toArray(), []);

  const flags = useLiveQuery(
    () => (selectedRound ? db.reviewFlags.where("roundId").equals(selectedRound.id).toArray() : []),
    [selectedRound?.id]
  );
  const pendingFlags = useMemo(() => (flags ?? []).filter((f) => f.status !== "resolved"), [flags]);
  // Flags belong with the hole they're about: hole-level ones (score balance) sit above that
  // hole's shot list, shot-level ones inside the shot's own card. Other holes' open flags are
  // only pointed at, so the reader isn't shown a queue for the whole round on every hole.
  const holeFlags = useMemo(
    () => pendingFlags.filter((f) => f.roundHoleId === currentRoundHole?.id),
    [pendingFlags, currentRoundHole?.id]
  );
  const shotIds = useMemo(() => new Set((shots ?? []).map((s) => s.id)), [shots]);
  const holeLevelFlags = holeFlags.filter((f) => !f.shotId || !shotIds.has(f.shotId));
  const flagsByShot = useMemo(() => {
    const m = new Map<string, ReviewFlag[]>();
    for (const f of holeFlags) {
      if (!f.shotId) continue;
      m.set(f.shotId, [...(m.get(f.shotId) ?? []), f]);
    }
    return m;
  }, [holeFlags]);
  /** Hole numbers (other than the current one) that still have something open, ascending. */
  const otherFlaggedHoles = useMemo(() => {
    const nums = new Set<number>();
    for (const f of pendingFlags) {
      const rh = allRoundHoles?.find((r) => r.id === f.roundHoleId);
      const hole = holes?.find((h) => h.id === rh?.holeId);
      if (hole && hole.number !== holeNumber) nums.add(hole.number);
    }
    return [...nums].sort((a, b) => a - b);
  }, [pendingFlags, allRoundHoles, holes, holeNumber]);
  const flaggedHoleNumbers = useMemo(() => new Set([...otherFlaggedHoles, ...(holeFlags.length ? [holeNumber] : [])]), [otherFlaggedHoles, holeFlags.length, holeNumber]);

  // Strokes as the hole's rows account for them, against the score the player counted. Shown
  // when they disagree so a putt or stroke edit here can be squared with the score in one tap.
  const accounted = useMemo(() => {
    const rows = shots ?? [];
    return {
      swings: rows.filter((s) => s.swingType !== "putt" && s.penaltyType === null).length,
      putts: rows.filter((s) => s.swingType === "putt").length,
      penalties: rows.filter((s) => s.penaltyType !== null).length
    };
  }, [shots]);
  const accountedTotal = accounted.swings + accounted.putts + accounted.penalties;
  const puttStarts = useMemo(
    () => (shots ?? []).filter((s) => s.reconciliation === "green_mark").map((s) => s.startPoint),
    [shots]
  );
  /** The reorderable sequence: strokes only, in display order. */
  const strokeRows = useMemo(() => (shots ?? []).filter((s) => s.swingType !== "putt" && s.penaltyType === null), [shots]);
  const greenPolygon = useMemo(
    () => (holeFeatures?.find((f) => f.featureType === "green" && f.geometry.type === "Polygon")?.geometry as GeoJSON.Polygon | undefined) ?? null,
    [holeFeatures]
  );
  const greenCentroid = useMemo(() => (holeFeatures?.length ? greenCentroidOf(holeFeatures) : null), [holeFeatures]);

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
    setArmed(null);
    setArmedPenaltyType(null);
    setAddingShot(false);
    setGreenEditorOpen(false);
    setEditingShotId(null);
    setConfirmDeleteId(null);
  }, [selectedRoundId, currentHole?.id]);
  useEffect(() => {
    setShowScorecard(false);
    setFitMessage(null);
  }, [selectedRoundId]);

  // Desktop affordances: ←/→ step through the holes, Esc drops whatever is armed. Ignored while
  // a form control has focus so the penalty select keeps its own arrow-key behaviour.
  useEffect(() => {
    if (!selectedRoundId) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName) || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") setHoleNumber((n) => Math.max(firstHoleNumber, n - 1));
      else if (e.key === "ArrowRight") setHoleNumber((n) => Math.min(maxHoleNumber, n + 1));
      else if (e.key === "Escape") {
        setArmed(null);
        setArmedPenaltyType(null);
        setAddingShot(false);
        setConfirmDeleteId(null);
        setShowScorecard(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRoundId, firstHoleNumber, maxHoleNumber]);

  // A flag jump lands on another hole whose rows load asynchronously, so scroll the shot's card
  // into view once it exists. "nearest" leaves the panel alone when the card is already visible.
  useEffect(() => {
    if (!editingShotId) return;
    document.getElementById(`shot-${editingShotId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [editingShotId, shots]);

  const selectedSummary = completedRounds?.find((r) => r.round.id === selectedRoundId) ?? null;

  async function handleMapClick(point: LatLng) {
    if (armed) {
      if (armed.action === "target") await setShotTargetPoint(armed.shotId, point);
      else await moveShotStart(armed.shotId, point);
      setArmed(null);
      return;
    }
    if (addingShot && currentRoundHole) {
      setAddingShot(false);
      // Straight into edit so the club (unknown — that's why it was forgotten) gets picked next.
      const shot = await insertShot({ roundHoleId: currentRoundHole.id, point, lie: detectLie(point, holeFeatures ?? []) });
      setEditingShotId(shot.id);
      return;
    }
    if (armedPenaltyType && currentRoundHole) {
      await addPenaltyStroke(currentRoundHole.id, armedPenaltyType, point);
      setArmedPenaltyType(null);
    }
  }

  /** Toggles the map-tap arming for one shot; arming one action disarms the other. */
  function toggleArmed(shotId: string, action: "target" | "move") {
    setAddingShot(false);
    setArmed((cur) => (cur?.shotId === shotId && cur.action === action ? null : { shotId, action }));
  }

  async function handleGreenFinish(pin: LatLng, starts: LatLng[]) {
    if (!currentRoundHole) return;
    await saveGreenMarks({ roundHoleId: currentRoundHole.id, pin, puttStarts: starts, detectLieAt: (p) => detectLie(p, holeFeatures ?? []) });
    setGreenEditorOpen(false);
  }

  async function handleDeleteShot(shot: Shot) {
    setConfirmDeleteId(null);
    if (editingShotId === shot.id) setEditingShotId(null);
    if (armed?.shotId === shot.id) setArmed(null);
    await deleteHandEnteredShot(shot.id);
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
        `Ingested ${parsed.laps.length} laps → ${summary.shotCount} shots${describeMerges(summary.handEnteredMerges)}, ` +
          `${summary.flagCount} flag(s). ` +
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
      setFitMessage(`Re-reconciled: ${summary.shotCount} shots${describeMerges(summary.handEnteredMerges)}, ${summary.flagCount} flag(s).`);
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
              <div key={round.id} className="row" style={{ gap: 8, alignItems: "stretch" }}>
              <button
                className="card card--interactive grow"
                style={{ minWidth: 0 }}
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
              <button
                className="map-btn"
                style={{ width: 32, alignSelf: "center", color: "var(--danger)" }}
                onClick={() => setConfirmDiscardId(round.id)}
                aria-label={`Abandon ${courseName} round`}
              >
                <Icon.trash size={15} />
              </button>
              </div>
            ))}

            {confirmDiscardId && (
              <div className="card" style={{ borderColor: "rgba(255,107,107,.3)" }}>
                <div className="small mb-2">
                  Abandon this round? Its scores, shots, watch laps and any review flags are deleted
                  outright — this one is not recoverable, unlike removing a course.
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn btn--sm btn--danger"
                    onClick={async () => {
                      await discardRound(confirmDiscardId);
                      setConfirmDiscardId(null);
                    }}
                  >
                    Abandon
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={() => setConfirmDiscardId(null)}>
                    Keep
                  </button>
                </div>
              </div>
            )}
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
  const playedOnLabel = new Date(selectedRound.playedOn).toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric"
  });

  return (
    <div className="review-layout">
      <section className="review-panel">
        {/* Wide-screen header: the map's floating chrome moves in here, plus a hole strip that
            only makes sense with room to spare. Hidden on the phone by CSS. */}
        <div className="review-panel__head">
          <AppBar
            title={selectedSummary?.courseName ?? "Round"}
            subtitle={`${playedOnLabel}${roundTotals.strokes ? ` · ${roundTotals.strokes} strokes · ${relativeToParLabel(roundTotals.toPar)}` : ""}`}
            onBack={() => setSelectedRoundId(null)}
            actions={
              <button className="btn btn--sm" onClick={() => setShowScorecard(true)}>
                Scorecard
              </button>
            }
          />
          <div className="review-hole-strip" role="tablist" aria-label="Holes">
            {scorecardEntries.map((e) => (
              <button
                key={e.holeNumber}
                role="tab"
                aria-selected={e.holeNumber === holeNumber}
                className={`${e.score !== null ? scoreToneClass(e.score, e.par) : "score-dot score-dot--none"}${
                  e.holeNumber === holeNumber ? " is-active" : ""
                }${flaggedHoleNumbers.has(e.holeNumber) ? " has-flags" : ""}`}
                onClick={() => setHoleNumber(e.holeNumber)}
                title={`Hole ${e.holeNumber} · Par ${e.par}${e.score !== null ? ` · ${e.score}` : ""}${
                  flaggedHoleNumbers.has(e.holeNumber) ? " · to review" : ""
                }`}
              >
                {e.holeNumber}
              </button>
            ))}
          </div>
        </div>

        <div className="review-panel__scroll">
        <div className="review-panel__body">
          {/* Round summary + this hole's score, editable in place */}
          <div className="stat-row mb-3">
            <Stat value={roundTotals.strokes || "—"} label="Strokes" />
            <Stat value={relativeToParLabel(roundTotals.toPar)} label="To par" />
            <div className="stat">
              <div className="row" style={{ gap: 6, alignItems: "center" }}>
                <button
                  className="map-btn"
                  style={{ width: 26, height: 26, fontSize: 15 }}
                  onClick={() => currentRoundHole && setRoundHoleScore(currentRoundHole.id, Math.max(1, (currentRoundHole.score ?? currentHole?.par ?? 4) - 1))}
                  disabled={!currentRoundHole || (currentRoundHole.score ?? 0) <= 1}
                  aria-label="Score down"
                >
                  −
                </button>
                <span className="stat__value" style={{ minWidth: 28, textAlign: "center" }}>
                  {currentRoundHole?.score != null ? (
                    <span className={scoreToneClass(currentRoundHole.score, currentHole?.par ?? 4)}>{currentRoundHole.score}</span>
                  ) : (
                    "—"
                  )}
                </span>
                <button
                  className="map-btn"
                  style={{ width: 26, height: 26, fontSize: 15 }}
                  onClick={() => currentRoundHole && setRoundHoleScore(currentRoundHole.id, (currentRoundHole.score ?? currentHole?.par ?? 4) + 1)}
                  disabled={!currentRoundHole}
                  aria-label="Score up"
                >
                  +
                </button>
              </div>
              <div className="stat__label">{currentHole ? `Hole ${holeNumber} · Par ${currentHole.par}` : `Hole ${holeNumber}`}</div>
            </div>
          </div>
          {/* The rows and the count disagree — after a putt or stroke edit here, or a miscount
              at hole-out. One tap squares them; the reader decides which side was right. */}
          {currentRoundHole?.score != null && accountedTotal > 0 && accountedTotal !== currentRoundHole.score && (
            <div className="note note--warn mb-3 row row--between" style={{ gap: 8 }}>
              <span className="small">
                Recorded: {accounted.swings} shot{accounted.swings === 1 ? "" : "s"} + {accounted.putts} putt{accounted.putts === 1 ? "" : "s"}
                {accounted.penalties ? ` + ${accounted.penalties} penalt${accounted.penalties === 1 ? "y" : "ies"}` : ""} = {accountedTotal}
              </span>
              <button className="btn btn--sm" onClick={() => currentRoundHole && setRoundHoleScore(currentRoundHole.id, accountedTotal)}>
                Set score to {accountedTotal}
              </button>
            </div>
          )}

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

          {/* Penalty entry */}
          <div className="row mb-3" style={{ gap: 8 }}>
            <span className="small dim" style={{ flex: "none" }}>
              Penalty
            </span>
            <select
              className="field grow"
              value={armedPenaltyType ?? ""}
              onChange={(e) => {
                setAddingShot(false);
                setArmedPenaltyType((e.target.value || null) as PenaltyType | null);
              }}
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

          {/* This hole's own review items. Score-balance flags live here; a flag about one shot is
              shown inside that shot's card below. */}
          {holeLevelFlags.length > 0 && (
            <div className="stack mb-3" style={{ gap: 6 }}>
              {holeLevelFlags.map((f) => (
                <div key={f.id} className="list-row" style={{ borderColor: "rgba(255,192,67,.28)", background: "var(--warn-soft)" }}>
                  <span className="warn" style={{ display: "flex", flex: "none" }}>
                    <Icon.warn size={16} />
                  </span>
                  <span className="small grow">{f.detail}</span>
                  <button className="map-btn" style={{ width: 30, height: 30, color: "var(--accent)" }} onClick={() => setReviewFlagStatus(f.id, "resolved")} title="Mark resolved">
                    <Icon.check size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Shot list */}
          <div className="row row--between mb-2" style={{ gap: 8 }}>
            <span className="section__title">Shots</span>
            <div className="row" style={{ gap: 6 }}>
              <button
                className={`btn btn--sm${addingShot ? " btn--primary" : ""}`}
                onClick={() => {
                  setArmed(null);
                  setArmedPenaltyType(null);
                  setAddingShot((v) => !v);
                }}
                disabled={!currentRoundHole}
              >
                <Icon.plus size={14} /> {addingShot ? "Tap map…" : "Add shot"}
              </button>
              <button className="btn btn--sm btn--ghost" onClick={() => setGreenEditorOpen(true)} disabled={!currentRoundHole}>
                <Icon.pin size={14} /> {puttStarts.length || currentRoundHole?.pinLocation ? "Edit green" : "Mark green"}
              </button>
            </div>
          </div>
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
                const isArmedFor = (action: "target" | "move") => armed?.shotId === s.id && armed.action === action;
                const strokeIndex = strokeRows.findIndex((r) => r.id === s.id);
                const strokeCount = strokeRows.length;
                return (
                  <div key={s.id} id={`shot-${s.id}`} className="card card--tight">
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
                          {/* A Shot-sheet row that took its position from a watch press: one
                              stroke, two records, and the reader can see both were there. */}
                          {s.reconciliation === "manual" && s.positionSource === "watch_lap" ? " + phone log" : ""}
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

                    {/* Review items about this shot, right where the fix happens (Edit is a tap away). */}
                    {(flagsByShot.get(s.id) ?? []).map((f) => (
                      <div key={f.id} className="row mt-2" style={{ gap: 8, padding: "6px 10px", borderRadius: "var(--r-sm)", background: "var(--warn-soft)" }}>
                        <span className="warn" style={{ display: "flex", flex: "none" }}>
                          <Icon.warn size={14} />
                        </span>
                        <span className="tiny grow">{f.detail}</span>
                        <button className="map-btn" style={{ width: 26, height: 26, color: "var(--accent)" }} onClick={() => setReviewFlagStatus(f.id, "resolved")} title="Mark resolved">
                          <Icon.check size={14} />
                        </button>
                      </div>
                    ))}

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
                            <div className="tiny faint mb-1">Position</div>
                            <div className="row row--wrap mb-2" style={{ gap: 8 }}>
                              <button
                                className={`btn btn--sm${isArmedFor("move") ? " btn--primary" : ""}`}
                                onClick={() => toggleArmed(s.id, "move")}
                              >
                                <Icon.pin size={14} /> {isArmedFor("move") ? "Tap map…" : "Move shot"}
                              </button>
                              {/* Snapping to the tee is the common correction (the watch pressed
                                  after walking off the box), so it's one tap for tee shots. */}
                              {(s.shotNumber === 1 || s.lieStart === "tee") && s.swingType !== "putt" && teeLocation && (
                                <button className="btn btn--sm btn--ghost" onClick={() => moveShotStart(s.id, teeLocation, "tee")}>
                                  Move to tee
                                </button>
                              )}
                            </div>
                            <div className="row row--wrap" style={{ gap: 8 }}>
                              <button
                                className={`btn btn--sm${isArmedFor("target") ? " btn--primary" : ""}`}
                                onClick={() => toggleArmed(s.id, "target")}
                              >
                                <Icon.target size={14} /> {isArmedFor("target") ? "Tap map…" : "Set target"}
                              </button>
                              {/* Order fix for an added stroke that landed one slot off. Putts keep
                                  their marked order and penalties sit where they were incurred. */}
                              {s.swingType !== "putt" && (
                                <>
                                  <button className="btn btn--sm btn--ghost" onClick={() => swapShotOrder(s.id, -1)} disabled={strokeIndex <= 0} title="Move earlier in the hole">
                                    ↑ Earlier
                                  </button>
                                  <button className="btn btn--sm btn--ghost" onClick={() => swapShotOrder(s.id, 1)} disabled={strokeIndex < 0 || strokeIndex >= strokeCount - 1} title="Move later in the hole">
                                    ↓ Later
                                  </button>
                                </>
                              )}
                              <button className="btn btn--sm btn--ghost" onClick={() => setShotExcluded(s.id, s.excluded === null)}>
                                {s.excluded === null ? "Exclude from stats" : "Include in stats"}
                              </button>
                              {/* Only Shot-sheet rows can go: a reconciled row would come straight
                                  back from its lap on the next run. */}
                              {s.reconciliation === "manual" && (
                                <button className="btn btn--sm btn--danger" onClick={() => setConfirmDeleteId(s.id)}>
                                  <Icon.trash size={14} /> Delete
                                </button>
                              )}
                            </div>
                            {confirmDeleteId === s.id && (
                              <div className="card mt-2" style={{ borderColor: "rgba(255,107,107,.3)" }}>
                                <div className="small mb-2">
                                  Delete shot {s.shotNumber}? The strokes after it move up one; the hole score stays as
                                  you counted it.
                                </div>
                                <div className="row" style={{ gap: 8 }}>
                                  <button className="btn btn--sm btn--danger" onClick={() => handleDeleteShot(s)}>
                                    Delete
                                  </button>
                                  <button className="btn btn--sm btn--ghost" onClick={() => setConfirmDeleteId(null)}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Where else the round still needs a look — a pointer, not a queue. */}
          {otherFlaggedHoles.length > 0 && (
            <div className="row row--wrap mt-3" style={{ gap: 6, alignItems: "center" }}>
              <span className="tiny faint">Also to review:</span>
              {otherFlaggedHoles.map((n) => (
                <button key={n} className="chip chip--sm" onClick={() => setHoleNumber(n)}>
                  <Icon.warn size={12} /> Hole {n}
                </button>
              ))}
            </div>
          )}
        </div>
        </div>
      </section>

      <div className="review-map">
        {/* Phone chrome, floating over the map. On wide screens the panel header carries these. */}
        <div className="review-map__mobile-chrome">
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
                aria-label="Previous hole"
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
                aria-label="Next hole"
              >
                ›
              </button>
            </div>
          )}
        </div>
        {armedPenaltyType && (
          <div className="toast glass" style={{ top: "auto", bottom: 12, color: "var(--warn)" }}>
            Tap the map where the penalty happened
          </div>
        )}
        {addingShot && (
          <div className="toast glass" style={{ top: "auto", bottom: 12, color: "var(--warn)" }}>
            Tap the map where the shot was played from
          </div>
        )}
        <ReviewMap
          shots={shots ?? []}
          fallbackOrigin={fallbackOrigin}
          armedShotId={armed?.shotId ?? null}
          armedAction={armed?.action}
          clickArmed={armedPenaltyType !== null || addingShot}
          onMapClick={handleMapClick}
        />
      </div>

      {showScorecard && <ScorecardSheet entries={scorecardEntries} onClose={() => setShowScorecard(false)} />}

      {/* Pin + putts, on the same screen the round uses at hole-out — existing marks pre-placed
          so a fix is a nudge. Fixed to the viewport so it covers both layouts (and the nav). */}
      {greenEditorOpen && currentHole && currentRoundHole && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60 }}>
          <GreenMap
            greenPolygon={greenPolygon}
            fallbackCenter={currentRoundHole.pinLocation ?? currentHole.greenPoint ?? greenCentroid ?? fallbackOrigin ?? { lat: 43.55, lng: -80.2 }}
            initialPin={currentRoundHole.pinLocation}
            initialPuttStarts={puttStarts}
            holeNumber={currentHole.number}
            onFinish={handleGreenFinish}
            onClose={() => setGreenEditorOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
