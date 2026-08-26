import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation, useSearchParams } from "react-router-dom";
import TopNav from "./components/layout/TopNav.jsx";
import ContextBar from "./components/layout/ContextBar.jsx";
import AnalysisLayout from "./components/layout/AnalysisLayout.jsx";
import { LoadingState } from "./components/states/States.jsx";
import ErrorBoundary from "./components/common/ErrorBoundary.jsx";
import AccessGate from "./pages/AccessGate.jsx";
import { useAuth } from "./context/AuthContext.jsx";

// Core pages (small, needed on first paint)
import Overview from "./pages/Overview.jsx";
import Datasets from "./pages/Datasets.jsx";
import MarketsPage from "./pages/MarketsPage.jsx";

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

/**
 * Page ownership map (v0.19.0):
 *   DISCOVER  /            Overview   – command center; summarizes + links deeper
 *   DISCOVER  /markets     Markets    – discovery: watchlist, quotes, movers, news
 *   ANALYZE   /analysis/*  one shared workspace with five views of the SAME asset
 *   RESEARCH  /compare /ai /report      cross-asset & narrative tools
 *   DATA      /datasets /database         storage management
 */
function LegacyAnalysisRedirect({ view }) {
  const [params] = useSearchParams();
  const dataset = params.get("dataset");
  return (
    <Navigate
      to={`/analysis/${view}${dataset ? `?dataset=${dataset}` : ""}`}
      replace
    />
  );
}

export default function App() {
  const { ready, role } = useAuth();
  const location = useLocation();
  const inAnalysisWorkspace = location.pathname.startsWith("/analysis");

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
      {/* The analysis shell renders the richer AssetContextBar itself, so
          the thin global context bar would only duplicate it there. */}
      {!inAnalysisWorkspace && <ContextBar />}
      <main className="main-content" id="main">
        <ErrorBoundary>
          <Suspense fallback={<LoadingState label="LOADING VIEW" />}>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/markets" element={<MarketsPage />} />
              <Route path="/datasets" element={<Datasets />} />

              <Route path="/analysis" element={<AnalysisLayout />}>
                <Route index element={<Navigate to="fingerprint" replace />} />
                <Route path="fingerprint" element={<FingerprintPage />} />
                <Route path="analogues" element={<AnaloguesPage />} />
                <Route path="regimes" element={<RegimesPage />} />
                <Route path="intelligence" element={<IntelligencePage />} />
                <Route path="heatmaps" element={<HeatmapsPage />} />
              </Route>

              {/* Pre-0.19 deep links keep working (query preserved). */}
              <Route path="/fingerprint" element={<LegacyAnalysisRedirect view="fingerprint" />} />
              <Route path="/analogues" element={<LegacyAnalysisRedirect view="analogues" />} />
              <Route path="/regimes" element={<LegacyAnalysisRedirect view="regimes" />} />
              <Route path="/intelligence" element={<LegacyAnalysisRedirect view="intelligence" />} />
              <Route path="/heatmaps" element={<LegacyAnalysisRedirect view="heatmaps" />} />

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
