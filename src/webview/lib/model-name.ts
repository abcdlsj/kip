/** UI-side model label formatting. */
export function displayModelName(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
