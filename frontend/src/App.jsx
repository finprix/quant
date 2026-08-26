import { Suspense } from "react";
import { Routes, Route, Navigate, useLocation, useSearchParams } from "react-router-dom";
import TopNav from "./components/layout/TopNav.jsx";
import ContextBar from "./components/layout/ContextBar.jsx";
import AnalysisLayout from "./components/layout/AnalysisLayout.jsx";
import { LoadingState } from "./components/states/States.jsx";
import ErrorBoundary from "./components/common/ErrorBoundary.jsx";
import { lazyWithRetry } from "./lib/lazyRetry.js";
import { useAuth } from "./context/AuthContext.jsx";

// Core pages (small, needed on first paint)
import HomePage from "./pages/HomePage.jsx";
import AssetOverviewPage from "./pages/AssetOverviewPage.jsx";
import NewsTerminalPage from "./pages/NewsTerminalPage.jsx";
import WatchlistsPage from "./pages/WatchlistsPage.jsx";
import MarketsPage from "./pages/MarketsPage.jsx";
import Datasets from "./pages/Datasets.jsx";

// Heavier analytical pages load on demand — resilient to stale chunks
// after redeploys (retry import, then one silent reload).
const FingerprintPage = lazyWithRetry(() => import("./pages/FingerprintPage.jsx"));
const AnaloguesPage = lazyWithRetry(() => import("./pages/AnaloguesPage.jsx"));
const RegimesPage = lazyWithRetry(() => import("./pages/RegimesPage.jsx"));
const IntelligencePage = lazyWithRetry(() => import("./pages/IntelligencePage.jsx"));
const HeatmapsPage = lazyWithRetry(() => import("./pages/HeatmapsPage.jsx"));
const ComparePage = lazyWithRetry(() => import("./pages/ComparePage.jsx"));
const AiPage = lazyWithRetry(() => import("./pages/AiPage.jsx"));
const ReportPage = lazyWithRetry(() => import("./pages/ReportPage.jsx"));
const DatabasePage = lazyWithRetry(() => import("./pages/DatabasePage.jsx"));

/**
 * FINPRIX route ownership (v0.20.0) — web-first, symbol-first:
 *   /                     global market command center (public, zero-setup)
 *   /markets              discovery hub
 *   /market/:symbol       asset overview (auto-acquires cached history)
 *   /analysis/:view       shared quant workspace (?symbol= or ?dataset=)
 *   /news                 news terminal
 *   /watchlists           user-managed lists (browser-local)
 *   /compare /ai /report  research surfaces
 *   /datasets /database   data management
 */
function LegacyAnalysisRedirect({ view }) {
  const [params] = useSearchParams();
  const dataset = params.get("dataset");
  const symbol = params.get("symbol");
  const query = [
    dataset ? `dataset=${dataset}` : null,
    symbol ? `symbol=${encodeURIComponent(symbol)}` : null,
  ]
    .filter(Boolean)
    .join("&");
  return <Navigate to={`/analysis/${view}${query ? `?${query}` : ""}`} replace />;
}

// Dataset-centric utility routes still show the dataset context bar.
const DATASET_ROUTES = ["/datasets", "/database", "/compare", "/ai", "/report"];

export default function App() {
  const { ready } = useAuth();
  const location = useLocation();
  const showContextBar = DATASET_ROUTES.some((r) =>
    location.pathname.startsWith(r),
  );

  if (!ready) {
    return (
      <div className="app-shell">
        <main className="main-content">
          <LoadingState label="OPENING FINPRIX" />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopNav />
      {showContextBar && <ContextBar />}
      <main className="main-content" id="main">
        <ErrorBoundary>
          <Suspense fallback={<LoadingState label="LOADING VIEW" />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/markets" element={<MarketsPage />} />
              <Route path="/market/:symbol" element={<AssetOverviewPage />} />
              <Route path="/news" element={<NewsTerminalPage />} />
              <Route path="/watchlists" element={<WatchlistsPage />} />
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
              {/* Pre-0.20 dataset-centric home keeps working. */}
              <Route path="/overview" element={<Navigate to="/" replace />} />

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
