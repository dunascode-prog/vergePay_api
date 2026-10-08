// Makes the profile photo fixtures for the Postman suite (folder 20):
//   node postman/fixtures/make-photos.mjs
import sharp from "sharp";
import fs from "fs";
const dir = new URL(".", import.meta.url);
const out = (name) => new URL(name, dir);

// a landscape JPEG with camera metadata the API must strip
await sharp({ create: { width: 900, height: 600, channels: 3, background: "#0f766e" } })
  .composite([{ input: Buffer.from('<svg width="900" height="600"><circle cx="450" cy="300" r="200" fill="#fbbf24"/></svg>') }])
  .withExif({ IFD0: { Copyright: "SECRET-CAMERA-OWNER", Artist: "SECRET-CAMERA-OWNER" } })
  .jpeg({ quality: 80 })
  .toFile(out("photo.jpg").pathname.replace(/^\/(\w:)/, "$1"));
// a square PNG with a transparent background
await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: Buffer.from('<svg width="300" height="300"><rect x="50" y="50" width="200" height="200" fill="#7c3aed"/></svg>') }])
  .png()
  .toFile(out("photo.png").pathname.replace(/^\/(\w:)/, "$1"));
// too small (under 100 px)
await sharp({ create: { width: 60, height: 60, channels: 3, background: "#e11d48" } }).png().toFile(out("tiny.png").pathname.replace(/^\/(\w:)/, "$1"));
// not an image at all, named like one
fs.writeFileSync(out("not-a-photo.png"), "this is a text file pretending to be a PNG\n");
// a GIF (not accepted)
await sharp({ create: { width: 200, height: 200, channels: 3, background: "#2563eb" } }).gif().toFile(out("photo.gif").pathname.replace(/^\/(\w:)/, "$1"));
console.log("fixtures written");
