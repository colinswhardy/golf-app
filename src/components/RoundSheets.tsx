import { useState } from "react";
import type { Club, Lie } from "../types/domain";

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
 * then a club tile, and the club tap saves immediately.
 */
export function ShotSheet(props: {
  shotNumber: number;
  clubs: Club[];
  detectedLie: Lie;
  onSave: (clubId: string | null, lie: Lie) => void;
  onClose: () => void;
}) {
  const [lie, setLie] = useState<Lie | null>(props.shotNumber === 1 ? "tee" : null);

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

/** Bottom sheet for holing out: putts (with per-putt distances) + score (prefilled from recorded shots + putts). */
export function HoleScoreSheet(props: {
  holeNumber: number;
  recordedShots: number;
  onSave: (score: number, putts: number, puttDistancesFeet: (number | null)[]) => void;
  onClose: () => void;
}) {
  const [putts, setPutts] = useState(2);
  const [scoreTouched, setScoreTouched] = useState(false);
  const [score, setScore] = useState(props.recordedShots + 2);
  const [distances, setDistances] = useState<string[]>(["", ""]);

  const effectiveScore = scoreTouched ? score : props.recordedShots + putts;

  return (
    <Sheet title={`Hole ${props.holeNumber} — finish`} onClose={props.onClose}>
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
            })
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
