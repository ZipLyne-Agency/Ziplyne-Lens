import type { ReactNode } from "react";

// 52px workspace header: 17px semibold title + 12px subtitle on the left,
// the view's primary actions/filters on the right.
export function WorkspaceHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <header className="wheader">
      <div className="wheader-titles">
        <h1 className="wheader-title">{title}</h1>
        {subtitle ? <p className="wheader-sub">{subtitle}</p> : null}
      </div>
      {children ? <div className="wheader-actions">{children}</div> : null}
    </header>
  );
}

// Content-grid panel: 32px header row (11px uppercase label + optional
// action) over a body that scrolls internally when it holds a list.
export function Panel({
  label,
  count,
  action,
  attention,
  flush,
  pad,
  className,
  children,
}: {
  label: ReactNode;
  count?: number;
  action?: ReactNode;
  attention?: boolean;
  /** Body never scrolls; it fills and sizes to the panel. */
  flush?: boolean;
  /** Body gets 12px padding. */
  pad?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = ["panel", attention ? "attention" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const bodyClasses = ["panel-body", flush ? "flush" : "", pad ? "pad" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <section className={classes}>
      <div className="panel-head">
        <span>{label}</span>
        {count !== undefined ? (
          <span className="panel-count tnum">{count}</span>
        ) : null}
        {action ? <div className="panel-action">{action}</div> : null}
      </div>
      <div className={bodyClasses}>{children}</div>
    </section>
  );
}
