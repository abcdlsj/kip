/**
 * Reliable clipboard write across WebKit, CEF, and WebView2.
 * `views://` is not treated as a secure context on every renderer, so we fall
 * back to an offscreen textarea when `navigator.clipboard.writeText` rejects.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
