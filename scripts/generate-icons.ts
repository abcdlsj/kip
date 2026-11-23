/**
 * Renders the monochrome Kip aperture into platform icon assets.
 * macOS consumes icon.iconset, Windows assets/icon.ico, Linux assets/icon.png.
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");
const svg = readFileSync(join(root, "assets", "icon.svg"), "utf8");
// Flat variant of the same geometry: metal gradients turn to mush at 16/32 px.
const smallSvg = readFileSync(join(root, "assets", "icon-small.svg"), "utf8");
const iconset = join(root, "icon.iconset");
mkdirSync(iconset, { recursive: true });
mkdirSync(join(root, "assets"), { recursive: true });

function render(size: number): Buffer {
  const resvg = new Resvg(size <= 32 ? smallSvg : svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  });
  return Buffer.from(resvg.render().asPng());
}

const variants: Array<[string, number]> = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

for (const [name, size] of variants) {
  writeFileSync(join(iconset, name), render(size));
}

const large = render(1024);
writeFileSync(join(root, "assets", "icon.png"), large);

const iconutil = spawnSync(
  "iconutil",
  ["-c", "icns", iconset, "-o", join(root, "icon.icns")],
  {
    stdio: "ignore",
  },
);
if (iconutil.status !== 0) {
  console.warn("iconutil unavailable; macOS will use icon.iconset directly.");
}

function writeIco(path: string, sizes: number[]): void {
  const images = sizes.map((size) => ({ size, data: render(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + images.length * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.data.length;
  }
  writeFileSync(
    path,
    Buffer.concat([header, ...entries, ...images.map((image) => image.data)]),
  );
}

writeIco(join(root, "assets", "icon.ico"), [16, 32, 48, 64, 128, 256]);
console.log("Kip icons generated.");
