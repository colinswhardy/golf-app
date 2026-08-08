import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button, Icon, relativeToParLabel, scoreToneClass } from "./ui";
import { findPutter } from "../lib/stats";
import { formatTagSerial } from "../lib/clubTagRead";
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
  { label: "Bunker", lie: "bunker_greenside" },
  { label: "Water", lie: "hazard" },
  { label: "Fringe", lie: "fringe" },
  { label: "Green", lie: "green" }
];

/**
 * Bottom sheet for recording a shot: two fast taps and it's saved — no separate
 * Save button. Shot 1 skips the lie tap entirely (always "tee"); shot 2+ taps a
 * lie tile, then a club tile, and the club tap saves immediately. Green is a
 * special case: tapping "Green" (or landing there via auto-detection) saves
 * instantly with Putter — putting off the green is a near-certainty and the
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
  const putter = findPutter(props.clubs);

  // Fires for both the auto-detected initial state and a manual tap of the Green
  // tile — either way, landing on "green" saves immediately rather than
  // pre-highlighting Putter and waiting for another tap.
  useEffect(() => {
    if (lie === "green") props.onSave(putter?.id ?? null, "green");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lie]);

  if (lie === "green") return null;

  return (
    <Sheet title={`Shot ${props.shotNumber}`} onClose={props.onClose}>
      {lie === null ? (
        <>
          <div className="section__title mb-2">Where is the ball?</div>
          <div className="tile-grid tile-grid--3">
            {LIE_TILES.map((t) => (
              <button key={t.lie} className="tile" onClick={() => setLie(t.lie)}>
                {t.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="row row--between mb-2">
            <div className="section__title">Club</div>
            {!isFirstShot && (
              <button className="chip chip--sm" onClick={() => setLie(null)}>
                ← Lie
              </button>
            )}
          </div>
          <div className="tile-grid tile-grid--3">
            {props.clubs.map((c) => (
              <button key={c.id} className="tile" onClick={() => props.onSave(c.id, lie)}>
                {c.name}
              </button>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}

/**
 * Pairing a club tag without leaving the round.
 *
 * An unpaired tag used to be a dead toast: the read was thrown away and the swing with it, and
 * the only fix was Settings, after the round, from memory. This catches the read at the moment
 * you're holding the club against the phone, which is the only moment you can be sure which club
 * the tag is actually on.
 *
 * Whether to also log the read as a shot depends on why you're here, so the caller sets the
 * default: a tag that surprised you mid-swing is a shot; deliberately catching up on pairing
 * isn't. Either way it's one tap to flip.
 */
