import type { PromptLibrary, PromptLibraryRecord } from "@ziplyne/core/browser";
import { Lock, Search, Shield, X } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, Skeleton } from "../components/States.js";
import { Panel, WorkspaceHeader } from "../components/Workspace.js";
import type { SourceFilter } from "../lib/api.js";
import {
  agentLabel,
  formatNumber,
  modelLabel,
  relativeTime,
  sourceAccent,
  sourceLabel,
} from "../lib/format.js";

interface LibraryProps {
  library: PromptLibrary | undefined;
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  source: SourceFilter;
  onSourceChange: (source: SourceFilter) => void;
  /** Project preselect (jumped in from Projects); undefined = all projects. */
  clientId: string | undefined;
  clientName: string | undefined;
  onClearClient: () => void;
  includeContent: boolean;
  onIncludeContentChange: (value: boolean) => void;
}

const PRIVACY_LABEL: Record<string, string> = {
  plain: "Visible",
  redacted: "Redacted",
  encrypted: "Encrypted",
  "metadata-only": "Metadata only",
};

const AGENT_FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: "all", label: "All agents" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "kimi", label: "Kimi" },
  { id: "grok", label: "Grok" },
];

export function Library({
  library,
  loading,
  search,
  onSearchChange,
  source,
  onSourceChange,
  clientId,
  clientName,
  onClearClient,
  includeContent,
  onIncludeContentChange,
}: LibraryProps) {
  const prompts = library?.prompts ?? [];
  const [selectedId, setSelectedId] = useState<string | undefined>(
    prompts[0]?.id,
  );

  // Keep a valid selection as the list changes (search, refresh, filters).
  useEffect(() => {
    const first = prompts[0];
    if (!first) {
      setSelectedId(undefined);
    } else if (!prompts.some((prompt) => prompt.id === selectedId)) {
      setSelectedId(first.id);
    }
  }, [prompts, selectedId]);

  const selected =
    prompts.find((prompt) => prompt.id === selectedId) ?? prompts[0];

  return (
    <div className="workspace">
      <WorkspaceHeader
        title="Library"
        subtitle="Every prompt indexed on this Mac — secrets are stripped before anything is stored"
      >
        {clientId ? (
          <span className="filter-chip" title="Filtering to one project">
            {clientName ?? clientId}
            <button
              type="button"
              onClick={onClearClient}
              aria-label="Clear project filter"
            >
              <X size={10} />
            </button>
          </span>
        ) : null}
        <div className="search-box" style={{ width: 200 }}>
          <Search size={13} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search prompts…"
            aria-label="Search prompts"
          />
        </div>
        {AGENT_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={source === filter.id ? "chip active" : "chip"}
            aria-pressed={source === filter.id}
            onClick={() => onSourceChange(filter.id)}
          >
            {filter.id !== "all" ? (
              <span
                className="dot"
                style={{
                  background: sourceAccent(filter.id),
                  width: 6,
                  height: 6,
                }}
              />
            ) : null}
            {filter.id === "all" ? "All" : agentLabel(filter.id)}
          </button>
        ))}
        <button
          type="button"
          className={includeContent ? "btn primary" : "btn"}
          aria-pressed={includeContent}
          onClick={() => onIncludeContentChange(!includeContent)}
        >
          {includeContent ? "Full text on" : "Show full text"}
        </button>
      </WorkspaceHeader>

      <div className="content library-grid">
        <Panel label="Prompts" count={prompts.length}>
          {loading && prompts.length === 0 ? (
            <div style={{ padding: 8 }}>
              {["a", "b", "c", "d", "e"].map((key) => (
                <div key={key} style={{ padding: "10px 4px" }}>
                  <Skeleton width="70%" height={12} />
                  <Skeleton width="40%" height={10} style={{ marginTop: 7 }} />
                </div>
              ))}
            </div>
          ) : prompts.length === 0 ? (
            <EmptyState icon={<Search size={18} />} title="No prompts found">
              {search
                ? "No prompts match your search."
                : "No prompts indexed yet."}
            </EmptyState>
          ) : (
            prompts.map((prompt) => (
              <button
                key={prompt.id}
                className={
                  selected && prompt.id === selected.id ? "row selected" : "row"
                }
                style={{
                  alignItems: "flex-start",
                  paddingTop: 8,
                  paddingBottom: 8,
                }}
                onClick={() => setSelectedId(prompt.id)}
                type="button"
              >
                <span
                  className="dot"
                  style={{
                    background: sourceAccent(prompt.source),
                    marginTop: 5,
                  }}
                />
                <div className="row-main" style={{ gap: 3 }}>
                  <span className="lib-title">{promptTitle(prompt)}</span>
                  <span className="row-meta">
                    {projectName(prompt)} ·{" "}
                    <span className="tnum">
                      {relativeTime(prompt.timestamp)}
                    </span>
                  </span>
                </div>
                <span className="row-side" style={{ marginTop: 2 }}>
                  {formatNumber(prompt.estimatedTokens)} tok
                </span>
              </button>
            ))
          )}
        </Panel>

        {selected ? (
          <Panel label="Reading" flush>
            <Reader prompt={selected} />
          </Panel>
        ) : (
          <Panel label="Reading">
            <div className="center-muted">Select a prompt to read it.</div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function Reader({ prompt }: { prompt: PromptLibraryRecord }) {
  const encrypted = prompt.privacy === "encrypted";
  return (
    <div className="reader">
      <div className="reader-chips">
        <span className={encrypted ? "tag warn" : "tag ok"}>
          {encrypted ? <Lock size={11} /> : <Shield size={11} />}
          {PRIVACY_LABEL[prompt.privacy] ?? prompt.privacy}
        </span>
        {prompt.model ? (
          <span className="tag info">{modelLabel(prompt.model)}</span>
        ) : null}
        <span className="tag">{projectName(prompt)}</span>
        <span className="tag">{sourceLabel(prompt.source)}</span>
      </div>

      <div>
        <div className="reader-title">{promptTitle(prompt)}</div>
        <div className="reader-sub tnum">{relativeTime(prompt.timestamp)}</div>
      </div>

      <div
        className="stat-strip"
        style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
      >
        <div className="stat-box">
          <div className="stat-k">Tokens</div>
          <div className="stat-v tnum">
            {formatNumber(prompt.estimatedTokens)}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-k">Characters</div>
          <div className="stat-v tnum">
            {formatNumber(prompt.contentLength)}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-k">Repository</div>
          <div className="stat-v" title={prompt.projectKey}>
            {prompt.projectKey}
          </div>
        </div>
      </div>

      <div className={prompt.content ? "reader-body" : "reader-body mono"}>
        {encrypted
          ? "This prompt is encrypted. Lens stored only its metadata, never the text."
          : (prompt.content ?? prompt.preview)}
      </div>

      {prompt.tags.length > 0 ? (
        <div className="reader-chips">
          {prompt.tags.map((tag) => (
            <span className="tag" key={tag}>
              #{tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function promptTitle(prompt: PromptLibraryRecord): string {
  const text = prompt.preview.trim();
  if (!text || prompt.privacy === "encrypted") {
    return "Encrypted prompt";
  }
  const firstLine = text.split("\n")[0] ?? text;
  return firstLine.length > 88 ? `${firstLine.slice(0, 88)}…` : firstLine;
}

function projectName(prompt: PromptLibraryRecord): string {
  return prompt.clientId === "unassigned" ? "Unassigned" : prompt.clientName;
}
