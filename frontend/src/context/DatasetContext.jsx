import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { getDatasets, ApiError } from "../api/client.js";

const STORAGE_KEY = "market-dna.active-dataset-id";
const RECENTS_KEY = "market-dna.recent-analyses";
const RECENTS_LIMIT = 6;

function loadRecents() {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, RECENTS_LIMIT) : [];
  } catch {
    return [];
  }
}

const DatasetContext = createContext(null);

export function DatasetProvider({ children }) {
  const [datasets, setDatasets] = useState([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [datasetsError, setDatasetsError] = useState(null);
  const [activeId, setActiveIdState] = useState(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  });

  const refreshDatasets = useCallback(async () => {
    setDatasetsLoading(true);
    try {
      const payload = await getDatasets();
      const list = Array.isArray(payload?.datasets) ? payload.datasets : [];
      setDatasets(list);
      setDatasetsError(null);
      return list;
    } catch (error) {
      setDatasetsError(
        error instanceof ApiError
          ? error.message
          : "Failed to load datasets from the backend.",
      );
      return [];
    } finally {
      setDatasetsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshDatasets();
  }, [refreshDatasets]);

  // Deep link: /fingerprint?dataset=123 selects that dataset once the
  // library has loaded (used by the Markets page and shareable links).
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const requested = Number(searchParams.get("dataset"));
    if (!Number.isFinite(requested) || requested <= 0) return;
    if (datasetsLoading || datasetsError) return;
    if (datasets.some((d) => d.id === requested)) {
      setActiveIdState((prev) => (prev === requested ? prev : requested));
    }
  }, [searchParams, datasets, datasetsLoading, datasetsError]);

  const [recents, setRecents] = useState(loadRecents);

  // Track recently analyzed datasets for the Overview command center.
  useEffect(() => {
    if (activeId === null) return;
    setRecents((prev) => {
      const next = [
        { id: activeId, ts: Date.now() },
        ...prev.filter((r) => r.id !== activeId),
      ].slice(0, RECENTS_LIMIT);
      try {
        window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        /* storage full/blocked — recents are best-effort */
      }
      return next;
    });
  }, [activeId]);

  useEffect(() => {
    if (activeId === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, String(activeId));
    }
  }, [activeId]);

  useEffect(() => {
    if (activeId !== null && !datasetsLoading && !datasetsError) {
      if (datasets.length === 0) {
        setActiveIdState(null);
      } else if (!datasets.some((d) => d.id === activeId)) {
        setActiveIdState(datasets[0].id);
      }
    }
  }, [datasets, datasetsLoading, datasetsError, activeId]);

  const selectDataset = useCallback((id) => {
    setActiveIdState(id === null ? null : Number(id));
  }, []);

  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === activeId) || null,
    [datasets, activeId],
  );

  const recentAnalyses = useMemo(
    () =>
      recents
        .map((r) => ({
          ...r,
          dataset: datasets.find((d) => d.id === r.id) || null,
        }))
        .filter((r) => r.dataset),
    [recents, datasets],
  );

  const value = useMemo(
    () => ({
      datasets,
      datasetsLoading,
      datasetsError,
      refreshDatasets,
      activeId,
      activeDataset,
      selectDataset,
      recentAnalyses,
    }),
    [
      datasets,
      datasetsLoading,
      datasetsError,
      refreshDatasets,
      activeId,
      activeDataset,
      selectDataset,
      recentAnalyses,
    ],
  );

  return (
    <DatasetContext.Provider value={value}>{children}</DatasetContext.Provider>
  );
}

export function useDatasets() {
  const context = useContext(DatasetContext);
  if (!context) {
    throw new Error("useDatasets must be used within a DatasetProvider");
  }
  return context;
}
