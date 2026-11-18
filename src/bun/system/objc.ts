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
