/**
 * Syncs the Firefox cookie reader Kip's gemini2api plugin uses.
 *
 * The file is owned by the gemini2api repository (`integrations/kip/cookies.ts`)
 * and copied here verbatim; never edit the copy. The pin records where it came
 * from and its digest, and a test fails if the two disagree.
 *
 *   bun run sync:cookies                 # copy from the local checkout or GitHub
 *   bun run sync:cookies --check         # verify the copy matches its pin
 *   bun run sync:cookies --from PATH     # copy from an explicit file or URL
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const UPSTREAM_PATH = "integrations/kip/cookies.ts";
const PIN_FILE = "src/bun/plugins/gemini2api/vendor/cookies.pin.json";
const VENDOR_FILE = "src/bun/plugins/gemini2api/vendor/cookies.ts";
/** Where a checkout usually sits in development; `GEMINI2API_REPO` overrides it. */
const LOCAL_CANDIDATES = [
  process.env.GEMINI2API_REPO,
  join(homedir(), "Workspace/gh/abcdlsj/gemini2api"),
].filter((path): path is string => Boolean(path));

interface Pin {
  source: string;
  ref: string;
  sha256: string;
}

function digest(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readPin(): Pin {
  if (!existsSync(PIN_FILE)) {
    return { source: "", ref: "", sha256: "" };
  }
  return JSON.parse(readFileSync(PIN_FILE, "utf8")) as Pin;
}

function localCheckout(): string | null {
  for (const candidate of LOCAL_CANDIDATES) {
    const path = resolve(candidate, UPSTREAM_PATH);
    if (existsSync(path)) return resolve(candidate);
  }
  return null;
}

function localRef(repo: string): string {
  const result = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]);
  const sha = new TextDecoder().decode(result.stdout).trim();
  return result.exitCode === 0 && sha ? sha : readPin().ref || "main";
}

function check(): void {
  const pin = readPin();
  if (!existsSync(VENDOR_FILE)) throw new Error(`${VENDOR_FILE} is missing`);
  const actual = digest(readFileSync(VENDOR_FILE));
  if (!pin.sha256 || actual !== pin.sha256) {
    throw new Error(
      `vendored cookies.ts does not match its pin (${actual} != ${pin.sha256}).\n` +
        "Run `bun run sync:cookies` instead of editing the copy.",
    );
  }
  console.log(
    `vendored cookies.ts matches ${pin.source}@${pin.ref.slice(0, 12)}`,
  );
}

async function fetchUpstream(
  from: string | undefined,
  pin: Pin,
): Promise<string> {
  if (from) {
    if (/^https?:\/\//.test(from)) {
      const response = await fetch(from, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error(`${from} answered HTTP ${response.status}`);
      return response.text();
    }
    return readFileSync(resolve(from), "utf8");
  }
  const repo = localCheckout();
  if (repo) return readFileSync(join(repo, UPSTREAM_PATH), "utf8");
  if (!pin.ref)
    throw new Error("No local checkout and no pinned ref to download from");
  const url = `https://raw.githubusercontent.com/abcdlsj/gemini2api/${pin.ref}/${UPSTREAM_PATH}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.text();
}

async function sync(from: string | undefined): Promise<void> {
  const pin = readPin();
  const content = await fetchUpstream(from, pin);
  if (!content.includes("export function readFirefoxCookies")) {
    throw new Error("Refusing to vendor a file that is not the cookie reader");
  }
  const repo = localCheckout();
  const next: Pin = {
    source: `https://github.com/abcdlsj/gemini2api/blob/${repo ? localRef(repo) : pin.ref || "main"}/${UPSTREAM_PATH}`,
    ref: repo ? localRef(repo) : pin.ref || "main",
    sha256: digest(content),
  };
  mkdirSync("src/bun/plugins/gemini2api/vendor", { recursive: true });
  writeFileSync(VENDOR_FILE, content);
  writeFileSync(PIN_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `vendored ${UPSTREAM_PATH} at ${next.ref.slice(0, 12)} (${next.sha256.slice(0, 12)})`,
  );
}

const args = process.argv.slice(2);
if (args.includes("--check")) {
  check();
} else {
  const index = args.indexOf("--from");
  await sync(index >= 0 ? args[index + 1] : undefined);
}
