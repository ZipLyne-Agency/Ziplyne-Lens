import type { LucideIcon } from "lucide-react";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteAction {
  id: string;
  section: "Workspaces" | "Projects" | "Actions";
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}

// Subsequence match with a small bonus for consecutive and word-start hits.
// Returns -1 when the query doesn't match at all.
function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) {
    return 0;
  }
  const t = text.toLowerCase();
  let score = 0;
  let qi = 0;
  let lastMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      const consecutive = ti === lastMatch + 1;
      const wordStart = ti === 0 || t[ti - 1] === " ";
      score += 1 + (consecutive ? 2 : 0) + (wordStart ? 2 : 0);
      lastMatch = ti;
      qi += 1;
    }
  }
  return qi === q.length ? score : -1;
}

const SECTION_ORDER: Array<PaletteAction["section"]> = [
  "Workspaces",
  "Projects",
  "Actions",
];

export function CommandPalette({
  open,
  onClose,
  actions,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const grouped = useMemo(() => {
    const scored = actions
      .map((action) => ({ action, score: fuzzyScore(query, action.label) }))
      .filter((entry) => entry.score >= 0);
    scored.sort((a, b) => b.score - a.score);
    const sections: Array<{
      name: PaletteAction["section"];
      items: PaletteAction[];
    }> = [];
    for (const name of SECTION_ORDER) {
      const items = scored
        .filter((entry) => entry.action.section === name)
        .map((entry) => entry.action);
      if (items.length > 0) {
        sections.push({ name, items });
      }
    }
    return sections;
  }, [actions, query]);

  const flat = useMemo(
    () => grouped.flatMap((section) => section.items),
    [grouped],
  );

  // Keep the active row valid as the result set changes.
  useEffect(() => {
    setActiveIndex((index) =>
      flat.length === 0 ? 0 : Math.min(index, flat.length - 1),
    );
  }, [flat.length]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const runAction = (action: PaletteAction | undefined) => {
    if (!action) {
      return;
    }
    onClose();
    action.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, flat.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAction(flat[activeIndex]);
    }
  };

  if (!open) {
    return null;
  }

  let rowIndex = -1;

  return (
    <div className="palette-overlay">
      <button
        type="button"
        className="palette-backdrop"
        aria-label="Close command palette"
        onClick={onClose}
      />
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="palette-input-row">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a screen, project, or action…"
            aria-label="Command palette search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={`palette-option-${activeIndex}`}
          />
        </div>
        <div
          className="palette-list"
          id="palette-list"
          role="listbox"
          ref={listRef}
        >
          {flat.length === 0 ? (
            <div className="palette-empty">No matches for “{query}”.</div>
          ) : (
            grouped.map((section) => (
              <div key={section.name}>
                <div className="palette-section">{section.name}</div>
                {section.items.map((action) => {
                  rowIndex += 1;
                  const index = rowIndex;
                  const isActive = index === activeIndex;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      id={`palette-option-${index}`}
                      data-index={index}
                      role="option"
                      aria-selected={isActive}
                      className={
                        isActive ? "palette-item active" : "palette-item"
                      }
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => runAction(action)}
                    >
                      <span className="palette-item-icon">
                        <action.icon size={14} />
                      </span>
                      <span>{action.label}</span>
                      {action.hint ? (
                        <span className="palette-item-meta">{action.hint}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span>
            <span className="kbd">↑↓</span>navigate
          </span>
          <span>
            <span className="kbd">↵</span>open
          </span>
          <span>
            <span className="kbd">esc</span>close
          </span>
          <span>
            <span className="kbd">⌘1–5</span>workspaces
          </span>
        </div>
      </div>
    </div>
  );
}
