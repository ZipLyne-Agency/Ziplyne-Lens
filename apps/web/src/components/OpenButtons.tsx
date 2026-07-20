import { Code, Github } from "lucide-react";
import { useState } from "react";
import { openTarget } from "../lib/api.js";

// One-click openers for a project: the repo on GitHub (when a URL exists)
// and the local path in Zed (primary brand button). Self-contained
// pending/error state — a failed open surfaces as inline text.
export function OpenButtons({
  path,
  url,
  name,
}: {
  path: string;
  url?: string;
  name: string;
}) {
  const [pending, setPending] = useState<"zed" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (kind: "zed" | "github") => {
    if (pending) {
      return;
    }
    setPending(kind);
    setError(null);
    const result =
      kind === "zed"
        ? await openTarget({ path })
        : await openTarget({ url: url ?? "" });
    setPending(null);
    if (!result.ok) {
      setError(result.error ?? "Open failed");
    }
  };

  return (
    <span className="open-buttons">
      {url ? (
        <button
          type="button"
          className="btn"
          onClick={() => void open("github")}
          disabled={pending !== null}
          aria-label={`Open ${name} on GitHub`}
          title={pending === "github" ? "Opening…" : "Open on GitHub"}
        >
          <Github size={14} />
          GitHub
        </button>
      ) : null}
      <button
        type="button"
        className="btn primary"
        onClick={() => void open("zed")}
        disabled={pending !== null}
        aria-label={`Open ${name} in Zed`}
        title={pending === "zed" ? "Opening…" : "Open in Zed"}
      >
        <Code size={14} />
        Open in Zed
      </button>
      {error ? (
        <span className="open-error" role="status" title={error}>
          Couldn't open
        </span>
      ) : null}
    </span>
  );
}
