import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { PageHeader } from "../components/PageHeader";
import { ensureDefaultClubs, listClubs, updateClubDispersion } from "../lib/courseRepo";
import { isGpsEnabled, setGpsEnabled } from "../lib/settings";
import { backupFilename, exportAll, importAll, readBackup, type BackupEnvelope, type BackupSummary } from "../lib/backup";
import { findDanglingReferences, repairDanglingReferences, type RepairResult } from "../lib/integrity";
import { listClubTags, pairClubTag, unpairClubTag } from "../lib/captureRepo";
import { isNfcSupported, scanOnce } from "../lib/nfc";
import { baselineRowCount, importBaselineCsv } from "../lib/sg";
import type { Club } from "../types/domain";

/**
 * Per-club dispersion editor: manual front/back + left/right yardages (used to draw the
 * dispersion ellipse overlay on the round map — see lib/dispersion.ts), plus a per-club toggle
 * to prefer computing the ellipse from actual recorded shot history instead, when there's
 * enough of it. Edits are debounced-free (blur/change-committed) direct writes — this is a
 * low-frequency settings table, not a live-typing surface.
 */
export function SettingsPage() {
  // Seeding (a write) can't happen inside useLiveQuery's callback — Dexie runs it in a read-only
  // transaction and throws ReadOnlyError. Seed once on mount instead; the live query below just reads.
  useEffect(() => {
    ensureDefaultClubs();
  }, []);
  const clubs = useLiveQuery(() => listClubs(), []);

  const [gpsEnabled, setGpsEnabledState] = useState(isGpsEnabled);
  function toggleGps(enabled: boolean) {
    setGpsEnabledState(enabled);
    setGpsEnabled(enabled);
  }

  return (
    <div style={{ padding: 16 }}>
      <PageHeader title="Settings" />
      <p style={{ opacity: 0.8, marginBottom: 20 }}>
        Not built yet: units, default aim-point rule, strokes-gained baseline default, Supabase
        sync status.
      </p>

      <BackupSection />
      <IntegritySection />

      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Location</h2>
      <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <input type="checkbox" checked={gpsEnabled} onChange={(e) => toggleGps(e.target.checked)} />
        <span style={{ fontSize: 14 }}>Use live GPS on the course</span>
      </label>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 20 }}>
        When on, the round map anchors distances to your real position once you're within ~2000
        yards of a hole's tee. Turn off to always measure from the saved tee boxes instead (useful
        when reviewing a course from home, or if GPS is being unreliable). Takes effect next time
        you open a round.
      </p>

      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Club dispersion</h2>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 12 }}>
        Front/back and left/right are total spread in yards (e.g. 20 = ±10y). "Actual" computes
        the ellipse from recorded shots with a known aim point instead, once there's enough of
        them, falling back to the manual values below when there isn't.
      </p>

      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Club</th>
              <th style={thStyle}>Front/Back (y)</th>
              <th style={thStyle}>Left/Right (y)</th>
              <th style={thStyle}>Actual</th>
              <th style={thStyle}>Descent (°)</th>
              <th style={thStyle}>Partial &lt; (y)</th>
            </tr>
          </thead>
          <tbody>
            {clubs?.map((c) => (
              // Keyed on the seed-backfilled fields too: ClubRow captures them into local input
              // state once on mount, and the one-time ensureDefaultClubs backfill can land AFTER
              // the live query's first emission — remounting on that change keeps the inputs
              // honest. Commits happen on blur, so the remount never steals focus mid-typing.
              <ClubRow key={`${c.id}:${c.fullSwingMinYards ?? ""}:${c.descentAngleDeg ?? ""}`} club={c} />
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
        Descent angle feeds elevation-normalised distances (blank = sensible per-club default).
        "Partial &lt;" marks shots inside that pin distance as partial swings (blank = never).
      </p>

      <NfcPairingSection clubs={clubs ?? []} />
      <SgBaselineSection />
    </div>
  );
}

/** Strokes-gained baseline CSV import (REVISION-SPEC 5.6). The app ships no baseline — published
 * expected-strokes tables are proprietary; the user sources their own. */
function SgBaselineSection() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    baselineRowCount().then(setRowCount);
  }, []);

  async function handleFile(file: File) {
    setMessage(null);
    try {
      const n = await importBaselineCsv(await file.text());
      setRowCount(n);
      setMessage(`Imported ${n} baseline rows.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Strokes-gained baseline</h2>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 10 }}>
        CSV format: <code>lie,distanceYards,expectedStrokes</code> (header optional). Lies:
        tee, fairway, rough, fringe, green, bunker_greenside, bunker_fairway, recovery.
        {rowCount !== null && rowCount > 0 ? ` Currently loaded: ${rowCount} rows.` : " No baseline loaded yet."}
      </p>
      <button onClick={() => inputRef.current?.click()} style={settingsButtonStyle}>
        Import baseline CSV…
      </button>
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
      {message && <p style={{ fontSize: 13, marginTop: 8, color: "#8fd694" }}>{message}</p>}
    </div>
  );
}

/** NFC tag → club pairing (REVISION-SPEC 2.1). Tags identified by hardware serial only — blank
 * NTAG213 stickers work as-is and stay reassignable; nothing is ever written to a tag. */
function NfcPairingSection({ clubs }: { clubs: Club[] }) {
  const tags = useLiveQuery(() => listClubTags(), []);
  const [armedClubId, setArmedClubId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cancelScanRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelScanRef.current?.(), []);

  function serialForClub(clubId: string): string | null {
    return tags?.find((t) => t.clubId === clubId)?.serialNumber ?? null;
  }

  function armPairing(clubId: string) {
    cancelScanRef.current?.();
    setArmedClubId(clubId);
    setMessage("Touch the tag to the back of the phone…");
    cancelScanRef.current = scanOnce(
      async (serial) => {
        await pairClubTag(serial, clubId);
        const club = clubs.find((c) => c.id === clubId);
        setArmedClubId(null);
        setMessage(`Paired tag …${serial.slice(-8)} to ${club?.name ?? "club"}.`);
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
      <div style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Club tags (NFC)</h2>
        <p style={{ fontSize: 13, opacity: 0.7 }}>
          Web NFC isn't available in this browser — pairing works on the phone (Chrome on
          Android), not on desktop.
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Club tags (NFC)</h2>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 12 }}>
        Stick a blank NFC tag on each club, pair it here, then during a round just touch the club
        to the phone when you pull it — no confirmation needed.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {clubs.map((club) => {
          const serial = serialForClub(club.id);
          const isArming = armedClubId === club.id;
          return (
            <div key={club.id} style={nfcRowStyle}>
              <span style={{ flex: 1, fontSize: 14 }}>{club.name}</span>
              <span style={{ fontSize: 12, opacity: 0.65, marginRight: 8 }}>
                {serial ? `…${serial.slice(-8)}` : "no tag"}
              </span>
              {isArming ? (
                <button onClick={cancelPairing} style={{ ...settingsButtonStyle, padding: "6px 10px", fontSize: 12 }}>
                  Scanning… cancel
                </button>
              ) : (
                <button onClick={() => armPairing(club.id)} style={{ ...settingsButtonStyle, padding: "6px 10px", fontSize: 12 }}>
                  {serial ? "Re-pair" : "Pair tag"}
                </button>
              )}
              {serial && !isArming && (
                <button
                  onClick={() => unpairClubTag(serial)}
                  style={{ ...settingsButtonStyle, padding: "6px 10px", fontSize: 12, marginLeft: 6 }}
                >
                  Unpair
                </button>
              )}
            </div>
          );
        })}
      </div>
      {message && <p style={{ fontSize: 13, marginTop: 8, color: "#8fd694" }}>{message}</p>}
    </div>
  );
}

const nfcRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "8px 10px",
  background: "#101812",
  border: "1px solid #1c2c20",
  borderRadius: 8
};

/** Export/import of the entire local database (REVISION-SPEC 0.1). All data is device-local
 * IndexedDB — this is the only backup path that exists. */
function BackupSection() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ envelope: BackupEnvelope; summary: BackupSummary } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleExport() {
    setMessage(null);
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
      setMessage(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File) {
    setMessage(null);
    try {
      setPending(await readBackup(file));
    } catch (e) {
      setPending(null);
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleImport(mode: "merge" | "replace") {
    if (!pending) return;
    setBusy(true);
    try {
      await importAll(pending.envelope, mode);
      setPending(null);
      setMessage(`Import (${mode}) complete — ${pending.summary.totalRows} rows.`);
    } catch (e) {
      setMessage(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Backup</h2>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 10 }}>
        Everything lives only on this device. Export before clearing site data, switching phones,
        or reinstalling — there is no cloud copy.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button onClick={handleExport} disabled={busy} style={settingsButtonStyle}>
          Export backup
        </button>
        <button onClick={() => fileInputRef.current?.click()} disabled={busy} style={settingsButtonStyle}>
          Import backup…
        </button>
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
        <div style={confirmBoxStyle}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Backup from {pending.summary.exportedAt.slice(0, 10)} (schema v{pending.summary.schemaVersion})
          </div>
          <div style={{ fontSize: 12.5, opacity: 0.85, marginBottom: 8 }}>
            {Object.entries(pending.summary.counts)
              .filter(([, n]) => n > 0)
              .map(([t, n]) => `${t}: ${n}`)
              .join(" · ") || "No rows"}
          </div>
          <div style={{ fontSize: 12.5, opacity: 0.75, marginBottom: 10 }}>
            <strong>Merge</strong> upserts rows by id, keeping anything newer on this device.{" "}
            <strong>Replace</strong> clears every table first — current data is lost.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => handleImport("merge")} disabled={busy} style={settingsButtonStyle}>
              Import (merge)
            </button>
            <button onClick={() => handleImport("replace")} disabled={busy} style={{ ...settingsButtonStyle, borderColor: "#b91c1c", color: "#fca5a5" }}>
              Import (replace)
            </button>
            <button onClick={() => setPending(null)} disabled={busy} style={settingsButtonStyle}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && <p style={{ fontSize: 13, marginTop: 8, color: "#8fd694" }}>{message}</p>}
    </div>
  );
}

/** Dangling-reference report + repair (REVISION-SPEC 0.2). Pre-revision reseed migrations wiped
 * courses while leaving rounds pointing at dead UUIDs; this recovers what it can. */
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

  if (!report || report.total === 0) {
    return (
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Data integrity</h2>
        <p style={{ fontSize: 13, opacity: 0.7 }}>
          {report === null ? "Checking…" : "No dangling references — all rounds resolve their course and holes."}
          {repairResult && ` (Repaired ${repairResult.repairedRounds} rounds, ${repairResult.repairedRoundHoles} holes; ${repairResult.unrepairable} unrepairable.)`}
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Data integrity</h2>
      <p style={{ fontSize: 13, color: "#fca5a5", marginBottom: 8 }}>
        {report.total} orphaned record(s) from old course re-imports: {report.rounds} round(s),{" "}
        {report.roundHoles} hole result(s), {report.shots} shot(s) no longer resolve their course
        or hole.
      </p>
      <button onClick={handleRepair} disabled={busy} style={settingsButtonStyle}>
        {busy ? "Repairing…" : "Repair (re-point to nearest matching hole)"}
      </button>
      {repairResult && (
        <p style={{ fontSize: 13, marginTop: 8, color: "#8fd694" }}>
          Repaired {repairResult.repairedRounds} rounds and {repairResult.repairedRoundHoles} hole results;{" "}
          {repairResult.unrepairable} could not be repaired (no recorded positions to match on).
        </p>
      )}
    </div>
  );
}

const settingsButtonStyle: React.CSSProperties = {
  padding: "10px 14px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 8,
  fontSize: 14,
  cursor: "pointer"
};

const confirmBoxStyle: React.CSSProperties = {
  marginTop: 12,
  background: "#101812",
  border: "1px solid #6b4d16",
  borderRadius: 10,
  padding: 12,
  color: "#eef2ef"
};

function ClubRow({ club }: { club: Club }) {
  const [frontBack, setFrontBack] = useState(club.manualFrontBackYards?.toString() ?? "");
  const [leftRight, setLeftRight] = useState(club.manualLeftRightYards?.toString() ?? "");
  const [descent, setDescent] = useState(club.descentAngleDeg?.toString() ?? "");
  const [partialUnder, setPartialUnder] = useState(club.fullSwingMinYards?.toString() ?? "");

  function commitNumber(
    raw: string,
    field: "manualFrontBackYards" | "manualLeftRightYards" | "descentAngleDeg" | "fullSwingMinYards"
  ) {
    const n = parseFloat(raw);
    updateClubDispersion(club.id, { [field]: Number.isFinite(n) && n >= 0 ? n : null });
  }

  return (
    <tr>
      <td style={tdStyle}>{club.name}</td>
      <td style={tdStyle}>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={frontBack}
          onChange={(e) => setFrontBack(e.target.value)}
          onBlur={() => commitNumber(frontBack, "manualFrontBackYards")}
          style={inputStyle}
        />
      </td>
      <td style={tdStyle}>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={leftRight}
          onChange={(e) => setLeftRight(e.target.value)}
          onBlur={() => commitNumber(leftRight, "manualLeftRightYards")}
          style={inputStyle}
        />
      </td>
      <td style={{ ...tdStyle, textAlign: "center" }}>
        <input
          type="checkbox"
          checked={!!club.useActualDispersion}
          onChange={(e) => updateClubDispersion(club.id, { useActualDispersion: e.target.checked })}
        />
      </td>
      <td style={tdStyle}>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={descent}
          onChange={(e) => setDescent(e.target.value)}
          onBlur={() => commitNumber(descent, "descentAngleDeg")}
          style={inputStyle}
        />
      </td>
      <td style={tdStyle}>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={partialUnder}
          onChange={(e) => setPartialUnder(e.target.value)}
          onBlur={() => commitNumber(partialUnder, "fullSwingMinYards")}
          style={inputStyle}
        />
      </td>
    </tr>
  );
}

const tableWrapStyle: React.CSSProperties = {
  overflowX: "auto",
  border: "1px solid #2f5c3d",
  borderRadius: 10
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  background: "#1a3a24",
  borderBottom: "1px solid #2f5c3d",
  whiteSpace: "nowrap"
};

const tdStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid #16241a"
};

const inputStyle: React.CSSProperties = {
  width: 72,
  padding: "6px 8px",
  background: "#0b0f0c",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 6,
  fontSize: 13
};
