import { useState } from "react";
import { downloadCsv, downloadNodeAsPng } from "../../lib/export.js";

export function ExportCsvButton({ filename, columns, rows, label = "Export CSV", disabled }) {
  return (
    <button
      type="button"
      className="btn print-hidden"
      disabled={disabled || !rows || rows.length === 0}
      onClick={() => downloadCsv(filename, columns, rows)}
    >
      {label}
    </button>
  );
}

export function ExportPngButton({ targetRef, filename, label = "Export PNG" }) {
  const [busy, setBusy] = useState(false);

  const handle = async () => {
    if (!targetRef?.current) return;
    setBusy(true);
    try {
      await downloadNodeAsPng(targetRef.current, filename);
    } catch {
      /* warning surfaced via console; button re-enables */
    } finally {
      window.setTimeout(() => setBusy(false), 400);
    }
  };

  return (
    <button
      type="button"
      className="btn print-hidden"
      onClick={handle}
      disabled={busy}
    >
      {busy ? "Rendering…" : label}
    </button>
  );
}
