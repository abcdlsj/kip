export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="8" fill="var(--accent-ink)" />
      <path
        d="M16 8.5L23.5 16L16 23.5L8.5 16Z"
        fill="none"
        stroke="var(--accent-ink-fg)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M16 13L19 16L16 19L13 16Z" fill="var(--accent-ink-fg)" />
    </svg>
  );
}
