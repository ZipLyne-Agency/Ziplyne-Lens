// xbar/severity semantics shared by the Limits screen: Anthropic's usage
// endpoint reports "normal" | "warning" | "critical".
export type Severity = "normal" | "warning" | "critical" | string;

export function severityClass(severity: Severity): "ok" | "warn" | "bad" {
  if (severity === "critical") {
    return "bad";
  }
  if (severity === "warning") {
    return "warn";
  }
  return "ok";
}

interface ProgressBarProps {
  percent: number;
  severity: Severity;
}

export function ProgressBar({ percent, severity }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = severityClass(severity);
  return (
    <div
      className={`progress ${tone}`}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${Math.max(1.5, clamped)}%` }} />
    </div>
  );
}
