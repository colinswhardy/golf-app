import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router-dom";
import { AppBar, Badge, Button, Icon, Note, Page, Section } from "../components/ui";
import { createClub, deleteClub, ensureDefaultClubs, listClubs, moveClub, renameClub, updateClubDispersion } from "../lib/courseRepo";
import { isGpsEnabled, isSimulationEnabled, setGpsEnabled, setSimulationEnabled } from "../lib/settings";
import { backupFilename, exportAll, importAll, readBackup, type BackupEnvelope, type BackupSummary } from "../lib/backup";
import { findDanglingReferences, repairDanglingReferences, type RepairResult } from "../lib/integrity";
import { listClubTags, pairClubTag, unpairClubTag } from "../lib/captureRepo";
import { isNfcSupported, scanOnce } from "../lib/nfc";
import { baselineRowCount, importBaselineCsv } from "../lib/sg";
import { generateDemoRound, hasDemoRound, removeDemoRound, type DemoHistoryResult } from "../lib/demoRound";
import type { Club } from "../types/domain";

export function SettingsPage() {
  // Seeding (a write) can't happen inside useLiveQuery's callback — Dexie runs it in a read-only
  // transaction and throws ReadOnlyError. Seed once on mount; the live query below just reads.
  useEffect(() => {
    ensureDefaultClubs();
  }, []);
  const clubs = useLiveQuery(() => listClubs(), []);

  const [gpsEnabled, setGpsEnabledState] = useState(isGpsEnabled);
  function toggleGps(enabled: boolean) {
    setGpsEnabledState(enabled);
    setGpsEnabled(enabled);
  }

  const [simulation, setSimulationState] = useState(isSimulationEnabled);
  function toggleSimulation(enabled: boolean) {
    setSimulationState(enabled);
    setSimulationEnabled(enabled);
  }

  return (
    <Page>
      <AppBar title="Settings" />

      <SampleRoundSection />
      <BackupSection />
      <IntegritySection />

      <Section title="Location">
        <div className="card">
          <label className="switch-row" style={{ padding: 0 }}>
            <span>
              <div>Use live GPS on the course</div>
              <div className="tiny faint mt-1" style={{ maxWidth: 380 }}>
                Distances anchor to your real position once you're within ~2000 yards of a tee.
                Turn off to always measure from the saved tee boxes. Takes effect next round.
              </div>
            </span>
            <input className="switch" type="checkbox" checked={gpsEnabled} onChange={(e) => toggleGps(e.target.checked)} />
          </label>
        </div>
      </Section>

      <Section title="Practice">
        <div className="card">
          <label className="switch-row" style={{ padding: 0 }}>
            <span>
              <div>Simulation mode</div>
              <div className="tiny faint mt-1" style={{ maxWidth: 380 }}>
                Play a course from the couch. Your position is placed by tapping the map instead of
                read from GPS, and on-screen buttons stand in for the watch lap press and an NFC
                club tap — writing the same rows the real hardware would, so the whole flow can be
                rehearsed before you trust it on the course.
              </div>
            </span>
            <input className="switch" type="checkbox" checked={simulation} onChange={(e) => toggleSimulation(e.target.checked)} />
          </label>
          {simulation && (
            <div className="mt-2">
              <Note tone="warn">
                Simulated rounds are saved like any other round. Remove them afterwards if you
                don't want them counting toward your stats.
              </Note>
            </div>
          )}
        </div>
      </Section>

      <ClubsSection clubs={clubs ?? []} />

      <NfcPairingSection clubs={clubs ?? []} />
      <SgBaselineSection />
    </Page>
  );
}

/** Generates / removes the worked example round so the review and stats screens can be explored
 * without having played anything yet. */
