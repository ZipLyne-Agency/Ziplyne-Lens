interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}

// Switch control. A real <button> so it's keyboard-focusable; aria-pressed
// carries the state for assistive tech.
export function Toggle({ on, onChange, label, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={on ? "toggle on" : "toggle"}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}
