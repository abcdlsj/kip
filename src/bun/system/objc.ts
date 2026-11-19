/**
 * Minimal Objective-C bridge for window tweaks Electrobun does not expose.
 * App code runs in a Bun worker while AppKit lives on the main thread, so
 * properties are applied with one KVC call performed on the main thread.
 *
 * Object pointers travel as u64 BigInts: tagged pointers (small NSNumbers,
 * short NSStrings) use the high bits and do not fit in a JS number.
 */
import { dlopen, FFIType } from "bun:ffi";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";
type Id = bigint;
type Signature = { args: FFIType[]; returns: FFIType };
type MsgSend = (...args: unknown[]) => unknown;

const runtime =
  process.platform === "darwin"
    ? dlopen(LIBOBJC, {
        objc_getClass: { args: [FFIType.cstring], returns: FFIType.u64 },
        sel_registerName: { args: [FFIType.cstring], returns: FFIType.u64 },
        objc_autoreleasePoolPush: { args: [], returns: FFIType.u64 },
        objc_autoreleasePoolPop: { args: [FFIType.u64], returns: FFIType.void },
      }).symbols
    : null;

// objc_msgSend must be called through a prototype that matches the method.
const senders = new Map<string, MsgSend>();
function msgSend(signature: Signature): MsgSend {
  const key = `${signature.args.join(",")}->${signature.returns}`;
  let sender = senders.get(key);
  if (!sender) {
    sender = dlopen(LIBOBJC, { objc_msgSend: signature }).symbols.objc_msgSend as MsgSend;
    senders.set(key, sender);
  }
  return sender;
}

const U = FFIType.u64;

function toId(value: unknown): Id {
  return typeof value === "bigint" ? value : BigInt(Number(value ?? 0));
}

function cstr(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf8");
}

function sel(name: string): Id {
  return toId(runtime!.sel_registerName(cstr(name)));
}

function cls(name: string): Id {
  return toId(runtime!.objc_getClass(cstr(name)));
}

function send(target: Id, selector: string, ...args: Id[]): Id {
  const sender = msgSend({ args: [U, U, ...args.map(() => U)], returns: U });
  return toId(sender(target, sel(selector), ...args));
}

function nsString(value: string): Id {
  const sender = msgSend({ args: [U, U, FFIType.cstring], returns: U });
  return toId(sender(cls("NSString"), sel("stringWithUTF8String:"), cstr(value)));
}

function nsNumber(value: number): Id {
  const sender = msgSend({ args: [U, U, FFIType.i64], returns: U });
  return toId(sender(cls("NSNumber"), sel("numberWithLongLong:"), BigInt(Math.trunc(value))));
}

/** True when the pointer is an NSWindow (or subclass) instance. */
export function isNSWindow(window: unknown): boolean {
  if (!runtime || !window) return false;
  const nsWindow = cls("NSWindow");
  if (!nsWindow) return false;
  const sender = msgSend({ args: [U, U, U], returns: FFIType.bool });
  return Boolean(sender(toId(window), sel("isKindOfClass:"), nsWindow));
}

/**
 * Sets scalar properties on an AppKit object from the main thread and waits
 * for it, e.g. `{ level: 25, hasShadow: 0 }`. Keys must be KVC-compliant.
 */
export function setPropertiesOnMainThread(target: unknown, values: Record<string, number>): void {
  if (!runtime || !target) return;
  const pool = runtime.objc_autoreleasePoolPush();
  try {
    const dictionary = send(cls("NSMutableDictionary"), "dictionary");
    for (const [key, value] of Object.entries(values)) {
      send(dictionary, "setObject:forKey:", nsNumber(value), nsString(key));
    }
    const sender = msgSend({ args: [U, U, U, U, FFIType.bool], returns: FFIType.void });
    sender(
      toId(target),
      sel("performSelectorOnMainThread:withObject:waitUntilDone:"),
      sel("setValuesForKeysWithDictionary:"),
      dictionary,
      true,
    );
  } finally {
    runtime.objc_autoreleasePoolPop(pool);
  }
}

