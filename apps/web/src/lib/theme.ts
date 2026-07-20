// Theme manager: "auto" follows prefers-color-scheme, "dark"/"light" are
// explicit. The choice persists in localStorage and is mirrored onto
// <html data-theme="…">, which the token system keys off. index.html runs a
// tiny bootstrap script with the same logic so the first paint never flashes
// the wrong theme.
export type ThemeChoice = "auto" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "ziplyne-theme";
const listeners = new Set<() => void>();

export function getThemeChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "dark" || raw === "light" || raw === "auto") {
      return raw;
    }
  } catch {
    // Private browsing etc. — fall through to the default.
  }
  return "auto";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice !== "auto") {
    return choice;
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function currentResolvedTheme(): ResolvedTheme {
  return resolveTheme(getThemeChoice());
}

export function applyTheme(): ResolvedTheme {
  const resolved = currentResolvedTheme();
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Persistence is best-effort; the theme still applies for the session.
  }
  applyTheme();
  for (const listener of listeners) {
    listener();
  }
}

// Toggles the explicit theme (used by the ⌘K palette): dark -> light -> dark,
// escaping "auto" to the opposite of whatever is currently shown.
export function toggleExplicitTheme(): ResolvedTheme {
  const next: ResolvedTheme =
    currentResolvedTheme() === "dark" ? "light" : "dark";
  setThemeChoice(next);
  return next;
}

// Subscribe to choice changes (from this tab) AND to OS-level scheme flips
// while in "auto". Returns an unsubscribe function.
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const onMedia = () => {
    if (getThemeChoice() === "auto") {
      applyTheme();
      listener();
    }
  };
  media.addEventListener("change", onMedia);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onMedia);
  };
}
