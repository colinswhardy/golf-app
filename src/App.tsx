import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";
import { CoursesPage } from "./pages/CoursesPage";
import { RoundMapPage } from "./pages/RoundMapPage";
import { ReviewRoundsPage } from "./pages/ReviewRoundsPage";
import { DataImportsPage } from "./pages/DataImportsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { CourseEditorPage } from "./pages/CourseEditorPage";
import { StatsPage } from "./pages/StatsPage";
import { seedBundledCourses } from "./lib/seedCourses";
import { pruneOutbox } from "./lib/db";

export default function App() {
  // Fire-and-forget, once per app load. Idempotent (skips courses already in Dexie),
  // so this is safe to run every time rather than needing a "first run ever" flag.
  // Outbox pruning is equally fire-and-forget: nothing drains that table yet, so old
  // entries are just dead weight.
  useEffect(() => {
    seedBundledCourses();
    pruneOutbox().catch(() => {});
  }, []);

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/courses" element={<CoursesPage />} />
        <Route path="/round/:courseId" element={<RoundMapPage />} />
        <Route path="/rounds" element={<ReviewRoundsPage />} />
        <Route path="/imports" element={<DataImportsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/course-editor" element={<CourseEditorPage />} />
        <Route path="/course-editor/:courseId" element={<CourseEditorPage />} />
        <Route path="/stats" element={<StatsPage />} />
      </Routes>
      <div style={{
        position: "fixed",
        bottom: 4,
        right: 8,
        fontSize: 10,
        color: "rgba(255,255,255,0.35)",
        pointerEvents: "none",
        zIndex: 9999
      }}>
        2.0
      </div>
    </>
  );
}
