import { AlertTriangle, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type CleanResult, cleanProject } from "../lib/api.js";
import { formatBytes } from "../lib/format.js";

interface CleanDialogProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onDone: () => void;
}

export function CleanDialog({
  projectId,
  projectName,
  onClose,
  onDone,
}: CleanDialogProps) {
  const [preview, setPreview] = useState<CleanResult | undefined>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CleanResult | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    cleanProject(projectId, true).then((data) => {
      if (cancelled) {
        return;
      }
      if (data) {
        setPreview(data);
      } else {
        setPreviewFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const ready =
    typed.trim() === "CLEAN" && !busy && !!preview && preview.total > 0;

  const runClean = async () => {
    setBusy(true);
    const data = await cleanProject(projectId, false);
    setBusy(false);
    setResult(
      data ?? {
        moved: 0,
        bytes: 0,
        total: 0,
        skipped: 0,
        errors: ["The clean request failed."],
      },
    );
    onDone();
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Clean ${projectName}`}
      >
        <div className="modal-head">
          <span className="modal-warn">
            <AlertTriangle size={18} />
          </span>
          <div className="modal-title">Clean {projectName}</div>
        </div>

        {result ? (
          <>
            <div className="modal-body">
              <p>
                Moved <strong>{result.moved}</strong> of {result.total}{" "}
                {result.total === 1 ? "file" : "files"} (
                {formatBytes(result.bytes)}) to your Mac's Trash.
                {result.errors.length > 0
                  ? ` ${result.errors.length} could not be moved.`
                  : ""}
              </p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-body">
              {previewFailed ? (
                <p>
                  Could not reach the local service to prepare this cleanup.
                </p>
              ) : !preview ? (
                <p>Checking which files belong to this project…</p>
              ) : preview.total === 0 ? (
                <p>
                  No files belong only to <strong>{projectName}</strong>.
                  {preview.skipped > 0
                    ? ` ${preview.skipped} shared with other projects are kept.`
                    : ""}
                </p>
              ) : (
                <p>
                  This moves <strong>{preview.total}</strong>{" "}
                  {preview.total === 1 ? "log file" : "log files"} (
                  {formatBytes(preview.bytes)}) belonging only to{" "}
                  <strong>{projectName}</strong> to your Mac's Trash. Its spend
                  and prompts disappear from Lens.
                  {preview.skipped > 0
                    ? ` ${preview.skipped} ${preview.skipped === 1 ? "file" : "files"} shared with other projects are kept.`
                    : ""}{" "}
                  Drag them back from Trash to restore.
                </p>
              )}
            </div>
            {preview && preview.total > 0 ? (
              <>
                <label className="modal-label" htmlFor="clean-confirm-input">
                  Type <strong>CLEAN</strong> to confirm
                </label>
                <input
                  id="clean-confirm-input"
                  ref={inputRef}
                  className="modal-input"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder="CLEAN"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={runClean}
                disabled={!ready}
              >
                <Trash2 size={14} />
                {busy ? "Working…" : "Move logs to Trash"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
