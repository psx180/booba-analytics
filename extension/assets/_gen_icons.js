// Pure Node.js PNG generator — no external deps
const fs = require('fs');
const zlib = require('zlib');

function createPNG(size) {
  // Each pixel: RGBA
  const pixels = [];
  const cx = size / 2, cy = size / 2, r = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) {
        pixels.push(0, 0, 0, 0); // transparent
      } else {
        // Dark navy background
        pixels.push(30, 41, 59, 255);
      }
    }
  }

  // Draw 'B' by checking bounding box pixels
  const fontSize = Math.floor(size * 0.55);
  const bx = Math.floor(size * 0.28), by = Math.floor(size * 0.22);
  const bw = Math.floor(size * 0.22), bh = Math.floor(size * 0.56);
  const stemW = Math.floor(Math.max(2, size * 0.12));
  const bulgeR = bh / 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (pixels[i + 3] === 0) continue; // skip transparent

      let isB = false;
      // Vertical stem
      if (x >= bx && x < bx + stemW && y >= by && y < by + bh) isB = true;
      // Top bump
      const topCx = bx + stemW + bulgeR * 0.8, topCy = by + bulgeR;
      const topDx = x - topCx, topDy = y - topCy;
      if (Math.sqrt(topDx * topDx + topDy * topDy) < bulgeR * 1.05) isB = true;
      // Bottom bump
      const botCx = bx + stemW + bulgeR * 0.9, botCy = by + bh - bulgeR;
      const botDx = x - botCx, botDy = y - botCy;
      if (Math.sqrt(botDx * botDx + botDy * botDy) < bulgeR * 1.15) isB = true;

      if (isB) {
        pixels[i] = 96; pixels[i+1] = 165; pixels[i+2] = 250; pixels[i+3] = 255;
      }
    }
  }

  // Build PNG
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw image data with filter bytes
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // None filter
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * (1 + size * 4) + 1 + x * 4;
      raw[dst] = pixels[src];
      raw[dst+1] = pixels[src+1];
      raw[dst+2] = pixels[src+2];
      raw[dst+3] = pixels[src+3];
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const body = Buffer.concat([typeB, data]);
    const crc = crc32(body);
    const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc);
    return Buffer.concat([len, body, crcB]);
  }

  // CRC32
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

[16, 48, 128].forEach(size => {
  const png = createPNG(size);
  fs.writeFileSync(`${__dirname}/icon-${size}.png`, png);
  console.log(`icon-${size}.png (${png.length} bytes)`);
});
