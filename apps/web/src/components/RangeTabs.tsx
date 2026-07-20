import type { RangePreset } from "../lib/api.js";

const OPTIONS: Array<{ id: RangePreset; label: string }> = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "This month" },
  { id: "all", label: "All time" },
];

interface RangeTabsProps {
  range: RangePreset;
  onChange: (range: RangePreset) => void;
}

export function RangeTabs({ range, onChange }: RangeTabsProps) {
  return (
    <div className="segmented">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={option.id === range ? "active" : ""}
          aria-pressed={option.id === range}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
