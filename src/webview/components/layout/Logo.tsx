import { APERTURE_PATH, SQUIRCLE_PATH } from "./logoPaths";

// Same geometry as the 16/32 px app icon, cropped to the squircle body.
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="100 100 824 824"
      aria-hidden="true"
    >
      <path d={SQUIRCLE_PATH} fill="var(--accent-ink)" />
      <path d={APERTURE_PATH} fill="var(--accent-ink-fg)" fillRule="evenodd" />
    </svg>
  );
}
