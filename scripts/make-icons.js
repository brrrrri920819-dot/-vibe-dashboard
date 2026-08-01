/**
 * scripts/make-icons.js
 * 홈화면 아이콘(PNG)을 외부 도구 없이 직접 그려서 만든다.
 *
 * 아이폰 홈화면에 추가할 때 아이콘이 없으면 화면을 캡처한 흐릿한 이미지가 쓰인다.
 * 의존성을 늘리지 않으려고 PNG를 직접 인코딩한다(zlib은 노드 기본 제공).
 *
 * 실행: node scripts/make-icons.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** RGBA 픽셀 버퍼를 PNG 파일 바이트로 인코딩 */
function encodePng(width, height, rgba) {
  const chunks = [];

  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };

  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  chunks.push(chunk('IHDR', ihdr));

  // 각 줄 앞에 필터 바이트(0)를 붙인다
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  chunks.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
  chunks.push(chunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

/** 아이콘 한 장 그리기 — 둥근 사각형 배경 + 꽃 모양 */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const R = size * 0.225;                 // 모서리 반지름 (iOS 느낌)
  const cx = size / 2, cy = size / 2;

  // 배경 그라디언트 색 (핑크 → 레드), 대시보드 강조색과 같은 계열
  const c1 = [236, 72, 153];
  const c2 = [244, 63, 94];

  // 부드러운 경계를 위해 각 픽셀을 4번 샘플링한다
  const samples = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];

  const insideRounded = (x, y) => {
    const dx = Math.max(R - x, 0, x - (size - R));
    const dy = Math.max(R - y, 0, y - (size - R));
    if (dx === 0 || dy === 0) return x >= 0 && y >= 0 && x <= size && y <= size;
    return dx * dx + dy * dy <= R * R;
  };

  // 꽃: 가운데 원 + 바깥 꽃잎 5장
  const petalR = size * 0.118;
  const orbit  = size * 0.196;
  const petals = [];
  for (let i = 0; i < 5; i++) {
    const a = (-Math.PI / 2) + (i * 2 * Math.PI / 5);
    petals.push([cx + Math.cos(a) * orbit, cy + Math.sin(a) * orbit]);
  }
  const coreR = size * 0.105;

  const inFlower = (x, y) => {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= coreR * coreR) return true;
    for (const [px, py] of petals) {
      if ((x - px) ** 2 + (y - py) ** 2 <= petalR * petalR) return true;
    }
    return false;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0, fgHits = 0;
      for (const [ox, oy] of samples) {
        const sx = x + ox, sy = y + oy;
        if (insideRounded(sx, sy)) {
          bgHits++;
          if (inFlower(sx, sy)) fgHits++;
        }
      }
      const bgA = bgHits / samples.length;
      const fgA = fgHits / samples.length;

      // 대각선 그라디언트
      const t = (x + y) / (2 * size);
      const br = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      const bg = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      const bb = Math.round(c1[2] + (c2[2] - c1[2]) * t);

      // 꽃(흰색)을 배경 위에 올린다
      const r = Math.round(br + (255 - br) * fgA);
      const g = Math.round(bg + (255 - bg) * fgA);
      const b = Math.round(bb + (255 - bb) * fgA);

      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
      buf[i + 3] = Math.round(bgA * 255);
    }
  }
  return encodePng(size, size, buf);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [180, 192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, drawIcon(size));
  console.log(`✅ ${path.relative(path.join(__dirname, '..'), file)} (${size}×${size})`);
}
