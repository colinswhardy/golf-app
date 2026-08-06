import { useEffect } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { Home } from "./pages/Home";
import { CoursesPage } from "./pages/CoursesPage";
import { RoundMapPage } from "./pages/RoundMapPage";
import { ReviewRoundsPage } from "./pages/ReviewRoundsPage";
import { DataImportsPage } from "./pages/DataImportsPage";
import { ScorecardsPage } from "./pages/ScorecardsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { CourseEditorPage } from "./pages/CourseEditorPage";
import { StatsPage } from "./pages/StatsPage";
import { Icon } from "./components/ui";
import { seedBundledCourses } from "./lib/seedCourses";
import { pruneOutbox } from "./lib/db";

const APP_VERSION = "2.0";

const NAV = [
  { to: "/", label: "Play", icon: Icon.play, exact: true },
  { to: "/rounds", label: "Rounds", icon: Icon.flag },
  { to: "/stats", label: "Stats", icon: Icon.chart },
  { to: "/settings", label: "Settings", icon: Icon.gear }
];

/** Routes that own the whole screen (full-bleed maps) hide the tab bar — their
 * own chrome sits where the nav would be. */
const FULLSCREEN_PREFIXES = ["/round/", "/course-editor"];

function BottomNav() {
  const { pathname } = useLocation();
  if (FULLSCREEN_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  return (
    <nav className="bottom-nav">
      {NAV.map((item) => {
        const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
        const IconComponent = item.icon;
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`bottom-nav__item${active ? " bottom-nav__item--active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <IconComponent size={21} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function App() {
  const { pathname } = useLocation();
  const fullscreen = FULLSCREEN_PREFIXES.some((p) => pathname.startsWith(p));

  // Fire-and-forget, once per app load. Seeding is idempotent (courses already at
  // the current importer version are skipped), and nothing drains the outbox yet,
  // so old entries are just dead weight.
  useEffect(() => {
    seedBundledCourses();
    pruneOutbox().catch(() => {});
  }, []);

  return (
    <div className="app-shell">
      <main className={`app-main${fullscreen ? "" : " app-main--nav"}`}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/courses" element={<CoursesPage />} />
          <Route path="/round/:courseId" element={<RoundMapPage />} />
          <Route path="/rounds" element={<ReviewRoundsPage />} />
          <Route path="/imports" element={<DataImportsPage />} />
          <Route path="/scorecards" element={<ScorecardsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/course-editor" element={<CourseEditorPage />} />
          <Route path="/course-editor/:courseId" element={<CourseEditorPage />} />
          <Route path="/stats" element={<StatsPage />} />
        </Routes>
      </main>
      <BottomNav />
      {!fullscreen && <div className="version-badge">v{APP_VERSION}</div>}
    </div>
  );
}
