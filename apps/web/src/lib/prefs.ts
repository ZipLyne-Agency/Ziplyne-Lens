// User preferences persisted in localStorage. Transcript reading is opt-in
// because it lifts the last lines of Terminal.app tabs via AppleScript.
const TRANSCRIPTS_KEY = "ziplyne-live-transcripts";

export function readTranscriptOptIn(): boolean {
  try {
    return localStorage.getItem(TRANSCRIPTS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeTranscriptOptIn(value: boolean): void {
  try {
    localStorage.setItem(TRANSCRIPTS_KEY, value ? "1" : "0");
  } catch {
    // Best effort; the toggle still applies for this session.
  }
}