export interface AppKitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenNotchInfo {
  frame: AppKitRect;
  visibleFrame: AppKitRect;
  safeAreaTop: number;
  auxLeft: AppKitRect | null;
  auxRight: AppKitRect | null;
}

function respondsTo(target: Id, selectorName: string): boolean {
  if (!target) return false;
  const sender = msgSend({ args: [U, U, U], returns: FFIType.bool });
  return Boolean(sender(target, sel("respondsToSelector:"), sel(selectorName)));
}

function nsStringToJs(str: Id): string | null {
  if (!str) return null;
  const sender = msgSend({ args: [U, U], returns: FFIType.cstring });
  const raw = sender(str, sel("UTF8String")) as { toString(): string } | null;
  return raw ? raw.toString() : null;
}

function kvcDescription(target: Id, key: string): string | null {
  if (!target || !respondsTo(target, key)) return null;
  const value = send(target, "valueForKey:", nsString(key));
  if (!value) return null;
  const desc = send(value, "description");
  return nsStringToJs(desc);
}

function parseRect(description: string | null): AppKitRect | null {
  if (!description) return null;
  const match = /\{\{\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\}\s*,\s*\{\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\}\}/.exec(
    description,
  );
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const width = Number(match[3]);
  const height = Number(match[4]);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

function parseEdgeTop(description: string | null): number {
  if (!description) return 0;
  const match = /\{\s*([-\d.]+)\s*,/.exec(description);
  const top = match ? Number(match[1]) : 0;
  return Number.isFinite(top) ? top : 0;
}

/**
 * Reads AppKit NSScreen geometry (including exact hardware notch metrics from
 * safeAreaInsets and auxiliaryTopLeft/RightArea) without struct-return FFI.
 */
export function getMacScreens(): ScreenNotchInfo[] {
  if (!runtime) return [];
  const pool = runtime.objc_autoreleasePoolPush();
  try {
    const nsScreen = cls("NSScreen");
    if (!nsScreen) return [];
    const screens = send(nsScreen, "screens");
    if (!screens) return [];
    const count = Number(send(screens, "count"));
    const result: ScreenNotchInfo[] = [];
    for (let i = 0; i < count; i += 1) {
      const screen = send(screens, "objectAtIndex:", BigInt(i));
      const frame = parseRect(kvcDescription(screen, "frame"));
      const visibleFrame = parseRect(kvcDescription(screen, "visibleFrame"));
      if (!frame || !visibleFrame) continue;
      const safeAreaTop = parseEdgeTop(kvcDescription(screen, "safeAreaInsets"));
      const auxLeft = parseRect(kvcDescription(screen, "auxiliaryTopLeftArea"));
      const auxRight = parseRect(kvcDescription(screen, "auxiliaryTopRightArea"));
      result.push({ frame, visibleFrame, safeAreaTop, auxLeft, auxRight });
    }
    return result;
  } catch {
    return [];
  } finally {
    runtime.objc_autoreleasePoolPop(pool);
  }
}

/**
 * Returns the AppKit frame height of the screen Electrobun's setWindowFrame
 * will use to flip Y (`window.screen ?? NSScreen.mainScreen`).
 */
export function getWindowReferenceScreenHeight(windowPtr: unknown): number | null {
  if (!runtime) return null;
  const pool = runtime.objc_autoreleasePoolPush();
  try {
    let screen = windowPtr ? send(toId(windowPtr), "screen") : 0n;
    if (!screen) {
      const nsScreen = cls("NSScreen");
      if (nsScreen) screen = send(nsScreen, "mainScreen");
    }
    const frame = parseRect(kvcDescription(screen, "frame"));
    return frame ? frame.height : null;
  } catch {
    return null;
  } finally {
    runtime.objc_autoreleasePoolPop(pool);
  }
}
