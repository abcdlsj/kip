/**
 * Quiet, adaptive terminal palette inspired by Kip's Alabaster (light) and
 * Obsidian (dark) design tokens. Keeps the terminal's native canvas transparent
 * and relies on typography, hairlines, and restrained warm-terracotta accents.
 */
import {
  getTerminalColorMode,
  rgbColor,
  styleText,
  type Color,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
  type TerminalColorMode,
  type TerminalColorScheme,
  type TerminalColors,
  type TextAttributes,
} from "@earendil-works/pi-tui";

export interface KipTuiTheme {
  scheme: TerminalColorScheme;
  mode: TerminalColorMode;
  text: (value: string) => string;
  bold: (value: string) => string;
  italic: (value: string) => string;
  dim: (value: string) => string;
  muted: (value: string) => string;
  faint: (value: string) => string;
  accent: (value: string) => string;
  accentBold: (value: string) => string;
  brand: (value: string) => string;
  ok: (value: string) => string;
  warn: (value: string) => string;
  err: (value: string) => string;
  errBold: (value: string) => string;
  diffAdd: (value: string) => string;
  diffDel: (value: string) => string;
  editor: EditorTheme;
  markdown: MarkdownTheme;
  selectList: SelectListTheme;
}

interface Palette {
  accent: Color;
  brand: Color;
  muted: Color;
  faint: Color;
  ok: Color;
  warn: Color;
  err: Color;
  code: Color;
}

const DARK_PALETTE: Palette = {
  accent: rgbColor(217, 119, 87), // --accent-action (#d97757)
  brand: rgbColor(143, 163, 191), // --accent-brand (#8fa3bf)
  muted: rgbColor(158, 156, 148), // --text-muted
  faint: rgbColor(84, 82, 78), // hairline
  ok: rgbColor(122, 185, 72), // --status-ok
  warn: rgbColor(209, 160, 65), // --status-warn
  err: rgbColor(238, 136, 132), // --status-err
  code: rgbColor(218, 214, 202),
};

const LIGHT_PALETTE: Palette = {
  accent: rgbColor(201, 100, 66), // --accent-action (#c96442)
  brand: rgbColor(79, 93, 117), // --accent-brand (#4f5d75)
  muted: rgbColor(101, 99, 92), // --text-muted
  faint: rgbColor(196, 194, 186), // hairline
  ok: rgbColor(45, 106, 79), // --status-ok
  warn: rgbColor(154, 91, 19), // --status-warn
  err: rgbColor(167, 61, 57), // --status-err
  code: rgbColor(54, 53, 49),
};

export function detectSchemeFromColors(
  colors: TerminalColors,
  fallback: TerminalColorScheme = "dark",
): TerminalColorScheme {
  const bg = colors.background;
  if (!bg) return fallback;
  // Relative sRGB luminance check (0..255 scale).
  const luminance = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b;
  return luminance > 140 ? "light" : "dark";
}

export function createKipTheme(
  scheme: TerminalColorScheme = "dark",
  mode: TerminalColorMode = getTerminalColorMode(),
): KipTuiTheme {
  const palette = scheme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  const paint = (fg?: Color, attrs: TextAttributes = {}) => {
    return (value: string) => styleText(value, { fg, ...attrs }, mode);
  };

  const text = (value: string) => value;
  const bold = paint(undefined, { bold: true });
  const italic = paint(undefined, { italic: true });
  const dim = paint(undefined, { dim: true });
  const muted = paint(palette.muted);
  const faint = paint(palette.faint);
  const accent = paint(palette.accent);
  const accentBold = paint(palette.accent, { bold: true });
  const brand = paint(palette.brand);
  const ok = paint(palette.ok);
  const warn = paint(palette.warn);
  const err = paint(palette.err);
  const errBold = paint(palette.err, { bold: true });
  const diffAdd = paint(palette.ok);
  const diffDel = paint(palette.err);
  const code = paint(palette.code);

  const selectList: SelectListTheme = {
    selectedPrefix: (value) => accentBold(value),
    selectedText: (value) => bold(value),
    description: (value) => muted(value),
    scrollInfo: (value) => muted(value),
    noMatch: (value) => muted(value),
  };

  const editor: EditorTheme = {
    borderColor: (value) => faint(value),
    selectList,
  };

  const markdown: MarkdownTheme = {
    heading: (value) => bold(value),
    link: (value) => paint(palette.brand, { underline: true })(value),
    linkUrl: (value) => muted(value),
    code: (value) => brand(value),
    codeBlock: (value) => code(value),
    codeBlockBorder: (value) => faint(value),
    quote: (value) => paint(palette.muted, { italic: true })(value),
    quoteBorder: (value) => faint(value),
    hr: (value) => faint(value),
    listBullet: (value) => muted(value),
    bold: (value) => bold(value),
    italic: (value) => italic(value),
    strikethrough: (value) => paint(undefined, { strikethrough: true })(value),
    underline: (value) => paint(undefined, { underline: true })(value),
    codeBlockIndent: "  ",
  };

  return {
    scheme,
    mode,
    text,
    bold,
    italic,
    dim,
    muted,
    faint,
    accent,
    accentBold,
    brand,
    ok,
    warn,
    err,
    errBold,
    diffAdd,
    diffDel,
    editor,
    markdown,
    selectList,
  };
}