function SampleRoundSection() {
  const navigate = useNavigate();
  const [present, setPresent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DemoHistoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hasDemoRound().then(setPresent);
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await generateDemoRound();
      setResult(res);
      setPresent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await removeDemoRound();
      setResult(null);
      setPresent(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Sample round">
      <div className="card">
        <div className="card__title">Innerkip Highlands — worked example</div>
        <div className="card__meta mt-1" style={{ lineHeight: 1.5 }}>
          Four simulated rounds played over the real course geometry: shots routed down each
          hole's actual centreline, clubs, detected lies, pins, putts, a penalty and a couple of
          open review flags on the newest round. Enough history for the stats engine to have
          something to say. Remove it any time — your own rounds are never touched.
        </div>
        {result && (
          <div className="mt-2">
            <Note tone="ok">
              Generated {result.rounds.length} rounds at {result.courseName}:{" "}
              {result.rounds.map((r) => `${r.strokes} (${r.toPar > 0 ? "+" : ""}${r.toPar})`).join(", ")}.
            </Note>
          </div>
        )}
        {error && (
          <div className="mt-2">
            <Note tone="danger">{error}</Note>
          </div>
        )}
        <div className="row row--wrap mt-2" style={{ gap: 8 }}>
          {present ? (
            <>
              <Button variant="primary" size="sm" onClick={() => navigate("/rounds")}>
                Open in Rounds
              </Button>
              <Button size="sm" onClick={generate} disabled={busy}>
                Regenerate
              </Button>
              <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
                Remove
              </Button>
            </>
          ) : (
            // Only disabled while actually generating. The "is one already present?" lookup is
            // async, and gating the button on it left a dead-looking control that silently
            // swallowed the first tap.
            <Button variant="primary" size="sm" onClick={generate} disabled={busy}>
              {busy ? "Generating…" : "Generate sample rounds"}
            </Button>
          )}
          {busy && <span className="spinner" />}
        </div>
      </div>
    </Section>
  );
}

/** Export/import of the entire local database. All data is device-local IndexedDB — this is the
 * only backup path that exists. */
function BackupSection() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ envelope: BackupEnvelope; summary: BackupSummary } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleExport() {
    setMessage(null);
    setError(null);
    setBusy(true);
    try {
      const blob = await exportAll();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = backupFilename();
      a.click();
      URL.revokeObjectURL(url);
      setMessage("Backup exported.");
    } catch (e) {
      setError(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File) {
    setMessage(null);
    setError(null);
    try {
      setPending(await readBackup(file));
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleImport(mode: "merge" | "replace") {
    if (!pending) return;
    setBusy(true);
    try {
      await importAll(pending.envelope, mode);
      setMessage(`Import (${mode}) complete — ${pending.summary.totalRows} rows.`);
      setPending(null);
    } catch (e) {
      setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Backup"
      hint="Everything lives only on this device. Export before clearing site data, switching phones, or reinstalling — there is no cloud copy."
    >
      <div className="row row--wrap" style={{ gap: 8 }}>
        <Button size="sm" onClick={handleExport} disabled={busy}>
          <Icon.download size={15} /> Export backup
        </Button>
        <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy}>
          <Icon.upload size={15} /> Import backup
        </Button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) handleFile(file);
        }}
      />
      {pending && (
        <div className="card mt-2" style={{ borderColor: "rgba(255,192,67,.32)" }}>
          <div className="card__title">
            Backup from {pending.summary.exportedAt.slice(0, 10)} · schema v{pending.summary.schemaVersion}
          </div>
          <div className="tiny faint mt-1">
            {Object.entries(pending.summary.counts)
              .filter(([, n]) => n > 0)
              .map(([t, n]) => `${t} ${n}`)
              .join(" · ") || "No rows"}
          </div>
          <div className="small dim mt-2">
            <strong>Merge</strong> upserts rows by id. <strong>Replace</strong> clears every table
            first — current data is lost.
          </div>
          <div className="row row--wrap mt-2" style={{ gap: 8 }}>
            <Button size="sm" variant="primary" onClick={() => handleImport("merge")} disabled={busy}>
              Merge
            </Button>
            <Button size="sm" variant="danger" onClick={() => handleImport("replace")} disabled={busy}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {message && (
        <div className="mt-2">
          <Note tone="ok">{message}</Note>
        </div>
      )}
      {error && (
        <div className="mt-2">
          <Note tone="danger">{error}</Note>
        </div>
      )}
    </Section>
  );
}

/** Dangling-reference report + repair. Pre-revision reseed migrations wiped courses while leaving
 * rounds pointing at dead UUIDs; this recovers what it can. */
function IntegritySection() {
  const [report, setReport] = useState<{ total: number; rounds: number; roundHoles: number; shots: number } | null>(null);
  const [repairResult, setRepairResult] = useState<RepairResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const r = await findDanglingReferences();
    setReport({ total: r.total, rounds: r.rounds.length, roundHoles: r.roundHoles.length, shots: r.shots.length });
  }
  useEffect(() => {
    refresh();
  }, []);

  async function handleRepair() {
    setBusy(true);
    try {
      setRepairResult(await repairDanglingReferences());
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Data integrity">
      {report === null ? (
        <div className="note">Checking…</div>
      ) : report.total === 0 ? (
        <Note tone="ok">All rounds resolve their course and holes.</Note>
      ) : (
        <div className="card" style={{ borderColor: "rgba(255,107,107,.3)" }}>
          <div className="row mb-2" style={{ gap: 8 }}>
            <span className="danger" style={{ display: "flex" }}>
              <Icon.warn size={17} />
            </span>
            <span className="small">
              {report.total} orphaned record(s) from old course re-imports: {report.rounds} round(s),{" "}
              {report.roundHoles} hole result(s), {report.shots} shot(s).
            </span>
          </div>
          <Button size="sm" onClick={handleRepair} disabled={busy}>
            {busy ? "Repairing…" : "Repair"}
          </Button>
        </div>
      )}
      {repairResult && (
        <div className="mt-2">
          <Note tone="ok">
            Repaired {repairResult.repairedRounds} rounds and {repairResult.repairedRoundHoles} hole results;{" "}
            {repairResult.unrepairable} could not be matched.
          </Note>
        </div>
      )}
    </Section>
  );
}

/**
 * The bag: what's in it, what order it's carried in, and each club's numbers. Order matters
 * beyond tidiness — it's the order clubs appear in the shot sheet mid-round, so it should match
 * how they sit in the bag.
 */
function ClubsSection({ clubs }: { clubs: Club[] }) {
  const [editingBag, setEditingBag] = useState(false);
  const [newClubName, setNewClubName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function addClub() {
    const name = newClubName.trim();
    if (!name) return;
    await createClub(name);
    setNewClubName("");
  }

  return (
    <Section
      title="Clubs"
      action={
        <button className="tiny accent bold" onClick={() => setEditingBag((v) => !v)}>
          {editingBag ? "Done" : "Edit bag"}
        </button>
      }
      hint={
        editingBag
          ? "Reorder with the arrows — this is the order clubs appear when you log a shot. Rename by typing over a name."
          : "Front/back and left/right are total dispersion spread in yards (20 = ±10y). Descent angle drives elevation-corrected distances — blank uses a sensible per-club default. Partial marks shots inside that pin distance as a partial swing rather than a full one."
      }
    >
      {editingBag ? (
        <>
          <div className="stack" style={{ gap: 6 }}>
            {clubs.map((club, i) => (
              <div key={club.id} className="list-row">
                <input
                  className="field grow"
                  style={{ padding: "7px 10px" }}
                  defaultValue={club.name}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== club.name) renameClub(club.id, next);
                    else e.target.value = club.name;
                  }}
                  aria-label={`Rename ${club.name}`}
                />
                <span className="row" style={{ gap: 4 }}>
                  <button
                    className="map-btn"
                    style={{ width: 32, height: 32 }}
                    onClick={() => moveClub(club.id, -1)}
                    disabled={i === 0}
                    aria-label={`Move ${club.name} up`}
                  >
                    ↑
                  </button>
                  <button
                    className="map-btn"
                    style={{ width: 32, height: 32 }}
                    onClick={() => moveClub(club.id, 1)}
                    disabled={i === clubs.length - 1}
                    aria-label={`Move ${club.name} down`}
                  >
                    ↓
                  </button>
                  <button
                    className="map-btn"
                    style={{ width: 32, height: 32, color: "var(--danger)" }}
                    onClick={() => setConfirmDelete(club.id)}
                    aria-label={`Remove ${club.name}`}
                  >
                    <Icon.trash size={15} />
                  </button>
                </span>
              </div>
            ))}
          </div>

          {confirmDelete && (
            <div className="card mt-2" style={{ borderColor: "rgba(255,107,107,.3)" }}>
              <div className="small mb-2">
                Remove {clubs.find((c) => c.id === confirmDelete)?.name}? Shots already recorded
                with it keep their history but will show as an unknown club.
              </div>
              <div className="row" style={{ gap: 8 }}>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    await deleteClub(confirmDelete);
                    setConfirmDelete(null);
                  }}
                >
                  Remove
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="row mt-2" style={{ gap: 8 }}>
            <input
              className="field grow"
              placeholder="Add a club (e.g. 3 Wood)"
              value={newClubName}
              onChange={(e) => setNewClubName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addClub();
              }}
            />
            <Button size="sm" onClick={addClub} disabled={!newClubName.trim()}>
              <Icon.plus size={15} /> Add
            </Button>
          </div>
        </>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Club</th>
                <th>F/B</th>
                <th>L/R</th>
                <th>Actual</th>
                <th>Descent</th>
                <th>Partial &lt;</th>
              </tr>
            </thead>
            <tbody>
              {clubs.map((c) => (
                // Keyed on the seed-backfilled fields too: ClubRow captures them into local input
                // state once on mount, and the one-time ensureDefaultClubs backfill can land
                // AFTER the live query's first emission. Commits happen on blur, so a remount
                // never steals focus mid-typing.
                <ClubRow key={`${c.id}:${c.fullSwingMinYards ?? ""}:${c.descentAngleDeg ?? ""}`} club={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function ClubRow({ club }: { club: Club }) {
  const [frontBack, setFrontBack] = useState(club.manualFrontBackYards?.toString() ?? "");
  const [leftRight, setLeftRight] = useState(club.manualLeftRightYards?.toString() ?? "");
  const [descent, setDescent] = useState(club.descentAngleDeg?.toString() ?? "");
  const [partialUnder, setPartialUnder] = useState(club.fullSwingMinYards?.toString() ?? "");

  function commit(
    raw: string,
    field: "manualFrontBackYards" | "manualLeftRightYards" | "descentAngleDeg" | "fullSwingMinYards"
  ) {
    const n = parseFloat(raw);
    updateClubDispersion(club.id, { [field]: Number.isFinite(n) && n >= 0 ? n : null });
  }

  return (
    <tr>
      <td className="is-primary">{club.name}</td>
      <td>
        <input
          className="field field--num"
          type="number"
          inputMode="decimal"
          min={0}
          value={frontBack}
          onChange={(e) => setFrontBack(e.target.value)}
          onBlur={() => commit(frontBack, "manualFrontBackYards")}
        />
      </td>
      <td>
        <input
          className="field field--num"
          type="number"
          inputMode="decimal"
          min={0}
          value={leftRight}
          onChange={(e) => setLeftRight(e.target.value)}
          onBlur={() => commit(leftRight, "manualLeftRightYards")}
        />
      </td>
      <td style={{ textAlign: "center" }}>
        <input
          className="switch"
          type="checkbox"
          checked={!!club.useActualDispersion}
          onChange={(e) => updateClubDispersion(club.id, { useActualDispersion: e.target.checked })}
        />
      </td>
      <td>
        <input
          className="field field--num"
          type="number"
          inputMode="decimal"
          // 0 would divide by tan(0) in the elevation correction. The engine clamps to 10-80
          // regardless, but the field shouldn't invite a value it's going to ignore.
          min={10}
          max={80}
          value={descent}
          onChange={(e) => setDescent(e.target.value)}
          onBlur={() => commit(descent, "descentAngleDeg")}
        />
      </td>
      <td>
        <input
          className="field field--num"
          type="number"
          inputMode="decimal"
          min={0}
          value={partialUnder}
          onChange={(e) => setPartialUnder(e.target.value)}
          onBlur={() => commit(partialUnder, "fullSwingMinYards")}
        />
      </td>
    </tr>
  );
}

/** NFC tag → club pairing. Tags are identified by hardware serial only — blank NTAG213 stickers
 * work as-is and stay reassignable; nothing is ever written to a tag. */
function NfcPairingSection({ clubs }: { clubs: Club[] }) {
  const tags = useLiveQuery(() => listClubTags(), []);
  const [armedClubId, setArmedClubId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cancelScanRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelScanRef.current?.(), []);

  function armPairing(clubId: string) {
    cancelScanRef.current?.();
    setArmedClubId(clubId);
    setMessage("Touch the tag to the back of the phone…");
    cancelScanRef.current = scanOnce(
      async (serial) => {
        await pairClubTag(serial, clubId);
        setArmedClubId(null);
        setMessage(`Paired …${serial.slice(-8)} to ${clubs.find((c) => c.id === clubId)?.name ?? "club"}.`);
      },
      (err) => {
        setArmedClubId(null);
        setMessage(`NFC: ${err}`);
      }
    );
  }

  function cancelPairing() {
    cancelScanRef.current?.();
    cancelScanRef.current = null;
    setArmedClubId(null);
    setMessage(null);
  }

  if (!isNfcSupported()) {
    return (
      <Section title="Club tags (NFC)">
        <Note>Web NFC isn't available in this browser — tag pairing works on the phone (Chrome on Android).</Note>
      </Section>
    );
  }

  return (
    <Section
      title="Club tags (NFC)"
      hint="Stick a blank NFC tag on each club and pair it here. During a round, just touch the club to the phone as you pull it — no confirmation needed."
    >
      <div className="stack" style={{ gap: 6 }}>
        {clubs.map((club) => {
          const serial = tags?.find((t) => t.clubId === club.id)?.serialNumber ?? null;
          const isArming = armedClubId === club.id;
          return (
            <div key={club.id} className="list-row">
              <span className="row grow" style={{ minWidth: 0 }}>
                <span className="grow truncate">{club.name}</span>
                {serial ? <Badge tone="accent">…{serial.slice(-6)}</Badge> : <Badge>no tag</Badge>}
              </span>
              <span className="row" style={{ gap: 6 }}>
                {isArming ? (
                  <Button size="sm" variant="ghost" onClick={cancelPairing}>
                    Scanning…
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => armPairing(club.id)}>
                    {serial ? "Re-pair" : "Pair"}
                  </Button>
                )}
                {serial && !isArming && (
                  <button className="map-btn" style={{ width: 30, height: 30, color: "var(--danger)" }} onClick={() => unpairClubTag(serial)} aria-label="Unpair">
                    <Icon.trash size={15} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {message && (
        <div className="mt-2">
          <Note tone="ok">{message}</Note>
        </div>
      )}
    </Section>
  );
}

/** Strokes-gained baseline CSV import. The app ships no baseline — published expected-strokes
 * tables are proprietary; the user sources their own. */
function SgBaselineSection() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    baselineRowCount().then(setRowCount);
  }, []);

  async function handleFile(file: File) {
    setMessage(null);
    setError(null);
    try {
      const n = await importBaselineCsv(await file.text());
      setRowCount(n);
      setMessage(`Imported ${n} baseline rows.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Section
      title="Strokes-gained baseline"
      hint={
        <>
          CSV columns: <code>lie,distanceYards,expectedStrokes</code> (header optional). Lies: tee,
          fairway, rough, fringe, green, bunker_greenside, bunker_fairway, recovery.
        </>
      }
    >
      <div className="row row--wrap" style={{ gap: 8 }}>
        <Button size="sm" onClick={() => inputRef.current?.click()}>
          <Icon.upload size={15} /> Import CSV
        </Button>
        {rowCount !== null && <Badge tone={rowCount > 0 ? "accent" : "neutral"}>{rowCount > 0 ? `${rowCount} rows loaded` : "none loaded"}</Badge>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) handleFile(file);
        }}
      />
      {message && (
        <div className="mt-2">
          <Note tone="ok">{message}</Note>
        </div>
      )}
      {error && (
        <div className="mt-2">
          <Note tone="danger">{error}</Note>
        </div>
      )}
    </Section>
  );
}
