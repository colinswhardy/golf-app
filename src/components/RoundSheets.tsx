import { useEffect, useState } from "react";
import type { Club, FairwayResult, Lie } from "../types/domain";

const FAIRWAY_TILES: { label: string; value: FairwayResult }[] = [
  { label: "Hit", value: "hit" },
  { label: "Left", value: "left" },
  { label: "Right", value: "right" },
  { label: "Short", value: "short" },
  { label: "Long", value: "long" }
];

const LIE_TILES: { label: string; lie: Lie }[] = [
  { label: "Fairway", lie: "fairway" },
  { label: "Rough", lie: "rough" },
  { label: "Sand Bunker", lie: "bunker_greenside" },
  { label: "Water Hazard", lie: "hazard" },
  { label: "Fringe", lie: "fringe" },
  { label: "Green", lie: "green" }
];

/**
 * Bottom sheet for recording a shot: two fast taps and it's saved — no separate Save
 * button. Shot 1 skips the lie tap entirely (always "tee"); shot 2+ taps a lie tile,
 * then a club tile, and the club tap saves immediately. Green is a special case: tapping
 * "Green" (or landing there via auto-detection) saves instantly with Putter — zero taps
 * in the club grid, since putting off the green is a near-certainty and this is the single
 * most frequent lie transition in a round.
 */
