import { useState } from "react";
import {
  createPreset,
  deletePreset,
  updatePreset,
} from "../../api/client.js";
import Modal, { ConfirmDialog } from "../Modal.jsx";
import { EmptyState, ErrorState, LoadingState } from "../states/States.jsx";
import { SectionPanel } from "../ui/Ui.jsx";
import { useApiData, invalidateCache } from "../../hooks/useApiData.js";

export default function PresetManager({ selection, datasets, onLoadSelection }) {
  const presetsQuery = useApiData("/comparison-presets");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const presets = presetsQuery.data?.presets ?? [];

  const runMutation = async (action) => {
    setBusy(true);
    try {
      await action();
      invalidateCache("/comparison-presets");
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (!saveName.trim()) return;
    const ok = await runMutation(() =>
      createPreset({ name: saveName.trim(), datasetIds: selection }),
    );
    if (ok) {
      setNotice(`Saved preset "${saveName.trim()}".`);
      setSaveOpen(false);
      setSaveName("");
    } else {
      setNotice("Could not save the preset. Is the backend running?");
    }
  };

  const handleLoad = (preset) => {
    const validIds = preset.dataset_ids.filter((id) =>
      datasets.some((dataset) => dataset.id === id),
    );
    const dropped = preset.dataset_ids.filter((id) => !validIds.includes(id));
    if (validIds.length < 2) {
      setNotice(
        `Cannot load "${preset.name}": fewer than two of its datasets still exist` +
          (dropped.length ? ` (deleted: #${dropped.join(", #")})` : "") +
          ".",
      );
      return;
    }
    onLoadSelection(validIds);
    setNotice(
      `Loaded "${preset.name}".` +
        (dropped.length
          ? ` Skipped deleted datasets: #${dropped.join(", #")}.`
          : ""),
    );
  };

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    const ok = await runMutation(() =>
      updatePreset(renameTarget.id, { name: renameValue.trim() }),
    );
    setNotice(ok ? `Renamed to "${renameValue.trim()}".` : "Rename failed.");
    setRenameTarget(null);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await runMutation(() => deletePreset(deleteTarget.id));
    setNotice(`Deleted preset "${deleteTarget.name}".`);
    setDeleteTarget(null);
  };

  return (
    <SectionPanel
      title="Saved Presets"
      subtitle="Store dataset selections to reuse later. Presets are local to this installation."
    >
      <div className="control-row">
        <button
          type="button"
          className="btn"
          disabled={selection.length < 2 || busy}
          onClick={() => setSaveOpen(true)}
        >
          Save current selection ({selection.length})
        </button>
      </div>

      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      {presetsQuery.error ? (
        <ErrorState message={presetsQuery.error.message} status={presetsQuery.error.status} />
      ) : presetsQuery.loading && presets.length === 0 ? (
        <LoadingState label="LOADING PRESETS" />
      ) : presets.length === 0 ? (
        <EmptyState
          title="NO SAVED PRESETS"
          hint="Select two or more datasets and save them as a preset."
        />
      ) : (
        <ul className="preset-list">
          {presets.map((preset) => (
            <li key={preset.id} className="preset-item">
              <div className="preset-meta">
                <span className="preset-name">{preset.name}</span>
                <span className="mono muted small">
                  #{preset.dataset_ids.join(", #")}
                </span>
              </div>
              <div className="control-row">
                <button type="button" className="btn" onClick={() => handleLoad(preset)}>
                  Load
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setRenameTarget(preset);
                    setRenameValue(preset.name);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setDeleteTarget(preset)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={saveOpen} title="SAVE PRESET" onClose={() => setSaveOpen(false)}>
        <label className="control stacked">
          <span>Preset name</span>
          <input
            value={saveName}
            autoFocus
            maxLength={120}
            placeholder="e.g. Tech vs bonds vs gold"
            onChange={(event) => setSaveName(event.target.value)}
          />
        </label>
        <p className="muted small mono">
          Datasets: #{selection.join(", #")}
        </p>
        <div className="control-row modal-actions">
          <button type="button" className="btn" disabled={busy || !saveName.trim()} onClick={handleSave}>
            Save
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setSaveOpen(false)}>
            Cancel
          </button>
        </div>
      </Modal>

      <Modal
        open={Boolean(renameTarget)}
        title="RENAME PRESET"
        onClose={() => setRenameTarget(null)}
      >
        <label className="control stacked">
          <span>New name</span>
          <input
            value={renameValue}
            autoFocus
            maxLength={120}
            onChange={(event) => setRenameValue(event.target.value)}
          />
        </label>
        <div className="control-row modal-actions">
          <button type="button" className="btn" disabled={busy || !renameValue.trim()} onClick={handleRename}>
            Rename
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setRenameTarget(null)}>
            Cancel
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete "${deleteTarget?.name ?? ""}"?`}
        message="This removes the saved preset permanently. Datasets are not affected."
        confirmLabel="Delete"
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </SectionPanel>
  );
}
