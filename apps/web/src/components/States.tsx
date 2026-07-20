import { AlertTriangle, Inbox } from "lucide-react";
import type { ReactNode } from "react";

// Loading placeholder block. Width/height via style; shimmer comes from the
// .skeleton class. No spinners anywhere in the app.
export function Skeleton({
  width,
  height = 12,
  radius,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden="true"
      className="skeleton"
      style={{
        width,
        height,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

export function EmptyState({
  icon,
  title,
  tone,
  children,
}: {
  icon?: ReactNode;
  title: string;
  /** "ok" tints the icon green (calm/all-clear states). */
  tone?: "ok";
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className={tone === "ok" ? "empty-icon ok" : "empty-icon"}>
        {icon ?? <Inbox size={18} />}
      </div>
      <div className="empty-title">{title}</div>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function ErrorBanner({
  message,
  onRetry,
  retryLabel = "Retry",
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="banner error" role="alert">
      <AlertTriangle size={15} />
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="btn sm" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
