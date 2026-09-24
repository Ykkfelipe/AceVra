/** Lightweight circular usage indicator shared by the composer and account quota cards. */
export function UsageRing({
  percent,
  className = "size-3.5",
}: {
  /** Fraction of the ring shown as filled, clamped to [0, 1]. */
  percent: number;
  className?: string;
}) {
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const boundedPercent = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 1) : 0;
  const dashOffset = circumference * (1 - boundedPercent);

  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      viewBox="0 0 24 24"
      style={{ color: "currentcolor" }}
    >
      <circle
        cx={12}
        cy={12}
        fill="none"
        opacity="0.25"
        r={radius}
        stroke="currentColor"
        strokeWidth={4}
      />
      <circle
        cx={12}
        cy={12}
        fill="none"
        opacity="0.7"
        r={radius}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={4}
        style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
      />
    </svg>
  );
}
