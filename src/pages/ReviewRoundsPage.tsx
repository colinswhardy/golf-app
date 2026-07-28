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
import { setReviewFlagStatus } from "../lib/captureRepo";
import { saveWatchData } from "../lib/captureRepo";
import { parseFit } from "../lib/fit";
import { reconcileRound } from "../lib/reconcileRunner";
import { ALL_LIES, LIE_LABELS } from "../lib/lie";
import { distanceYards } from "../lib/geo";
import { ReviewMap } from "../components/ReviewMap";
import { ScorecardSheet, relativeToParLabel } from "../components/RoundSheets";
import { PageHeader } from "../components/PageHeader";
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
        // Total to-par across only the holes actually scored, so a partial round still summarizes.
        let toPar = 0;
        let scoredHoles = 0;
        for (const h of holes) {
          const rh = roundHoles.find((r) => r.holeId === h.id);
          if (rh?.score != null) {
            toPar += rh.score - h.par;
            scoredHoles += 1;
          }
        }
        return { round, courseName: course?.name ?? "Unknown course", toPar, scoredHoles };
      })
    );
  }, []);

  const selectedRound =
    useLiveQuery(() => (selectedRoundId ? db.rounds.get(selectedRoundId) : undefined), [selectedRoundId]) ?? null;

  // A round always renders against the geometry it was played on: holes come from the round's
  // own courseVersionId, never "latest" (REVISION-SPEC 0.2).
  const holes = useLiveQuery(
    () => (selectedRound ? getHolesForVersion(selectedRound.courseVersionId) : []),
    [selectedRound?.courseVersionId]
  );
  const currentHole = useMemo(() => holes?.find((h) => h.number === holeNumber), [holes, holeNumber]);
  const maxHoleNumber = holes?.length ? Math.max(...holes.map((h) => h.number)) : 18;

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
  const pendingFlags = useMemo(
    () => (flags ?? []).filter((f) => f.status === "open" || f.status === "dismissed"),
    [flags]
  );

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

  // A newly-selected round or hole shouldn't carry over an armed toggle from whatever was being
  // reviewed before.
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

  function openRound(roundId: string) {
    setSelectedRoundId(roundId);
    setHoleNumber(1);
  }

  function jumpToFlag(flag: ReviewFlag) {
    const rh = allRoundHoles?.find((r) => r.id === flag.roundHoleId);
    const hole = holes?.find((h) => h.id === rh?.holeId);
    if (hole) setHoleNumber(hole.number);
    if (flag.shotId) setEditingShotId(flag.shotId);
  }

  // --- FIT ingest (spec 2.4/2.5): parse, overlap-guard, store, compute clock offset, reconcile ---
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
              `This FIT file covers ${new Date(parsed.range.start).toLocaleString()} – ${new Date(parsed.range.end).toLocaleString()}, ` +
                `but this round's shots span ${new Date(shotStart).toLocaleString()} – ${new Date(shotEnd).toLocaleString()}. Wrong file?`
            );
          }
        } else {
          const fitDay = new Date(parsed.range.start).toISOString().slice(0, 10);
          if (fitDay !== selectedRound.playedOn) {
            throw new Error(
              `This FIT file is from ${fitDay}, but the round was played on ${selectedRound.playedOn}. Wrong file?`
            );
          }
        }
      }

      // Clock offset from the calibration press when one was made (spec 2.5); reconcile
      // estimates otherwise.
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
        `Ingested ${parsed.laps.length} laps. Reconciled ${summary.shotCount} shots, ${summary.flagCount} flag(s); ` +
          `clock offset ${(summary.clockOffsetMs / 1000).toFixed(1)}s (${summary.clockOffsetMethod.replace("_", " ")}).`
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

  if (!selectedRoundId || !selectedRound) {
    return (
      <div style={{ padding: 16 }}>
        <PageHeader title="Review Rounds" />
        {!completedRounds?.length ? (
          <p style={{ opacity: 0.8 }}>
            No completed rounds yet. Finish a round (hole out on 18, or the last hole of the
            course) to see it here.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {completedRounds.map(({ round, courseName, toPar, scoredHoles }) => (
              <button key={round.id} onClick={() => openRound(round.id)} style={roundListItemStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <div style={{ fontWeight: 600 }}>{courseName}</div>
                  {scoredHoles > 0 && (
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#f5d90a" }}>
                      {relativeToParLabel(toPar)}
                      <span style={{ fontSize: 11, opacity: 0.7, fontWeight: 400 }}> · {scoredHoles} holes</span>
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {round.playedOn}
                  {round.fitIngestedAt ? " · ⌚ watch data attached" : ""}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", flex: "0 0 45%" }}>
        <button onClick={() => setSelectedRoundId(null)} style={backButtonStyle} aria-label="Back to round list">
          ←
        </button>
        <button onClick={() => setShowScorecard(true)} style={scorecardButtonStyle} aria-label="Show scorecard" title="Scorecard">
          📋 Scorecard
        </button>
        {currentHole && (
          <div style={holeHeaderStyle}>
            <button onClick={() => setHoleNumber((n) => Math.max(1, n - 1))} disabled={holeNumber <= 1} style={navButtonStyle}>
              ‹
            </button>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 15 }}>
                Hole {currentHole.number} · Par {currentHole.par}
              </div>
            </div>
            <button
              onClick={() => setHoleNumber((n) => Math.min(maxHoleNumber, n + 1))}
              disabled={holeNumber >= maxHoleNumber}
              style={navButtonStyle}
            >
              ›
            </button>
          </div>
        )}
        {armedPenaltyType && (
          <div style={armedBannerStyle}>Tap where the penalty happened ({PENALTY_OPTIONS.find((p) => p.value === armedPenaltyType)?.label})…</div>
        )}
        <ReviewMap
          shots={shots ?? []}
          fallbackOrigin={fallbackOrigin}
          armedShotId={armedShotId}
          clickArmed={armedPenaltyType !== null}
          onMapClick={handleMapClick}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", background: "#0b0f0c", color: "#eef2ef" }}>
        {/* --- Watch-file ingest --- */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
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
          <button onClick={() => fitInputRef.current?.click()} disabled={fitBusy} style={smallButtonStyle}>
            ⌚ {selectedRound.fitIngestedAt ? "Re-attach watch file…" : "Attach watch file…"}
          </button>
          {selectedRound.fitIngestedAt && (
            <button onClick={handleRerunReconcile} disabled={fitBusy} style={smallButtonStyle}>
              ↻ Re-run reconciliation
            </button>
          )}
          {fitBusy && <span style={{ fontSize: 12, opacity: 0.7 }}>Working…</span>}
        </div>
        {fitMessage && <p style={{ fontSize: 12.5, color: "#8fd694", marginBottom: 10 }}>{fitMessage}</p>}

        {/* --- Flag queue (4.2): every open + dismissed flag, grouped by hole --- */}
        {pendingFlags.length > 0 && (
          <div style={flagQueueStyle}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
              ⚠️ {pendingFlags.length} item{pendingFlags.length === 1 ? "" : "s"} to review
            </div>
            {pendingFlags.map((f) => (
              <div key={f.id} style={flagRowStyle}>
                <button onClick={() => jumpToFlag(f)} style={flagJumpStyle}>
                  <span style={{ opacity: 0.7, marginRight: 6 }}>
                    H{holes?.find((h) => h.id === allRoundHoles?.find((r) => r.id === f.roundHoleId)?.holeId)?.number ?? "?"}
                  </span>
                  {f.detail}
                  {f.status === "dismissed" ? " (deferred)" : ""}
                </button>
                <button onClick={() => setReviewFlagStatus(f.id, "resolved")} style={flagActionStyle} title="Mark resolved">
                  ✓
                </button>
              </div>
            ))}
          </div>
        )}

        {/* --- Penalty entry (4.2) --- */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 12.5, opacity: 0.75 }}>Add penalty:</span>
          <select
            value={armedPenaltyType ?? ""}
            onChange={(e) => setArmedPenaltyType((e.target.value || null) as PenaltyType | null)}
            style={penaltySelectStyle}
          >
            <option value="">— choose type, then tap map —</option>
            {PENALTY_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {/* --- Shot table (4.2): every stroke; club / lie / target editable --- */}
        {!shots?.length ? (
          <p style={{ opacity: 0.7, fontSize: 13 }}>No shots recorded for this hole.</p>
        ) : (
          shots.map((s) => {
            const club = clubs?.find((c) => c.id === s.clubId);
            const isEditing = editingShotId === s.id;
            const dist = s.endPoint ? Math.round(distanceYards(s.startPoint, s.endPoint)) : null;
            const badPosition = s.positionSource === "tee_fallback" || (s.accuracyM !== null && s.accuracyM > 15);
            return (
              <div key={s.id} style={shotRowStyle}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {s.penaltyType
                        ? `Penalty — ${PENALTY_OPTIONS.find((p) => p.value === s.penaltyType)?.label ?? s.penaltyType}`
                        : `Shot ${s.shotNumber}${s.swingType === "putt" ? " (putt)" : s.swingType === "partial" ? " (partial)" : ""}${club ? ` — ${club.name}` : s.reconciliation === "lap_only" ? " — club?" : ""}`}
                      {dist !== null && !s.penaltyType ? ` · ${dist}y` : ""}
                    </div>
                    <div style={{ fontSize: 11.5, opacity: 0.65 }}>
                      {s.lieStart ? LIE_LABELS[s.lieStart] : "—"} · {POSITION_SOURCE_LABELS[s.positionSource]}
                      {s.accuracyM !== null ? ` ±${Math.round(s.accuracyM)}m` : ""}
                      {s.targetPoint ? ` · target: ${s.targetSource.replace("default_", "")}` : " · no target"}
                      {s.excluded ? ` · excluded (${s.excluded})` : ""}
                      {s.userEdited ? " · edited" : ""}
                    </div>
                    {badPosition && (
                      <div style={{ fontSize: 11.5, color: "#fca5a5" }}>
                        ⚠️ {s.positionSource === "tee_fallback" ? "No GPS — recorded at tee box" : "Low GPS accuracy"} — excluded from stats
                      </div>
                    )}
                  </div>
                  <button onClick={() => setEditingShotId(isEditing ? null : s.id)} style={aimToggleStyle}>
                    {isEditing ? "Close" : "Edit"}
                  </button>
                </div>

                {isEditing && (
                  <div style={{ marginTop: 8 }}>
                    {s.penaltyType ? (
                      <button onClick={() => removePenaltyStroke(s.id)} style={{ ...aimToggleStyle, color: "#fca5a5" }}>
                        🗑 Remove penalty stroke
                      </button>
                    ) : (
                      <>
                        <div style={editLabelStyle}>Club</div>
                        <div style={chipRowStyle}>
                          {clubs?.map((c) => (
                            <button
                              key={c.id}
                              onClick={() => correctShot(s.id, { clubId: c.id })}
                              style={{ ...editChipStyle, ...(s.clubId === c.id ? editChipActiveStyle : {}) }}
                            >
                              {c.name}
                            </button>
                          ))}
                        </div>
                        <div style={editLabelStyle}>Lie</div>
                        <div style={chipRowStyle}>
                          {ALL_LIES.map((l) => (
                            <button
                              key={l}
                              onClick={() => correctShot(s.id, { lieStart: l })}
                              style={{ ...editChipStyle, ...(s.lieStart === l ? editChipActiveStyle : {}) }}
                            >
                              {LIE_LABELS[l]}
                            </button>
                          ))}
                        </div>
                        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                          <button
                            onClick={() => setArmedShotId((id) => (id === s.id ? null : s.id))}
                            style={{ ...aimToggleStyle, ...(armedShotId === s.id ? aimToggleActiveStyle : {}) }}
                          >
                            🎯 {armedShotId === s.id ? "Tap map…" : "Set target"}
                          </button>
                          <button onClick={() => setShotExcluded(s.id, s.excluded === null)} style={aimToggleStyle}>
                            {s.excluded === null ? "🚫 Exclude from stats" : "✓ Include in stats"}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {showScorecard && <ScorecardSheet entries={scorecardEntries} onClose={() => setShowScorecard(false)} />}
    </div>
  );
}

const scorecardButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 3,
  padding: "8px 14px",
  background: "rgba(11,15,12,0.85)",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer"
};

const roundListItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "12px 14px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 10,
  cursor: "pointer"
};

const backButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: 12,
  zIndex: 3,
  width: 36,
  height: 36,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "50%",
  background: "#ffffff",
  color: "#111",
  fontSize: 16,
  border: "none",
  cursor: "pointer",
  boxShadow: "0 2px 6px rgba(0,0,0,.4)"
};

const holeHeaderStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 2,
  display: "flex",
  alignItems: "center",
  gap: 12,
  background: "rgba(11,15,12,0.75)",
  color: "#eef2ef",
  padding: "6px 12px",
  borderRadius: 8
};

const navButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#eef2ef",
  fontSize: 22,
  padding: "0 6px",
  cursor: "pointer"
};

const armedBannerStyle: React.CSSProperties = {
  position: "absolute",
  top: 56,
  left: 12,
  right: 12,
  zIndex: 2,
  background: "rgba(245,217,10,0.95)",
  color: "#111",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600
};

const smallButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 13,
  cursor: "pointer"
};

const flagQueueStyle: React.CSSProperties = {
  background: "#191307",
  border: "1px solid #6b4d16",
  borderRadius: 10,
  padding: 10,
  marginBottom: 12
};

const flagRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 0"
};

const flagJumpStyle: React.CSSProperties = {
  flex: 1,
  textAlign: "left",
  background: "none",
  border: "none",
  color: "#eef2ef",
  fontSize: 12.5,
  cursor: "pointer",
  padding: 0
};

const flagActionStyle: React.CSSProperties = {
  background: "#1a3a24",
  border: "1px solid #2f5c3d",
  color: "#8fd694",
  borderRadius: 999,
  width: 28,
  height: 28,
  cursor: "pointer"
};

const penaltySelectStyle: React.CSSProperties = {
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 13
};

const shotRowStyle: React.CSSProperties = {
  padding: "10px 0",
  borderBottom: "1px solid #1a3a24"
};

const editLabelStyle: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.6,
  margin: "6px 0 4px"
};

const chipRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap"
};

const editChipStyle: React.CSSProperties = {
  padding: "6px 10px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 12,
  cursor: "pointer"
};

const editChipActiveStyle: React.CSSProperties = {
  background: "#f5d90a",
  color: "#111",
  border: "1px solid #f5d90a"
};

const aimToggleStyle: React.CSSProperties = {
  padding: "6px 10px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 12,
  whiteSpace: "nowrap",
  cursor: "pointer"
};

const aimToggleActiveStyle: React.CSSProperties = {
  background: "#f5d90a",
  color: "#111",
  border: "1px solid #f5d90a"
};
