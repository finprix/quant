import { useEffect, useRef } from "react";
import "./Modal.css";

export default function Modal({ open, title, children, onClose }) {
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <p className="modal-title">{title}</p>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel, onConfirm, onCancel, busy }) {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <p className="modal-message">{message}</p>
      <div className="modal-actions">
        <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : confirmLabel || "Confirm"}
        </button>
      </div>
    </Modal>
  );
}
