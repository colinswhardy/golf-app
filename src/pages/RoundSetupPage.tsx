import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useParams } from "react-router-dom";
import { AppBar, Badge, Button, Chip, Icon, Note, Page, Section } from "../components/ui";
import { db } from "../lib/db";
import { getHolesForVersion, getLatestCourseVersion, listClubs } from "../lib/courseRepo";
import { getActiveRoundForCourse, startRound } from "../lib/roundRepo";
import { listClubTags } from "../lib/captureRepo";
import { isNfcSupported } from "../lib/nfc";
import { startNfcSession } from "../lib/nfcSession";
import { getTeePreference, isSimulationEnabled, setTeePreference } from "../lib/settings";
import { holeRangeFor, offersNines, offersTeeChoice, summariseTeeSets, type NineChoice } from "../lib/roundSetup";

/**
 * Everything decided before the first tee: how many holes, off which tees, and whether the club
 * tags are armed. These used to be floating controls on the round map itself, which put a
 * once-per-round decision in front of you on every hole and left it one mis-tap from changing
 * mid-round.
 *
 * This screen also owns the gesture that arms NFC (see lib/nfcSession).
 */
export function RoundSetupPage() {
  const { courseId } = useParams();
  const navigate = useNavigate();

  const course = useLiveQuery(() => (courseId ? db.courses.get(courseId) : undefined), [courseId]);
  const courseVersion = useLiveQuery(() => (courseId ? getLatestCourseVersion(courseId) : undefined), [courseId]);
  const holes = useLiveQuery(
    () => (courseVersion ? getHolesForVersion(courseVersion.id) : []),
    [courseVersion?.id]
  );
  const teeBoxes = useLiveQuery(async () => {
    if (!holes?.length) return [];
    return db.teeBoxes.where("holeId").anyOf(holes.map((h) => h.id)).toArray();
  }, [holes]);

  // An unfinished round on this course is resumed, never silently replaced — starting a second
  // one would strand the first as an in-progress round nothing navigates to.
  const [activeRound, setActiveRound] = useState<Awaited<ReturnType<typeof getActiveRoundForCourse>>>(undefined);
  const [checkedActive, setCheckedActive] = useState(false);
  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    getActiveRoundForCourse(courseId).then((r) => {
      if (cancelled) return;
      setActiveRound(r);
      setCheckedActive(true);
    });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const firstHole = holes?.length ? Math.min(...holes.map((h) => h.number)) : 1;
  const lastHole = holes?.length ? Math.max(...holes.map((h) => h.number)) : 18;
  const canChooseNine = offersNines(lastHole);

  const [nineChoice, setNineChoice] = useState<NineChoice>("full");
  const [teeName, setTeeName] = useState<string>(getTeePreference);
  const [starting, setStarting] = useState(false);

  const teeSets = useMemo(() => summariseTeeSets(teeBoxes ?? []), [teeBoxes]);

  // The preference carries across courses, so it can name a set this one doesn't have (every
  // course names its tees differently, and some don't name them at all). Fall back to backmost
  // rather than leaving nothing selected and starting off a set that isn't here.
  useEffect(() => {
    if (!teeBoxes || !teeName) return;
    if (!teeSets.some((t) => t.name === teeName)) setTeeName("");
  }, [teeBoxes, teeSets, teeName]);
  const range = holeRangeFor(nineChoice, firstHole, lastHole);
  const holeCount = Math.max(0, range.end - range.start + 1);

  // Par for the selected range, so the choice reads as a real round rather than a hole count.
  const rangePar = useMemo(
    () =>
      (holes ?? [])
        .filter((h) => h.number >= range.start && h.number <= range.end)
        .reduce((sum, h) => sum + (h.par ?? 0), 0),
    [holes, range.start, range.end]
  );

  // Tag readiness is worth seeing before you walk off, not after: an unpaired club is a shot
  // that captures as "unpaired tag" and needs fixing by hand afterwards.
  const clubs = useLiveQuery(() => listClubs(), []);
  const tags = useLiveQuery(() => listClubTags(), []);
  const taggedClubs = useMemo(() => {
    if (!clubs || !tags) return null;
    const tagged = new Set(tags.map((t) => t.clubId));
    return { tagged: clubs.filter((c) => tagged.has(c.id)).length, total: clubs.length };
  }, [clubs, tags]);

  const simulation = isSimulationEnabled();

  async function handleStart() {
    if (!courseVersion || starting) return;
    setStarting(true);
    // Fire before the first await. Chrome grants NFC only from a live user gesture, and awaiting
    // the round write first spends the activation — the scan would then be rejected.
    const armed = isNfcSupported() && !simulation ? startNfcSession() : Promise.resolve(false);
    try {
      await startRound(courseVersion.id, { startHole: range.start, endHole: range.end });
      setTeePreference(teeName);
      await armed;
      navigate(`/round/${courseId}`, { replace: true });
    } catch {
      setStarting(false);
    }
  }

  if (!courseId) return null;

  const loading = !course || !courseVersion || !holes || !checkedActive;

  return (
    <Page>
      <AppBar
        title={course?.name ?? "Round setup"}
        subtitle={holes?.length ? `${holes.length} holes mapped` : undefined}
      />

      {loading ? (
        <div className="card dim small">Loading course…</div>
      ) : activeRound ? (
        <div className="card card--accent">
          <Badge tone="accent">Round in progress</Badge>
          <div className="card__title mt-1">Pick up where you left off</div>
          <div className="card__meta mt-1" style={{ lineHeight: 1.5 }}>
            A round on this course is still open
            {activeRound.startHole && activeRound.endHole
              ? ` (holes ${activeRound.startHole}–${activeRound.endHole})`
              : ""}
            . Finish or abandon it from the Rounds list before starting another.
          </div>
          <div className="row row--wrap mt-2" style={{ gap: 8 }}>
            <Button variant="primary" onClick={() => navigate(`/round/${courseId}`, { replace: true })}>
              <Icon.play size={16} /> Resume round
            </Button>
            <Button size="sm" onClick={() => navigate("/rounds")}>
              Rounds
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Section
            title="Holes"
            hint={
              canChooseNine
                ? "Decided once. The round ends on the last hole of whichever range you pick."
                : undefined
            }
          >
            {canChooseNine ? (
              <div className="chip-row">
                <Chip active={nineChoice === "full"} onClick={() => setNineChoice("full")}>
                  18 holes
                </Chip>
                <Chip active={nineChoice === "front"} onClick={() => setNineChoice("front")}>
                  Front 9
                </Chip>
                <Chip active={nineChoice === "back"} onClick={() => setNineChoice("back")}>
                  Back 9
                </Chip>
              </div>
            ) : (
              <div className="card">
                <div className="card__title">
                  {holeCount} {holeCount === 1 ? "hole" : "holes"}
                </div>
                <div className="card__meta mt-1">
                  This course is played whole — there's no second nine to choose between.
                </div>
              </div>
            )}
            <div className="tiny faint mt-2">
              Holes {range.start}–{range.end}
              {rangePar > 0 ? ` · par ${rangePar}` : ""}
            </div>
          </Section>

          <Section
            title="Tees"
            hint="Distances measure from here on any hole where this set is mapped; the backmost tee stands in on the rest."
          >
            {!offersTeeChoice(teeSets) ? (
              <Note>
                {teeSets.length === 0
                  ? "No tee boxes are mapped on this course — every hole measures from its centerline start."
                  : "This course has one unnamed tee per hole in the map data, so there's no set to choose between."}
              </Note>
            ) : (
              <>
                <div className="chip-row">
                  <Chip active={teeName === ""} onClick={() => setTeeName("")}>
                    Backmost
                  </Chip>
                  {teeSets.map((t) => (
                    <Chip key={t.name} active={teeName === t.name} onClick={() => setTeeName(t.name)}>
                      {t.name}
                    </Chip>
                  ))}
                </div>
                {(() => {
                  const chosen = teeSets.find((t) => t.name === teeName);
                  if (!chosen || !holes?.length) return null;
                  if (chosen.holes >= holes.length) {
                    return <div className="tiny faint mt-2">Mapped on all {holes.length} holes.</div>;
                  }
                  return (
                    <div className="mt-2">
                      <Note tone="warn">
                        {chosen.name} is mapped on {chosen.holes} of {holes.length} holes — the rest
                        fall back to the backmost tee.
                      </Note>
                    </div>
                  );
                })()}
              </>
            )}
          </Section>

          <Section title="Club tags">
            <div className="card">
              {simulation ? (
                <>
                  <div className="row" style={{ gap: 8 }}>
                    <Badge tone="warn">Simulation</Badge>
                    <span className="small">On-screen buttons stand in for the tags.</span>
                  </div>
                  <div className="card__meta mt-1">
                    Turn simulation off in Settings to use the real tags.
                  </div>
                </>
              ) : !isNfcSupported() ? (
                <div className="small dim">
                  Web NFC isn't available in this browser — tags work in Chrome on Android.
                </div>
              ) : (
                <>
                  <div className="row row--between">
                    <span className="small">Scanning arms when the round starts</span>
                    {taggedClubs && (
                      <Badge tone={taggedClubs.tagged === taggedClubs.total ? "accent" : "warn"}>
                        {taggedClubs.tagged}/{taggedClubs.total} paired
                      </Badge>
                    )}
                  </div>
                  <div className="card__meta mt-1" style={{ lineHeight: 1.5 }}>
                    Keep the screen on and the app in front — NFC only delivers while the page is
                    visible. The round screen holds a wake lock for exactly that.
                  </div>
                  {taggedClubs && taggedClubs.tagged < taggedClubs.total && (
                    <div className="mt-2">
                      <Button size="sm" onClick={() => navigate("/settings")}>
                        Pair the rest
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </Section>

          <div className="mt-3">
            <Button variant="primary" block onClick={handleStart} disabled={starting || !courseVersion}>
              <Icon.play size={17} />{" "}
              {starting ? "Starting…" : `Start ${holeCount === 18 ? "18 holes" : `${holeCount} holes`}`}
            </Button>
          </div>
        </>
      )}
    </Page>
  );
}
