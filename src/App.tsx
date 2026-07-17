import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";
import { CoursesPage } from "./pages/CoursesPage";
import { RoundMapPage } from "./pages/RoundMapPage";
import { ReviewRoundsPage } from "./pages/ReviewRoundsPage";
import { DataImportsPage } from "./pages/DataImportsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { seedBundledCourses } from "./lib/seedCourses";

export default function App() {
  // Fire-and-forget, once per app load. Idempotent (skips courses already in Dexie),
  // so this is safe to run every time rather than needing a "first run ever" flag.
  useEffect(() => {
    seedBundledCourses();
  }, []);

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/courses" element={<CoursesPage />} />
      <Route path="/round/:courseId" element={<RoundMapPage />} />
      <Route path="/rounds" element={<ReviewRoundsPage />} />
      <Route path="/imports" element={<DataImportsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>
  );
}
