// Run with: node generate-icons.js
// Generates icon-16.png, icon-48.png, icon-128.png from booba-calm.svg
// Requires: npm install -g sharp (or use with canvas)
// For hackathon: icons are simple programmatic PNGs — no external deps needed
// This script uses pure Node.js Buffer to write minimal valid PNGs

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas'); // npm install canvas

const sizes = [16, 48, 128];

sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background circle
  ctx.fillStyle = '#1e293b';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // 'B' letter
  ctx.fillStyle = '#60a5fa';
  ctx.font = `bold ${Math.floor(size * 0.55)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('B', size / 2, size / 2 + size * 0.04);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(__dirname, `icon-${size}.png`), buffer);
  console.log(`Generated icon-${size}.png`);
});
