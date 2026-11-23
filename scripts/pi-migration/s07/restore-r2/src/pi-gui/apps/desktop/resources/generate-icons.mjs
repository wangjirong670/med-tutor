import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const piGuiNodeModules = path.resolve(__dirname, "../../../node_modules");
const { default: sharp } = await import(
  pathToFileURL(path.join(piGuiNodeModules, "sharp/lib/index.js")).href
);

// High-contrast, geometric MedTutor emblem:
// Deep navy-teal squircle badge + open textbook silhouette + crisp medical cross.
// Intentionally bold strokes and generous negative space so 16px-256px sizes stay sharp.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0B1D39" />
      <stop offset="52%" stop-color="#0F3C56" />
      <stop offset="100%" stop-color="#0D6E76" />
    </linearGradient>
    <radialGradient id="glowGrad" cx="30%" cy="22%" r="72%">
      <stop offset="0%" stop-color="#2DD4BF" stop-opacity="0.28" />
      <stop offset="60%" stop-color="#0EA5E9" stop-opacity="0.06" />
      <stop offset="100%" stop-color="#0B1D39" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="bookGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="100%" stop-color="#DCEEF2" />
    </linearGradient>
    <linearGradient id="crossGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#5EEAD4" />
      <stop offset="100%" stop-color="#14B8A6" />
    </linearGradient>
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#5EEAD4" stop-opacity="0.55" />
      <stop offset="100%" stop-color="#38BDF8" stop-opacity="0.18" />
    </linearGradient>
  </defs>

  <!-- Outer rounded squircle -->
  <rect x="20" y="20" width="472" height="472" rx="112" ry="112" fill="url(#bgGrad)" />
  <rect x="20" y="20" width="472" height="472" rx="112" ry="112" fill="url(#glowGrad)" />
  <rect x="26" y="26" width="460" height="460" rx="106" ry="106" fill="none" stroke="url(#borderGrad)" stroke-width="6" />

  <!-- Subtle spine shadow / pedestal arc -->
  <ellipse cx="256" cy="404" rx="138" ry="18" fill="#061325" fill-opacity="0.45" />

  <!-- Open Book Base (left + right pages) -->
  <path d="M256 238
           C214 214, 152 210, 102 222
           C92 224.5, 86 233, 86 243
           L86 364
           C86 374, 95 381, 105 378.5
           C156 366, 214 371, 256 394
           C298 371, 356 366, 407 378.5
           C417 381, 426 374, 426 364
           L426 243
           C426 233, 420 224.5, 410 222
           C360 210, 298 214, 256 238 Z"
        fill="url(#bookGrad)" />

  <!-- Center spine crease -->
  <path d="M256 236 L256 394" stroke="#0F3C56" stroke-width="8" stroke-linecap="round" stroke-opacity="0.35" />

  <!-- Teal page accents -->
  <path d="M124 274 C162 268, 202 272, 232 284" fill="none" stroke="#0F766E" stroke-width="11" stroke-linecap="round" stroke-opacity="0.32" />
  <path d="M124 316 C162 310, 202 314, 232 326" fill="none" stroke="#0F766E" stroke-width="11" stroke-linecap="round" stroke-opacity="0.24" />
  <path d="M388 274 C350 268, 310 272, 280 284" fill="none" stroke="#0F766E" stroke-width="11" stroke-linecap="round" stroke-opacity="0.32" />
  <path d="M388 316 C350 310, 310 314, 280 326" fill="none" stroke="#0F766E" stroke-width="11" stroke-linecap="round" stroke-opacity="0.24" />

  <!-- Medical Cross Shield / Emblem Rising from Center -->
  <circle cx="256" cy="176" r="96" fill="#082438" stroke="#5EEAD4" stroke-width="8" stroke-opacity="0.85" />
  <path d="M246 114 H266 A12 12 0 0 1 278 126 V154 H306 A12 12 0 0 1 318 166 V186 A12 12 0 0 1 306 198 H278 V226 A12 12 0 0 1 266 238 H246 A12 12 0 0 1 234 226 V198 H206 A12 12 0 0 1 194 186 V166 A12 12 0 0 1 206 154 H234 V126 A12 12 0 0 1 246 114 Z"
        fill="url(#crossGrad)" />
