import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { getHolesForVersion } from "../lib/courseRepo";
import { listCompletedRounds, listShotsForRoundHole, setShotAimPoint } from "../lib/roundRepo";
import { LIE_LABELS } from "../lib/lie";
import { ReviewMap } from "../components/ReviewMap";
import { PageHeader } from "../components/PageHeader";
import type { LatLng } from "../types/domain";

export function ReviewRoundsPage() {
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [holeNumber, setHoleNumber] = useState(1);
  const [armedShotId, setArmedShotId] = useState<string | null>(null);

  const completedRounds = useLiveQuery(async () => {
    const rounds = await listCompletedRounds();
    return Promise.all(
      rounds.map(async (round) => {
        const version = await db.courseVersions.get(round.courseVersionId);
        const course = version ? await db.courses.get(version.courseId) : undefined;
        return { round, courseName: course?.name ?? "Unknown course" };
      })
    );
  }, []);

  const selectedRound = completedRounds?.find((e) => e.round.id === selectedRoundId)?.round ?? null;

  const holes = useLiveQuery(
    () => (selectedRound ? getHolesForVersion(selectedRound.courseVersionId) : []),
    [selectedRound?.courseVersionId]
  );
  const currentHole = useMemo(() => holes?.find((h) => h.number === holeNumber), [holes, holeNumber]);
  const maxHoleNumber = holes?.length ? Math.max(...holes.map((h) => h.number)) : 18;

  const currentRoundHole = useLiveQuery(async () => {
    if (!selectedRound || !currentHole) return undefined;
    const rhs = await db.roundHoles.where("roundId").equals(selectedRound.id).toArray();
    return rhs.find((rh) => rh.holeId === currentHole.id);
  }, [selectedRound?.id, currentHole?.id]);

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

  // A newly-selected round or hole shouldn't carry over an armed aim-target toggle from
  // whatever was being reviewed before.
  useEffect(() => {
    setArmedShotId(null);
  }, [selectedRoundId, currentHole?.id]);

  async function handleMapClick(point: LatLng) {
    if (!armedShotId) return;
    await setShotAimPoint(armedShotId, point);
    setArmedShotId(null);
  }

  function openRound(roundId: string) {
    setSelectedRoundId(roundId);
    setHoleNumber(1);
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
            {completedRounds.map(({ round, courseName }) => (
              <button key={round.id} onClick={() => openRound(round.id)} style={roundListItemStyle}>
                <div style={{ fontWeight: 600 }}>{courseName}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{round.playedOn}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", flex: "0 0 55%" }}>
        <button onClick={() => setSelectedRoundId(null)} style={backButtonStyle} aria-label="Back to round list">
          ←
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
        <ReviewMap shots={shots ?? []} fallbackOrigin={fallbackOrigin} armedShotId={armedShotId} onMapClick={handleMapClick} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", background: "#0b0f0c", color: "#eef2ef" }}>
        {!shots?.length ? (
          <p style={{ opacity: 0.7, fontSize: 13 }}>No shots recorded for this hole.</p>
        ) : (
          shots.map((s, i) => {
            const club = clubs?.find((c) => c.id === s.clubId);
            const isArmed = armedShotId === s.id;
            return (
              <div key={s.id} style={shotRowStyle}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    Shot {i + 1}
                    {club ? ` — ${club.name}` : ""}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    {s.lieStart ? LIE_LABELS[s.lieStart] : "—"}
                    {s.aimPointOverride ? " · aim target set" : ""}
                  </div>
                </div>
                <button
                  onClick={() => setArmedShotId((id) => (id === s.id ? null : s.id))}
                  style={{ ...aimToggleStyle, ...(isArmed ? aimToggleActiveStyle : {}) }}
                >
                  🎯 {isArmed ? "Tap map…" : "Set Aim Target"}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

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

const shotRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "10px 0",
  borderBottom: "1px solid #1a3a24"
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
