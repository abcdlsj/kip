/** Small formatting helpers shared by the interface. */
export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function groupThreads<T extends { updatedAt: number }>(
  threads: T[],
): Array<{ label: string; items: T[] }> {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const weekAgo = startOfToday - 7 * 24 * 60 * 60 * 1000;
  const today: T[] = [];
  const week: T[] = [];
  const older: T[] = [];
  for (const thread of threads) {
    if (thread.updatedAt >= startOfToday) today.push(thread);
    else if (thread.updatedAt >= weekAgo) week.push(thread);
    else older.push(thread);
  }
  return [
    { label: "Today", items: today },
    { label: "Previous 7 Days", items: week },
    { label: "Older", items: older },
  ].filter((group) => group.items.length > 0);
}

export function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still awake.";
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

export function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.split("/").pop() ?? path;
}

/** Shortens `/Users/name/...`, `/home/name/...`, or `C:\Users\name\...` to `~/...`. */
export function compactHomePath(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}