</svg>
`;

const pngPath = path.join(__dirname, "icon.png");
const icoPath = path.join(__dirname, "icon.ico");

const svgBuffer = Buffer.from(svg, "utf8");
await sharp(svgBuffer).resize(512, 512).png({ compressionLevel: 9 }).toFile(pngPath);

const icoSizes = [16, 24, 32, 48, 64, 128, 256];

function encodeBmpFrame(rgba, width, height) {
  const headerSize = 40;
  const pixelBytes = width * height * 4;
  const andRowStride = Math.ceil(width / 32) * 4;
  const andBytes = andRowStride * height;
  const buf = Buffer.alloc(headerSize + pixelBytes + andBytes);

  // BITMAPINFOHEADER
  buf.writeUInt32LE(headerSize, 0);
  buf.writeInt32LE(width, 4);
  buf.writeInt32LE(height * 2, 8); // XOR + AND mask height
  buf.writeUInt16LE(1, 12); // planes
  buf.writeUInt16LE(32, 14); // bpp
  buf.writeUInt32LE(0, 16); // BI_RGB
  buf.writeUInt32LE(pixelBytes + andBytes, 20);

  // Bottom-up BGRA pixels
  let offset = headerSize;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      buf[offset++] = rgba[srcIdx + 2]; // B
      buf[offset++] = rgba[srcIdx + 1]; // G
      buf[offset++] = rgba[srcIdx]; // R
      buf[offset++] = rgba[srcIdx + 3]; // A
    }
  }

  // 1-bit AND mask (0 = use alpha channel, 1 = transparent when alpha==0)
  const maskBase = headerSize + pixelBytes;
  for (let y = height - 1; y >= 0; y--) {
    const rowStart = maskBase + (height - 1 - y) * andRowStride;
    for (let x = 0; x < width; x++) {
      const alpha = rgba[(y * width + x) * 4 + 3];
      if (alpha === 0) {
        const byteIdx = rowStart + (x >> 3);
        buf[byteIdx] |= 1 << (7 - (x & 7));
      }
    }
  }
  return buf;
}

const frames = [];
for (const size of icoSizes) {
  if (size >= 256) {
    const pngData = await sharp(svgBuffer)
      .resize(size, size, { kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9 })
      .toBuffer();
    frames.push({ size, data: pngData });
  } else {
    const { data, info } = await sharp(svgBuffer)
      .resize(size, size, { kernel: sharp.kernel.lanczos3 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    frames.push({ size, data: encodeBmpFrame(data, info.width, info.height) });
  }
}

const iconDirSize = 6;
const entrySize = 16;
let dataOffset = iconDirSize + entrySize * frames.length;
const header = Buffer.alloc(dataOffset);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = 1 (ICO)
header.writeUInt16LE(frames.length, 4);

for (let i = 0; i < frames.length; i++) {
  const { size, data } = frames[i];
  const base = iconDirSize + i * entrySize;
  header[base] = size >= 256 ? 0 : size;
  header[base + 1] = size >= 256 ? 0 : size;
  header[base + 2] = 0; // color palette
  header[base + 3] = 0; // reserved
  header.writeUInt16LE(1, base + 4); // planes
  header.writeUInt16LE(32, base + 6); // bpp
  header.writeUInt32LE(data.length, base + 8);
  header.writeUInt32LE(dataOffset, base + 12);
  dataOffset += data.length;
}

const icoBuffer = Buffer.concat([header, ...frames.map((f) => f.data)]);
writeFileSync(icoPath, icoBuffer);

console.log(`Generated ${pngPath} (${readFileSync(pngPath).length} bytes)`);
console.log(`Generated ${icoPath} (${icoBuffer.length} bytes, ${frames.length} frames: ${icoSizes.join(", ")})`);
