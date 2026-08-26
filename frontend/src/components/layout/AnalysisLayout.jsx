import { NavLink, Outlet } from "react-router-dom";
import { useDatasets } from "../../context/DatasetContext.jsx";
import { ANALYSIS_VIEWS, analysisPath } from "../../lib/navigation.js";
import AssetContextBar from "./AssetContextBar.jsx";

/**
 * Shared analysis workspace shell (v0.19.0).
 *
 * Fingerprint / Analogues / Regimes / Intelligence / Heatmaps are tabs of
 * ONE workspace, not five unrelated pages. The shell owns asset context
 * (symbol/dataset/live quote) and tab navigation; the active dataset id
 * rides along in every tab link so ?dataset= deep links keep working.
 */
export default function AnalysisLayout() {
  const { activeId } = useDatasets();

  return (
    <div className="page analysis-shell">
      <AssetContextBar />

      <nav className="analysis-tabs" aria-label="Analysis views">
        {ANALYSIS_VIEWS.map((view) => (
          <NavLink
            key={view.key}
            to={analysisPath(view.key, activeId)}
            className={({ isActive }) =>
              `analysis-tab${isActive ? " active" : ""}`
            }
          >
            {view.label}
          </NavLink>
        ))}
      </nav>

      <div className="analysis-content">
        <Outlet />
      </div>
    </div>
  );
}