export function ShotSheet(props: {
  shotNumber: number;
  clubs: Club[];
  detectedLie: Lie;
  onSave: (clubId: string | null, lie: Lie) => void;
  onClose: () => void;
}) {
  const isFirstShot = props.shotNumber === 1;
  const isOnGreen = props.detectedLie === "green";
  const [lie, setLie] = useState<Lie | null>(isFirstShot ? "tee" : isOnGreen ? "green" : null);
  const putter = props.clubs.find((c) => c.name === "Putter");

  // Fires for both the auto-detected initial state (isOnGreen) and a manual tap of the Green
  // tile — either way, landing on "green" should save immediately, not just pre-highlight Putter
  // and wait for another tap.
  useEffect(() => {
    if (lie === "green") props.onSave(putter?.id ?? null, "green");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lie]);

  if (lie === "green") return null;

  return (
    <Sheet title={`Shot ${props.shotNumber}`} onClose={props.onClose}>
      {lie === null ? (
        <>
          <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 8 }}>Lie</div>
          <div style={lieGridStyle}>
            {LIE_TILES.map((t) => (
              <button key={t.lie} onClick={() => setLie(t.lie)} style={tileStyle}>
                {t.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 8 }}>Club</div>
          <div style={clubGridStyle}>
            {props.clubs.map((c) => (
              <button key={c.id} onClick={() => props.onSave(c.id, lie)} style={tileStyle}>
                {c.name}
              </button>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}

export function relativeToParLabel(diff: number): string {
  return diff === 0 ? "E" : diff > 0 ? `+${diff}` : `${diff}`;
}

/** Bottom sheet showing the in-progress round's scorecard so far: hole/par/score/+- per hole played, with a running total. */
export function ScorecardSheet(props: { entries: { holeNumber: number; par: number; score: number | null }[]; onClose: () => void }) {
  const playedEntries = props.entries.filter((e) => e.score !== null);
  const totalPar = playedEntries.reduce((s, e) => s + e.par, 0);
  const totalScore = playedEntries.reduce((s, e) => s + (e.score as number), 0);

  return (
    <Sheet title="Scorecard" onClose={props.onClose}>
      <div style={scorecardRowStyle}>
        <span style={{ flex: 1, opacity: 0.7 }}>Hole</span>
        <span style={scorecardColStyle}>Par</span>
        <span style={scorecardColStyle}>Score</span>
        <span style={scorecardColStyle}>+/-</span>
      </div>
      {props.entries.map((e) => (
        <div key={e.holeNumber} style={scorecardRowStyle}>
          <span style={{ flex: 1 }}>Hole {e.holeNumber}</span>
          <span style={scorecardColStyle}>{e.par}</span>
          <span style={scorecardColStyle}>{e.score ?? "—"}</span>
          <span style={scorecardColStyle}>{e.score !== null ? relativeToParLabel(e.score - e.par) : "—"}</span>
        </div>
      ))}
      {playedEntries.length > 0 && (
        <div style={{ ...scorecardRowStyle, borderTop: "1px solid #2f5c3d", marginTop: 6, paddingTop: 10, fontWeight: 600 }}>
          <span style={{ flex: 1 }}>Total</span>
          <span style={scorecardColStyle}>{totalPar}</span>
          <span style={scorecardColStyle}>{totalScore}</span>
          <span style={scorecardColStyle}>{relativeToParLabel(totalScore - totalPar)}</span>
        </div>
      )}
    </Sheet>
  );
}

/** Bottom sheet for holing out: fairway result (Par 4+ only, pre-selected from Shot 2's
 * auto-detected landing spot but overridable) + putts (with per-putt distances) + score
 * (prefilled from recorded shots + putts). */
export function HoleScoreSheet(props: {
  holeNumber: number;
  par: number;
  recordedShots: number;
  /** Auto-detected the moment Shot 2 was logged (see RoundMapPage.handleSaveShot) — pre-selects
   * the fairway tile below, still fully overridable by tapping a different one. Null if there
   * wasn't enough geometry to auto-detect (e.g. no mapped fairway polygon for this hole). */
  autoDetectedFairwayResult?: FairwayResult | null;
  onSave: (
    score: number,
    putts: number,
    puttDistancesFeet: (number | null)[],
    fairwayResult: FairwayResult | null
  ) => void;
  onClose: () => void;
}) {
  const [putts, setPutts] = useState(2);
  const [scoreTouched, setScoreTouched] = useState(false);
  const [score, setScore] = useState(props.recordedShots + 2);
  const [distances, setDistances] = useState<string[]>(["", ""]);
  const [fairwayResult, setFairwayResult] = useState<FairwayResult | null>(props.autoDetectedFairwayResult ?? null);

  const effectiveScore = scoreTouched ? score : props.recordedShots + putts;
  const showFairway = props.par >= 4;

  return (
    <Sheet title={`Hole ${props.holeNumber} — finish`} onClose={props.onClose}>
      {showFairway && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 8 }}>Fairway</div>
          <div style={fairwayGridStyle}>
            {FAIRWAY_TILES.map((t) => (
              <button
                key={t.value}
                onClick={() => setFairwayResult(t.value)}
                style={{ ...tileStyle, ...(fairwayResult === t.value ? tileActiveStyle : {}), padding: "12px 4px" }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <Stepper
        label="Putts"
        value={putts}
        min={0}
        onChange={(v) => {
          setPutts(v);
          setDistances((d) => (v > d.length ? [...d, ...Array(v - d.length).fill("")] : d.slice(0, v)));
          if (!scoreTouched) setScore(props.recordedShots + v);
        }}
      />

      {putts > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 6 }}>Putt distances (feet, optional)</div>
          {distances.map((d, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 13, width: 52 }}>Putt {i + 1}</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                placeholder="ft"
                value={d}
                onChange={(e) => setDistances((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                style={distanceInputStyle}
              />
            </div>
          ))}
        </div>
      )}

      <Stepper
        label={`Score${scoreTouched ? "" : ` (auto: ${props.recordedShots} shots + putts)`}`}
        value={effectiveScore}
        min={1}
        onChange={(v) => {
          setScoreTouched(true);
          setScore(v);
        }}
      />
      <button
        onClick={() =>
          props.onSave(
            effectiveScore,
            putts,
            distances.map((d) => {
              const n = parseFloat(d);
              return Number.isFinite(n) && n >= 0 ? n : null;
            }),
            showFairway ? fairwayResult : null
          )
        }
        style={primaryButtonStyle}
      >
        Save hole
      </button>
    </Sheet>
  );
}

function Stepper(props: { label: string; value: number; min: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
      <span style={{ fontSize: 14 }}>{props.label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button onClick={() => props.onChange(Math.max(props.min, props.value - 1))} style={stepButtonStyle}>
          −
        </button>
        <span style={{ fontSize: 18, minWidth: 24, textAlign: "center" }}>{props.value}</span>
        <button onClick={() => props.onChange(props.value + 1)} style={stepButtonStyle}>
          +
        </button>
      </span>
    </div>
  );
}

function Sheet(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div onClick={props.onClose} style={backdropStyle} />
      <div style={sheetStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <strong style={{ fontSize: 16 }}>{props.title}</strong>
          <button onClick={props.onClose} style={{ ...chipStyle, padding: "4px 10px" }}>
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  zIndex: 3
};

const sheetStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 4,
  background: "#101812",
  borderTop: "1px solid #2f5c3d",
  borderRadius: "16px 16px 0 0",
  padding: "16px 16px 24px",
  color: "#eef2ef",
  maxHeight: "70%",
  overflowY: "auto"
};

const scorecardRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "6px 0",
  fontSize: 14
};

const scorecardColStyle: React.CSSProperties = {
  width: 44,
  textAlign: "center"
};

const chipStyle: React.CSSProperties = {
  padding: "8px 12px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 13,
  cursor: "pointer"
};

const lieGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10
};

const clubGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 8
};

const fairwayGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, 1fr)",
  gap: 6
};

const tileStyle: React.CSSProperties = {
  padding: "18px 8px",
  textAlign: "center",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 12,
  fontSize: 14,
  cursor: "pointer"
};

const tileActiveStyle: React.CSSProperties = {
  background: "#f5d90a",
  color: "#111",
  // Full `border` shorthand, not just borderColor — mixing shorthand/non-shorthand for the
  // same property across re-renders (tileStyle uses the `border` shorthand) throws a React
  // dev warning and can cause the un-set longhand pieces (width/style) to not reset.
  border: "1px solid #f5d90a"
};

const distanceInputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 10px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 8,
  fontSize: 14
};

const stepButtonStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 999,
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  fontSize: 18,
  cursor: "pointer"
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 8,
  padding: "12px 14px",
  background: "#f5d90a",
  color: "#111",
  border: "none",
  borderRadius: 10,
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer"
};
