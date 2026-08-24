import { useLocation } from "react-router-dom";
import { useDatasets } from "../context/DatasetContext.jsx";
import { EmptyState } from "./states/States.jsx";

const PAGE_HINTS = {
  "/fingerprint": "Upload and select a dataset to inspect its statistical fingerprint.",
  "/analogues": "Upload and select a dataset to search for historical analogues.",
  "/regimes": "Upload and select a dataset to run regime discovery.",
  "/intelligence": "Upload and select a dataset to compute market intelligence.",
};

export default function NoDatasetGuard({ children }) {
  const { activeId, datasetsLoading } = useDatasets();
  const location = useLocation();

  if (activeId !== null) return children;
  if (datasetsLoading) return null;

  return (
    <EmptyState
      title="NO ACTIVE DATASET"
      hint={
        PAGE_HINTS[location.pathname] ||
        "Upload an OHLCV CSV on the Datasets page, then select it in the top bar."
      }
    />
  );
}
