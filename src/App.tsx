import { Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";
import { CoursesPage } from "./pages/CoursesPage";
import { RoundMapPage } from "./pages/RoundMapPage";
import { ReviewRoundsPage } from "./pages/ReviewRoundsPage";
import { DataImportsPage } from "./pages/DataImportsPage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
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