export function TagPairSheet(props: {
  serialNumber: string;
  clubs: Club[];
  /** Set when this serial is already paired — i.e. this is a re-pair, not a new tag. */
  currentClubId: string | null;
  /** Club ids that already have some tag, so you can see what you're overwriting. */
  taggedClubIds: Set<string>;
  defaultLogShot: boolean;
  onPair: (clubId: string, logShot: boolean) => void;
  onClose: () => void;
}) {
  const [logShot, setLogShot] = useState(props.defaultLogShot);
  const current = props.clubs.find((c) => c.id === props.currentClubId) ?? null;

  return (
    <Sheet title={current ? "Re-pair this tag" : "New club tag"} onClose={props.onClose}>
      <div className="card__meta mb-2" style={{ lineHeight: 1.5 }}>
        Tag ending <strong>…{formatTagSerial(props.serialNumber)}</strong>
        {current ? (
          <>
            {" "}
            is paired to <strong>{current.name}</strong>. Pick the club it's actually on.
          </>
        ) : (
          <> isn't paired yet. Tap the club it's stuck to.</>
        )}
      </div>

      <div className="tile-grid tile-grid--3">
        {props.clubs.map((c) => (
          <button
            key={c.id}
            className={`tile${c.id === props.currentClubId ? " tile--active" : ""}`}
            onClick={() => props.onPair(c.id, logShot)}
          >
            {c.name}
            {props.taggedClubIds.has(c.id) && c.id !== props.currentClubId && (
              <span className="tiny faint" style={{ display: "block" }}>
                has a tag
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="row row--between mt-3">
        <span className="small dim">
          {logShot ? "Logs a shot here too" : "Pairs only — no shot recorded"}
        </span>
        <button className={`chip chip--sm${logShot ? " chip--active" : ""}`} onClick={() => setLogShot((v) => !v)}>
          {logShot ? "Shot on" : "Shot off"}
        </button>
      </div>
    </Sheet>
  );
}

/** Scorecard for the round so far: hole/par/score/± with a running total. Shared
 * by the live round map and post-round review so both show the same thing. */
export function ScorecardSheet(props: {
  entries: { holeNumber: number; par: number; score: number | null }[];
  onClose: () => void;
}) {
  const played = props.entries.filter((e) => e.score !== null);
  const totalPar = played.reduce((s, e) => s + e.par, 0);
  const totalScore = played.reduce((s, e) => s + (e.score as number), 0);

  return (
    <Sheet title="Scorecard" onClose={props.onClose}>
      <div className="scorecard-row scorecard-row--head">
        <span>Hole</span>
        <span>Par</span>
        <span>Score</span>
        <span>+/−</span>
      </div>
      {props.entries.map((e) => (
        <div key={e.holeNumber} className="scorecard-row">
          <span>Hole {e.holeNumber}</span>
          <span className="dim">{e.par}</span>
          <span>
            {e.score !== null ? <span className={scoreToneClass(e.score, e.par)}>{e.score}</span> : <span className="faint">—</span>}
          </span>
          <span className="dim">{e.score !== null ? relativeToParLabel(e.score - e.par) : "—"}</span>
        </div>
      ))}
      {played.length > 0 && (
        <div className="scorecard-row scorecard-row--total">
          <span>Total</span>
          <span>{totalPar}</span>
          <span>{totalScore}</span>
          <span className="accent">{relativeToParLabel(totalScore - totalPar)}</span>
        </div>
      )}
    </Sheet>
  );
}

/**
 * Holing out: fairway result (Par 4+ only, pre-selected from Shot 2's
 * auto-detected landing spot but overridable) + putts + score, prefilled from
 * recorded shots + putts. Per-putt distances are gone — putts are real Shot rows
 * placed on the green-marking screen now, so a marked hole arrives with its putt
 * count already known.
 */
export function HoleScoreSheet(props: {
  holeNumber: number;
  par: number;
  recordedShots: number;
  /** Putt count from the green-marking screen when the hole was marked. */
  markedPutts?: number | null;
  autoDetectedFairwayResult?: FairwayResult | null;
  onSave: (score: number, putts: number, fairwayResult: FairwayResult | null) => void;
  onClose: () => void;
}) {
  const initialPutts = props.markedPutts ?? 2;
  const [putts, setPutts] = useState(initialPutts);
  const [scoreTouched, setScoreTouched] = useState(false);
  const [score, setScore] = useState(props.recordedShots + initialPutts);
  const [fairwayResult, setFairwayResult] = useState<FairwayResult | null>(props.autoDetectedFairwayResult ?? null);

  const effectiveScore = scoreTouched ? score : props.recordedShots + putts;
  const showFairway = props.par >= 4;
  const diff = effectiveScore - props.par;

  return (
    <Sheet title={`Hole ${props.holeNumber} · Par ${props.par}`} onClose={props.onClose}>
      {showFairway && (
        <div className="mb-3">
          <div className="section__title mb-2">Tee shot</div>
          <div className="tile-grid tile-grid--5">
            {FAIRWAY_TILES.map((t) => (
              <button
                key={t.value}
                className={`tile${fairwayResult === t.value ? " tile--active" : ""}`}
                style={{ padding: "13px 4px", fontSize: 12.5 }}
                onClick={() => setFairwayResult(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <Stepper
        label={props.markedPutts != null ? "Putts (from green marks)" : "Putts"}
        value={putts}
        min={0}
        onChange={(v) => {
          setPutts(v);
          if (!scoreTouched) setScore(props.recordedShots + v);
        }}
      />

      <Stepper
        label="Score"
        hint={scoreTouched ? undefined : `${props.recordedShots} shots + ${putts} putts`}
        value={effectiveScore}
        min={1}
        onChange={(v) => {
          setScoreTouched(true);
          setScore(v);
        }}
      />

      <div className="row row--between mt-2 mb-3">
        <span className="small dim">Result</span>
        <span className={scoreToneClass(effectiveScore, props.par)} style={{ fontSize: 15, minWidth: 44 }}>
          {relativeToParLabel(diff)}
        </span>
      </div>

      <Button variant="primary" block onClick={() => props.onSave(effectiveScore, putts, showFairway ? fairwayResult : null)}>
        Save hole
      </Button>
    </Sheet>
  );
}

function Stepper(props: { label: string; hint?: string; value: number; min: number; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <div>
        <div>{props.label}</div>
        {props.hint && <div className="tiny faint">{props.hint}</div>}
      </div>
      <div className="stepper__controls">
        <button className="stepper__btn" onClick={() => props.onChange(Math.max(props.min, props.value - 1))} aria-label="Decrease">
          −
        </button>
        <span className="stepper__value">{props.value}</span>
        <button className="stepper__btn" onClick={() => props.onChange(props.value + 1)} aria-label="Increase">
          +
        </button>
      </div>
    </div>
  );
}

export function Sheet(props: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="sheet-backdrop" onClick={props.onClose} />
      <div className="sheet" role="dialog" aria-label={props.title}>
        <div className="sheet__grab" />
        <div className="sheet__head">
          <span className="sheet__title">{props.title}</span>
          <button className="map-btn" onClick={props.onClose} aria-label="Close" style={{ width: 34, height: 34, background: "var(--surface-2)" }}>
            <Icon.close size={17} />
          </button>
        </div>
        {props.children}
      </div>
    </>
  );
}
