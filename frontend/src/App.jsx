import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import TopNav from "./components/layout/TopNav.jsx";
import ContextBar from "./components/layout/ContextBar.jsx";
import { LoadingState } from "./components/states/States.jsx";
import ErrorBoundary from "./components/common/ErrorBoundary.jsx";
import AccessGate from "./pages/AccessGate.jsx";
import { useAuth } from "./context/AuthContext.jsx";

// Core pages (small, needed on first paint)
import Overview from "./pages/Overview.jsx";
import Datasets from "./pages/Datasets.jsx";

// Heavier analytical pages load on demand
const FingerprintPage = lazy(() => import("./pages/FingerprintPage.jsx"));
const AnaloguesPage = lazy(() => import("./pages/AnaloguesPage.jsx"));
const RegimesPage = lazy(() => import("./pages/RegimesPage.jsx"));
const IntelligencePage = lazy(() => import("./pages/IntelligencePage.jsx"));
const HeatmapsPage = lazy(() => import("./pages/HeatmapsPage.jsx"));
const ComparePage = lazy(() => import("./pages/ComparePage.jsx"));
const AiPage = lazy(() => import("./pages/AiPage.jsx"));
const ReportPage = lazy(() => import("./pages/ReportPage.jsx"));
const DatabasePage = lazy(() => import("./pages/DatabasePage.jsx"));

export default function App() {
  const { ready, role } = useAuth();

  if (!ready) {
    return (
      <div className="app-shell">
        <main className="main-content">
          <LoadingState label="VERIFYING ACCESS" />
        </main>
      </div>
    );
  }

  if (!role) {
    return <AccessGate />;
  }

  return (
    <div className="app-shell">
      <TopNav />
      <ContextBar />
      <main className="main-content" id="main">
        <ErrorBoundary>
          <Suspense fallback={<LoadingState label="LOADING VIEW" />}>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/datasets" element={<Datasets />} />
              <Route path="/fingerprint" element={<FingerprintPage />} />
              <Route path="/analogues" element={<AnaloguesPage />} />
              <Route path="/regimes" element={<RegimesPage />} />
              <Route path="/intelligence" element={<IntelligencePage />} />
              <Route path="/heatmaps" element={<HeatmapsPage />} />
              <Route path="/compare" element={<ComparePage />} />
              <Route path="/ai" element={<AiPage />} />
              <Route path="/report" element={<ReportPage />} />
              <Route path="/database" element={<DatabasePage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
