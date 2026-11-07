#!/usr/bin/env node
/**
 * Scaffold curriculum — **KHÔNG phải generator nội dung**.
 *
 * Script này chỉ tạo *xương sống* cho 30 bài và 30 cover từ contract ở
 * `tests/curriculum-contract.ts`:
 *
 * - thư mục content `NN.<slug>/index.md` với frontmatter đầy đủ;
 * - thân bài là **placeholder đánh dấu**, để agent biết chỗ nào cần viết;
 * - cover SVG theo design system dùng chung, motif theo từng chủ đề.
 *
 * Chạy lại script **không** ghi đè phần đã viết: nó bỏ qua `index.md` đã tồn
 * tại và cover đã tồn tại. Nhờ vậy dùng nó để tái sinh asset bị mất cũng an
 * toàn — nguồn sự thật của nội dung là file markdown đã viết, không phải script.
 *
 * Chạy: `node tests/curriculum-scaffold.mjs` (từ apps/home)
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CURRICULUM, publicationDate } from './curriculum-contract.ts';

const CONTENT = 'content';
const AUTHOR = 'John Martin';

/* ─────────────────────────────── SVG design system ─────────────────────────────── */

/** Bảng màu chung — slate trung tính + hai nhấn, dùng nhất quán cho cả 30 cover. */
export const PALETTE = {
  bg: '#f8fafc',
  panel: '#ffffff',
  ink: '#0f172a',
  inkSoft: '#334155',
  muted: '#64748b',
  line: '#cbd5e1',
  accent: '#4f46e5',
  accentSoft: '#e0e7ff',
  warm: '#0f766e',
  warmSoft: '#ccfbf1',
  footer: '#e2e8f0',
};

const W = 1280;
const H = 720;
const FONT =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

/** Escape XML — bắt buộc cho title tiếng Anh có `&`, `<`, `'`. */
function esc(value) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/**
 * Motif hình học theo chủ đề bài.
 *
 * Mỗi motif vẽ trong vùng `MOTIF_BOX` ở góc phải — **không** đè lên tiêu đề
 * (vùng tiêu đề là `TITLE_BOX` bên trái, cách motif ít nhất 48px). Cùng bộ
 * `stroke`/`fill`, cùng `stroke-width`, cùng bo góc: đó là thứ làm 30 cover trông
 * là một hệ thiết kế chứ không phải 30 file rời.
 */
const MOTIF_BOX = { x: 812, y: 96, w: 396, h: 396 };
const TITLE_BOX = { x: 88, y: 168, w: 640, h: 400 };

function motifPaths(motif) {
  const { x, y, w, h } = MOTIF_BOX;
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (motif) {
    /* Ma trận / tensor: lưới ô vuông, vài ô được tô đậm. */
    case 'grid-matrix': {
      const cells = [];
      const n = 6;
      const s = 44;
      const g = 10;
      const total = n * s + (n - 1) * g;
      const ox = cx - total / 2;
      const oy = cy - total / 2;
      const filled = new Set(['1,1', '2,2', '4,0', '5,3']);
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          const filledCell = filled.has(`${i},${j}`);
          cells.push(
            `<rect x="${ox + j * (s + g)}" y="${oy + i * (s + g)}" width="${s}" height="${s}" rx="6" fill="${filledCell ? PALETTE.accent : PALETTE.panel}" stroke="${filledCell ? PALETTE.accent : PALETTE.line}" stroke-width="3"/>`,
          );
        }
      }
      return cells.join('\n    ');
    }
    /* Phép chiếu: vector gốc, đường chiếu xuống trục, vector chiếu. */
    case 'projection': {
      return [
        `<line x1="${x + 20}" y1="${y + h - 30}" x2="${x + w - 20}" y2="${y + h - 30}" stroke="${PALETTE.line}" stroke-width="3"/>`,
        `<line x1="${x + 20}" y1="${y + h - 30}" x2="${x + 20}" y2="${y + 20}" stroke="${PALETTE.line}" stroke-width="3"/>`,
        `<line x1="${x + 20}" y1="${y + h - 30}" x2="${cx + 110}" y2="${y + 40}" stroke="${PALETTE.ink}" stroke-width="6" stroke-linecap="round"/>`,
        `<line x1="${cx + 110}" y1="${y + h - 30}" x2="${x + 20}" y2="${y + h - 30}" stroke="${PALETTE.line}" stroke-width="4" stroke-dasharray="10 8"/>`,
        `<line x1="${x + 20}" y1="${y + h - 30}" x2="${cx + 110}" y2="${y + h - 30}" stroke="${PALETTE.warm}" stroke-width="6" stroke-linecap="round"/>`,
        `<circle cx="${x + 20}" cy="${y + h - 30}" r="9" fill="${PALETTE.muted}"/>`,
        `<circle cx="${cx + 110}" cy="${y + 40}" r="11" fill="${PALETTE.ink}"/>`,
        `<circle cx="${cx + 110}" cy="${y + h - 30}" r="9" fill="${PALETTE.warm}"/>`,
        `<text x="${x + 24}" y="${y + h - 44}" font-family="${MONO}" font-size="22" fill="${PALETTE.muted}">proj</text>`,
      ].join('\n    ');
    }
    /* Đạo hàm: đường cong và tiếp tuyến tại một điểm. */
    case 'tangent-curve': {
      const t = 150;
      const py = y + h - 150;
      const px = x + t;
      return [
        `<path d="M ${x + 20} ${y + h - 20} C ${x + 110} ${y + 40}, ${x + 230} ${y + h - 250}, ${x + w - 20} ${y + 30}" fill="none" stroke="${PALETTE.accent}" stroke-width="6" stroke-linecap="round"/>`,
        `<line x1="${x + 20}" y1="${y + h - 20}" x2="${x + w - 20}" y2="${y + h - 20}" stroke="${PALETTE.line}" stroke-width="3"/>`,
        `<line x1="${x + 20}" y1="${y + h - 20}" x2="${x + 20}" y2="${y + 20}" stroke="${PALETTE.line}" stroke-width="3"/>`,
        `<line x1="${px}" y1="${py}" x2="${px + 120}" y2="${py - 90}" stroke="${PALETTE.warm}" stroke-width="5" stroke-linecap="round"/>`,
        `<circle cx="${px}" cy="${py}" r="10" fill="${PALETTE.warm}"/>`,
        `<text x="${px + 92}" y="${py - 96}" font-family="${MONO}" font-size="21" fill="${PALETTE.warm}">dL/dw</text>`,
      ].join('\n    ');
    }
    /* Phân phối: đường cong hình chuông rời rạc theo các đoạn. */
    case 'bell-curve': {
      const pts = [];
      const n = 13;
      for (let i = 0; i < n; i += 1) {
        const t = i / (n - 1);
        const px = x + 24 + t * (w - 48);
        const bump = Math.exp(-((t - 0.5) ** 2) / 0.045);
        const py = y + h - 34 - bump * (h - 96);
        pts.push(`${i === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`);
      }
      return [
        `<line x1="${x + 18}" y1="${y + h - 34}" x2="${x + w - 18}" y2="${y + h - 34}" stroke="${PALETTE.line}" stroke-width="3"/>`,
        `<path d="${pts.join(' ')}" fill="none" stroke="${PALETTE.accent}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`,
        `<line x1="${cx}" y1="${y + 40}" x2="${cx}" y2="${y + h - 34}" stroke="${PALETTE.line}" stroke-width="3" stroke-dasharray="8 8"/>`,
        `<circle cx="${cx}" cy="${y + 40}" r="10" fill="${PALETTE.warm}"/>`,
      ].join('\n    ');
    }
    /* Entropy: các cột xếp chồng biểu diễn phân phối. */
    case 'stacked-bars': {
      const n = 7;
      const bw = 36;
      const gap = 16;
      const total = n * bw + (n - 1) * gap;
      const ox = cx - total / 2;
      const out = [];
      for (let i = 0; i < n; i += 1) {
        const frac = 0.2 + 0.72 * Math.exp(-((i - 2.4) ** 2 / 6));
        const bh = frac * (h - 90);
        const bx = ox + i * (bw + gap);
        const by = y + h - 28 - bh;
        out.push(
          `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}" rx="5" fill="${i === 2 ? PALETTE.warm : PALETTE.accent}" opacity="${(0.35 + 0.65 * frac).toFixed(2)}"/>`,
        );
      }
      out.push(
        `<line x1="${x + 20}" y1="${y + h - 28}" x2="${x + w - 20}" y2="${y + h - 28}" stroke="${PALETTE.line}" stroke-width="3"/>`,
      );
      return out.join('\n    ');
    }
    /* Tập dữ liệu: điểm tản rác và một đường phân cách. */
    case 'scatter-split': {
      const out = [
        `<line x1="${x + 30}" y1="${y + 30}" x2="${x + 120}" y2="${y + h - 30}" stroke="${PALETTE.line}" stroke-width="4" stroke-dasharray="12 9"/>`,
        `<line x1="${x + 120}" y1="${y + h - 30}" x2="${x + w - 30}" y2="${y + 30}" stroke="${PALETTE.line}" stroke-width="4" stroke-dasharray="12 9"/>`,
      ];
      // Điểm seed cố định — LCG, không dùng Math.random để scaffold tất định.
      let seed = 42;
      const rnd = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
      for (let i = 0; i < 26; i += 1) {
        const px = x + 26 + rnd() * (w - 52);
        const py = y + 26 + rnd() * (h - 52);
        // Nhãn theo phía đường phân cách chéo.
        const label = py > y + h - 30 - (px - x - 30) * ((h - 60) / (w - 60)) ? 0 : 1;
        out.push(
          `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="9" fill="${label === 0 ? PALETTE.accent : PALETTE.warm}" opacity="0.8"/>`,
        );
      }
      return out.join('\n    ');
    }
    /* Hai hàm mất mát cắt nhau. */
    case 'crossing-curves': {
      return [
        `<path d="M ${x + 24} ${y + 30} C ${x + 150} ${y + 120}, ${x + 170} ${y + h - 60}, ${x + w - 24} ${y + h - 40}" fill="none" stroke="${PALETTE.accent}" stroke-width="6" stroke-linecap="round"/>`,
        `<path d="M ${x + 24} ${y + h - 40} C ${x + 140} ${y + h - 40}, ${x + 220} ${y + 40}, ${x + w - 24} ${y + 30}" fill="none" stroke="${PALETTE.warm}" stroke-width="6" stroke-linecap="round"/>`,
        `<line x1="${x + 24}" y1="${y + h - 20}" x2="${x + w - 24}" y2="${y + h - 20}" stroke="${PALETTE.line}" stroke-width="3"/>`,
        `<circle cx="${x + 196}" cy="${y + 172}" r="10" fill="${PALETTE.ink}"/>`,
      ].join('\n    ');
    }
    /* Đường đồng mức và các bước cập nhật tham số. */
    case 'contour-descent': {
      return [
        `<ellipse cx="${cx}" cy="${cy}" rx="170" ry="120" fill="none" stroke="${PALETTE.line}" stroke-width="4"/>`,
        `<ellipse cx="${cx}" cy="${cy}" rx="120" ry="84" fill="none" stroke="${PALETTE.line}" stroke-width="4"/>`,
        `<ellipse cx="${cx}" cy="${cy}" rx="70" ry="49" fill="none" stroke="${PALETTE.line}" stroke-width="4"/>`,
        `<path d="M ${x + 30} ${y + 40} L ${x + 118} ${y + 112} L ${x + 196} ${y + 176} L ${cx - 26} ${cy - 18} L ${cx - 12} ${cy - 8}" fill="none" stroke="${PALETTE.accent}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`,
        `<circle cx="${cx - 12}" cy="${cy - 8}" r="12" fill="${PALETTE.warm}"/>`,
      ].join('\n    ');
    }
    /* Đường cong fit: train giảm, val tăng lại. */
    case 'fit-curves': {
      return [
        `<path d="M ${x + 24} ${y + 36} L ${x + w / 2} ${y + h - 40} L ${x + w - 24} ${y + h - 24}" fill="none" stroke="${PALETTE.accent}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`,
        `<path d="M ${x + 24} ${y + 96} C ${x + 120} ${y + h - 150}, ${x + 190} ${y + 130}, ${cx} ${y + 96} C ${x + 250} ${y + 66}, ${x + 320} ${y + 84}, ${x + w - 24} ${y + 40}" fill="none" stroke="${PALETTE.warm}" stroke-width="6" stroke-linecap="round"/>`,
        `<line x1="${x + 24}" y1="${y + h - 20}" x2="${x + w - 24}" y2="${y + h - 20}" stroke="${PALETTE.line}" stroke-width="3"/>`,
      ].join('\n    ');
    }
    /* Đám điểm trong không gian vector. */
    case 'point-cloud': {
      let seed = 7;
      const rnd = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
      const out = [
        `<circle cx="${cx}" cy="${cy}" r="150" fill="none" stroke="${PALETTE.line}" stroke-width="3" stroke-dasharray="10 10"/>`,
      ];
      for (let i = 0; i < 22; i += 1) {
        const ang = rnd() * Math.PI * 2;
        const rad = rnd() * 140;
        const px = cx + Math.cos(ang) * rad;
        const py = cy + Math.sin(ang) * rad;
        out.push(
          `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="9" fill="${PALETTE.accent}" opacity="0.7"/>`,
        );
      }
      out.push(`<circle cx="${cx + 40}" cy="${cy - 30}" r="13" fill="${PALETTE.warm}"/>`);
      return out.join('\n    ');
    }
    /* Các khối token ghép lại thành chuỗi. */
    case 'token-blocks': {
      const widths = [86, 58, 104, 70, 92, 62];
      let cursor = x + 26;
      const out = [];
      widths.forEach((wd, i) => {
        const bh = 54 + (i % 3) * 22;
        out.push(
          `<rect x="${cursor}" y="${y + h / 2 - bh / 2}" width="${wd}" height="${bh}" rx="9" fill="${i === 3 ? PALETTE.warm : PALETTE.accentSoft}" stroke="${i === 3 ? PALETTE.warm : PALETTE.accent}" stroke-width="3"/>`,
        );
        cursor += wd + 12;
      });
      out.push(
        `<line x1="${x + 20}" y1="${y + h / 2}" x2="${x + w - 20}" y2="${y + h / 2}" stroke="${PALETTE.line}" stroke-width="3"/>`,
      );
      return out.join('\n    ');
    }
    /* Chuỗi nhân xác suất: các nhánh xác suất rồi tới nhau. */
    case 'chain-probability': {
      return [
        `<circle cx="${x + 46}" cy="${cy}" r="34" fill="${PALETTE.accent}"/>`,
        `<circle cx="${cx}" cy="${y + 92}" r="34" fill="${PALETTE.accentSoft}" stroke="${PALETTE.accent}" stroke-width="4"/>`,
        `<circle cx="${cx}" cy="${cy}" r="34" fill="${PALETTE.accentSoft}" stroke="${PALETTE.accent}" stroke-width="4"/>`,
        `<circle cx="${cx}" cy="${y + h - 92}" r="34" fill="${PALETTE.accentSoft}" stroke="${PALETTE.accent}" stroke-width="4"/>`,
        `<circle cx="${x + w - 46}" cy="${cy}" r="34" fill="${PALETTE.warm}"/>`,
        `<line x1="${x + 80}" y1="${cy}" x2="${cx - 40}" y2="${y + 92}" stroke="${PALETTE.muted}" stroke-width="3"/>`,
        `<line x1="${x + 80}" y1="${cy}" x2="${cx - 40}" y2="${cy}" stroke="${PALETTE.muted}" stroke-width="3"/>`,
        `<line x1="${x + 80}" y1="${cy}" x2="${cx - 40}" y2="${y + h - 92}" stroke="${PALETTE.muted}" stroke-width="3"/>`,
        `<line x1="${cx + 40}" y1="${y + 92}" x2="${x + w - 80}" y2="${cy}" stroke="${PALETTE.muted}" stroke-width="3"/>`,
        `<line x1="${cx + 40}" y1="${cy}" x2="${x + w - 80}" y2="${cy}" stroke="${PALETTE.muted}" stroke-width="3"/>`,
        `<line x1="${cx + 40}" y1="${y + h - 92}" x2="${x + w - 80}" y2="${cy}" stroke="${PALETTE.muted}" stroke-width="3"/>`,
        `<text x="${x + 8}" y="${y + 22}" font-family="${MONO}" font-size="22" fill="${PALETTE.muted}">P(w | context)</text>`,
      ].join('\n    ');
    }
    /* Dao động theo vị trí: các đường sóng lệch pha. */
    case 'sine-wave': {
      const wave = (amp, freq, phase, color) => {
        const pts = [];
        for (let i = 0; i <= 60; i += 1) {
          const t = i / 60;
          const px = x + 20 + t * (w - 40);
          const py = cy + amp * Math.sin(freq * t * Math.PI * 2 + phase);
          pts.push(`${i === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`);
        }
        return `<path d="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"/>`;
      };
      const marks = [];
      for (let i = 0; i <= 4; i += 1) {
        const px = x + 20 + (i / 4) * (w - 40);
        marks.push(
          `<line x1="${px.toFixed(1)}" y1="${y + 26}" x2="${px.toFixed(1)}" y2="${y + h - 26}" stroke="${PALETTE.line}" stroke-width="3"/>`,
        );
      }
      return [...marks, wave(110, 1.5, 0, PALETTE.accent), wave(60, 3, 1.1, PALETTE.warm)].join(
        '\n    ',
      );
    }
    /* Attention: một truy vấn nối tới vài vị trí. */
    case 'attention-nodes': {
      const q = [x + 40, y + h - 40];
      const ks = [
        [x + w - 50, y + 30],
        [x + w - 120, y + 118],
        [x + w - 40, y + 210],
        [x + w - 150, y + 300],
      ];
      const out = ks.map(
        ([kx, ky], i) =>
          `<line x1="${q[0] + 14}" y1="${q[1] - 14}" x2="${kx - 14}" y2="${ky + 14}" stroke="${i === 0 ? PALETTE.warm : PALETTE.line}" stroke-width="${i === 0 ? 6 : 3}"/>`,
      );
      for (const [kx, ky] of ks) {
        out.push(
          `<circle cx="${kx}" cy="${ky}" r="16" fill="${PALETTE.panel}" stroke="${PALETTE.accent}" stroke-width="4"/>`,
        );
      }
      out.push(`<circle cx="${q[0]}" cy="${q[1]}" r="24" fill="${PALETTE.warm}"/>`);
      return out.join('\n    ');
    }
    /* Các tầng của một block: chồng lên nhau theo chiều sâu. */
    case 'layer-stack': {
      const out = [];
      for (let i = 0; i < 5; i += 1) {
        const bx = x + 24 + i * 14;
        const by = y + 250 - i * 52;
        out.push(
          `<rect x="${bx}" y="${by}" width="${w - 120}" height="96" rx="12" fill="${i === 4 ? PALETTE.warmSoft : PALETTE.panel}" stroke="${i === 4 ? PALETTE.warm : PALETTE.line}" stroke-width="3"/>`,
        );
      }
      out.push(
        `<text x="${x + 34}" y="${y + 46}" font-family="${MONO}" font-size="22" fill="${PALETTE.muted}">blocks × L</text>`,
      );
      return out.join('\n    ');
    }
    /* Vòng lặp huấn luyện. */
    case 'cycle-loop': {
      const r = 120;
      const arrow = (a0) => {
        const a1 = a0 + Math.PI * 0.85;
        const x0 = cx + Math.cos(a0) * r;
        const y0 = cy + Math.sin(a0) * r;
        const x1 = cx + Math.cos(a1) * r;
        const y1 = cy + Math.sin(a1) * r;
        return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="${PALETTE.accent}" stroke-width="6" stroke-linecap="round"/>`;
      };
      return [
        arrow(-Math.PI * 0.85),
        arrow(-Math.PI * 0.35 + 0.3),
        arrow(Math.PI * 0.2),
        arrow(Math.PI * 0.7),
        `<circle cx="${cx}" cy="${cy}" r="52" fill="${PALETTE.accentSoft}" stroke="${PALETTE.accent}" stroke-width="4"/>`,
        `<text x="${cx}" y="${cy + 9}" font-family="${MONO}" font-size="24" fill="${PALETTE.ink}" text-anchor="middle">step</text>`,
      ].join('\n    ');
    }
    /* Đường lũy thừa trên trục log. */
    case 'power-law': {
      const pts = [];
      for (let i = 0; i <= 40; i += 1) {
        const t = i / 40;
        const px = x + 30 + t * (w - 60);
        const loss = 1.8 - 1.35 * t;
        const py = y + h - 40 - loss * (h - 90);
        pts.push(`${i === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`);
      }
      return [
        `<line x1="${x + 20}" y1="${y + h - 40}" x2="${x + w - 20}" y2="${y + h - 40}" stroke="${PALETTE.line}" stroke-width="3"/>`,
        `<line x1="${x + 20}" y1="${y + h - 40}" x2="${x + 20}" y2="${y + 30}" stroke="${PALETTE.line}" stroke-width="3"/>`,
        `<path d="${pts.join(' ')}" fill="none" stroke="${PALETTE.accent}" stroke-width="6" stroke-linecap="round"/>`,
        `<text x="${x + 34}" y="${y + 56}" font-family="${MONO}" font-size="22" fill="${PALETTE.muted}">log C</text>`,
        `<text x="${x + 26}" y="${y + h - 52}" font-family="${MONO}" font-size="22" fill="${PALETTE.muted}">log L</text>`,
      ].join('\n    ');
    }
    /* Phễu lọc dữ liệu. */
    case 'curation-funnel': {
      const stages = [
        [w - 60, 40],
        [w - 130, 74],
        [w - 190, 108],
        [w - 240, 140],
      ];
      const out = [];
      stages.forEach(([sw, sh], i) => {
        const sy = y + 30 + i * 92;
        const sx = x + 30 + (w - 60 - sw) / 2;
        out.push(
          `<rect x="${sx.toFixed(1)}" y="${sy}" width="${sw}" height="${sh}" rx="10" fill="${i === 3 ? PALETTE.warmSoft : PALETTE.accentSoft}" stroke="${i === 3 ? PALETTE.warm : PALETTE.accent}" stroke-width="3"/>`,
        );
      });
      return out.join('\n    ');
    }
    /* Lưới thiết bị, mỗi thiết bị một phần tham số. */
    case 'device-grid': {
      const out = [];
      for (let r = 0; r < 2; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          const bx = x + 30 + c * 118;
          const by = y + 90 + r * 118;
          out.push(
            `<rect x="${bx}" y="${by}" width="96" height="96" rx="12" fill="${PALETTE.panel}" stroke="${PALETTE.accent}" stroke-width="4"/>`,
          );
          for (let t = 0; t < 4; t += 1) {
            out.push(
              `<line x1="${bx + 16}" y1="${by + 24 + t * 16}" x2="${bx + 80}" y2="${by + 24 + t * 16}" stroke="${PALETTE.line}" stroke-width="4"/>`,
            );
          }
        }
      }
      out.push(
        `<text x="${x + 30}" y="${y + 60}" font-family="${MONO}" font-size="22" fill="${PALETTE.muted}">shard θ</text>`,
      );
      return out.join('\n    ');
    }
    /* Dải thời gian prefill rồi decode. */
    case 'prefill-timeline': {
      const out = [
        `<line x1="${x + 24}" y1="${y + h / 2}" x2="${x + w - 24}" y2="${y + h / 2}" stroke="${PALETTE.line}" stroke-width="3"/>`,
      ];
      const pw = 150;
      out.push(
        `<rect x="${x + 30}" y="${y + h / 2 - 44}" width="${pw}" height="60" rx="10" fill="${PALETTE.accent}"/>`,
      );
      out.push(
        `<text x="${x + 30 + pw / 2}" y="${y + h / 2 - 14}" font-family="${MONO}" font-size="22" fill="${PALETTE.panel}" text-anchor="middle">prefill</text>`,
      );
      let cursor = x + 30 + pw + 16;
      for (let i = 0; i < 4; i += 1) {
        out.push(
          `<rect x="${cursor}" y="${y + h / 2 - 30}" width="46" height="32" rx="7" fill="${PALETTE.warmSoft}" stroke="${PALETTE.warm}" stroke-width="3"/>`,
        );
        cursor += 54;
      }
      out.push(
        `<text x="${cursor + 4}" y="${y + h / 2 - 14}" font-family="${MONO}" font-size="22" fill="${PALETTE.warm}">decode ×n</text>`,
      );
      return out.join('\n    ');
    }
    /* Các cột bộ nhớ theo số tầng. */
    case 'memory-bars': {
      const out = [];
      const n = 6;
      const bw = 44;
      const gap = 22;
      const total = n * bw + (n - 1) * gap;
      const ox = cx - total / 2;
      for (let i = 0; i < n; i += 1) {
        const frac = 0.25 + 0.75 * ((i + 1) / n);
        const bh = frac * (h - 80);
        out.push(
          `<rect x="${ox + i * (bw + gap)}" y="${y + h - 30 - bh}" width="${bw}" height="${bh.toFixed(1)}" rx="6" fill="${PALETTE.warm}" opacity="${(0.35 + 0.6 * frac).toFixed(2)}"/>`,
        );
      }
      out.push(
        `<line x1="${x + 20}" y1="${y + h - 30}" x2="${x + w - 20}" y2="${y + h - 30}" stroke="${PALETTE.line}" stroke-width="3"/>`,
      );
      out.push(
        `<text x="${x + 24}" y="${y + 34}" font-family="${MONO}" font-size="22" fill="${PALETTE.muted}">2·L·H·S</text>`,
      );
      return out.join('\n    ');
    }
    /* Các bậc lượng tử. */
    case 'quantize-steps': {
      const out = [];
      const steps = ['fp32', 'fp16', 'int8', 'int4'];
      steps.forEach((_, i) => {
        const sx = x + 30 + i * 86;
        const bh = (h - 80) * (1 - i * 0.22);
        out.push(
          `<rect x="${sx}" y="${y + h - 30 - bh}" width="66" height="${bh.toFixed(1)}" rx="8" fill="${i === 3 ? PALETTE.warm : PALETTE.accent}" opacity="${(0.9 - i * 0.16).toFixed(2)}"/>`,
        );
      });
      out.push(
        `<line x1="${x + 20}" y1="${y + h - 30}" x2="${x + w - 20}" y2="${y + h - 30}" stroke="${PALETTE.line}" stroke-width="3"/>`,
      );
      out.push(
        `<text x="${x + 24}" y="${y + 34}" font-family="${MONO}" font-size="22" fill="${PALETTE.muted}">bits per weight</text>`,
      );
      return out.join('\n    ');
    }
    /* Prompt đi qua một phép biến đổi. */
    case 'instruction-transform': {
      return [
        `<rect x="${x + 26}" y="${y + 60}" width="130" height="${h - 120}" rx="12" fill="${PALETTE.accentSoft}" stroke="${PALETTE.accent}" stroke-width="4"/>`,
        `<text x="${x + 91}" y="${y + h / 2 + 8}" font-family="${MONO}" font-size="22" fill="${PALETTE.ink}" text-anchor="middle">SFT</text>`,
        `<path d="M ${x + 172} ${y + h / 2} L ${x + 216} ${y + h / 2}" stroke="${PALETTE.muted}" stroke-width="5"/>`,
        `<path d="M ${x + 216} ${y + h / 2 - 12} L ${x + 236} ${y + h / 2} L ${x + 216} ${y + h / 2 + 12} Z" fill="${PALETTE.muted}"/>`,
        `<rect x="${x + 250}" y="${y + 60}" width="130" height="${h - 120}" rx="12" fill="${PALETTE.warmSoft}" stroke="${PALETTE.warm}" stroke-width="4"/>`,
        `<text x="${x + 315}" y="${y + h / 2 + 8}" font-family="${MONO}" font-size="22" fill="${PALETTE.ink}" text-anchor="middle">RLHF</text>`,
      ].join('\n    ');
    }
    /* So sánh cặp ưu tiên rồi rẽ nhánh. */
    case 'preference-branch': {
      const out = [
        `<circle cx="${x + 40}" cy="${cy}" r="28" fill="${PALETTE.accentSoft}" stroke="${PALETTE.accent}" stroke-width="4"/>`,
        `<path d="M ${x + 70} ${cy} C ${x + 120} ${cy}, ${x + 150} ${y + 70}, ${x + 200} ${y + 70}" fill="none" stroke="${PALETTE.muted}" stroke-width="4"/>`,
        `<path d="M ${x + 70} ${cy} C ${x + 120} ${cy}, ${x + 150} ${y + h - 70}, ${x + 200} ${y + h - 70}" fill="none" stroke="${PALETTE.muted}" stroke-width="4"/>`,
        `<text x="${x + 210}" y="${y + 78}" font-family="${MONO}" font-size="22" fill="${PALETTE.ink}">chosen</text>`,
        `<text x="${x + 210}" y="${y + h - 62}" font-family="${MONO}" font-size="22" fill="${PALETTE.muted}">rejected</text>`,
        `<circle cx="${x + w - 70}" cy="${y + 70}" r="34" fill="${PALETTE.warmSoft}" stroke="${PALETTE.warm}" stroke-width="4"/>`,
        `<circle cx="${x + w - 70}" cy="${y + h - 70}" r="34" fill="${PALETTE.panel}" stroke="${PALETTE.line}" stroke-width="4"/>`,
      ];
      out.push(
        `<text x="${x + 4}" y="${cy + 8}" font-family="${MONO}" font-size="20" fill="${PALETTE.muted}">x</text>`,
      );
      return out.join('\n    ');
    }
    /* Biểu đồ cột so với mục tiêu. */
    case 'bar-target': {
      const out = [];
      const vals = [0.45, 0.62, 0.58, 0.81];
      const bw = 60;
      const gap = 26;
      const total = vals.length * bw + (vals.length - 1) * gap;
      const ox = cx - total / 2;
      vals.forEach((v, i) => {
        const bh = v * (h - 90);
        out.push(
          `<rect x="${ox + i * (bw + gap)}" y="${y + h - 30 - bh}" width="${bw}" height="${bh.toFixed(1)}" rx="6" fill="${PALETTE.accent}" opacity="0.75"/>`,
        );
      });
      const ty = y + h - 30 - 0.7 * (h - 90);
      out.push(
        `<line x1="${x + 24}" y1="${ty.toFixed(1)}" x2="${x + w - 24}" y2="${ty.toFixed(1)}" stroke="${PALETTE.warm}" stroke-width="5" stroke-dasharray="12 9"/>`,
      );
      out.push(
        `<text x="${x + 26}" y="${(ty - 12).toFixed(1)}" font-family="${MONO}" font-size="21" fill="${PALETTE.warm}">target</text>`,
      );
      return out.join('\n    ');
    }
    /* Pipeline retrieve → context → generate. */
    case 'retrieve-context-generate': {
      const boxes = [
        ['retrieve', PALETTE.accentSoft, PALETTE.accent],
        ['context', PALETTE.panel, PALETTE.line],
        ['generate', PALETTE.warmSoft, PALETTE.warm],
      ];
      const out = [];
      boxes.forEach(([label, fill, stroke], i) => {
        const bx = x + 20 + i * 128;
        out.push(
          `<rect x="${bx}" y="${y + h / 2 - 54}" width="108" height="108" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="4"/>`,
        );
        out.push(
          `<text x="${bx + 54}" y="${y + h / 2 + 7}" font-family="${MONO}" font-size="19" fill="${PALETTE.ink}" text-anchor="middle">${label}</text>`,
        );
        if (i < 2) {
          out.push(
            `<line x1="${bx + 110}" y1="${y + h / 2}" x2="${bx + 126}" y2="${y + h / 2}" stroke="${PALETTE.muted}" stroke-width="4"/>`,
          );
        }
      });
      out.push(
        `<path d="M ${x + 30} ${y + h - 24} Q ${cx} ${y + h + 40}, ${x + w - 30} ${y + h - 24}" fill="none" stroke="${PALETTE.muted}" stroke-width="3" stroke-dasharray="9 8"/>`,
      );
      return out.join('\n    ');
    }
    /* Vòng tròn xấp xỉ: các lân cận của một điểm truy vấn. */
    case 'ann-rings': {
      const out = [
        `<circle cx="${cx}" cy="${cy}" r="160" fill="none" stroke="${PALETTE.line}" stroke-width="3" stroke-dasharray="9 9"/>`,
      ];
      const pts = [
        [110, 20, PALETTE.ink],
        [140, -80, PALETTE.warm],
        [96, -140, PALETTE.accent],
        [-40, -110, PALETTE.accent],
        [-120, 40, PALETTE.accent],
        [-70, 130, PALETTE.ink],
        [40, 150, PALETTE.accent],
      ];
      for (const [dx, dy, color] of pts) {
        out.push(
          `<circle cx="${(cx + dx).toFixed(1)}" cy="${(cy + dy).toFixed(1)}" r="13" fill="${color}"/>`,
        );
      }
      out.push(
        `<circle cx="${cx}" cy="${cy}" r="26" fill="${PALETTE.warm}" stroke="${PALETTE.panel}" stroke-width="4"/>`,
      );
      out.push(
        `<text x="${cx + 36}" y="${cy - 40}" font-family="${MONO}" font-size="21" fill="${PALETTE.muted}">q</text>`,
      );
      return out.join('\n    ');
    }
    /* Thang xếp hạng: ứng viên lên lại. */
    case 'rerank-ladder': {
      const out = [];
      const steps = ['cand', 'cand', 'cand', 'top'];
      steps.forEach((label, i) => {
        const sx = x + 34 + i * 88;
        const bh = 50 + i * 66;
        out.push(
          `<rect x="${sx}" y="${y + h - 30 - bh}" width="66" height="${bh}" rx="8" fill="${i === 3 ? PALETTE.warm : PALETTE.accentSoft}" stroke="${i === 3 ? PALETTE.warm : PALETTE.accent}" stroke-width="3"/>`,
        );
        out.push(
          `<text x="${sx + 33}" y="${y + h - 44}" font-family="${MONO}" font-size="17" fill="${PALETTE.muted}" text-anchor="middle">${label}</text>`,
        );
      });
      out.push(
        `<line x1="${x + 20}" y1="${y + h - 30}" x2="${x + w - 20}" y2="${y + h - 30}" stroke="${PALETTE.line}" stroke-width="3"/>`,
      );
      return out.join('\n    ');
    }
    /* Đối chiếu claim với nguồn. */
    case 'claim-check': {
      return [
        `<rect x="${x + 24}" y="${y + 60}" width="160" height="110" rx="12" fill="${PALETTE.accentSoft}" stroke="${PALETTE.accent}" stroke-width="4"/>`,
        `<text x="${x + 104}" y="${y + 122}" font-family="${MONO}" font-size="22" fill="${PALETTE.ink}" text-anchor="middle">claim</text>`,
        `<rect x="${x + 210}" y="${y + 220}" width="160" height="110" rx="12" fill="${PALETTE.warmSoft}" stroke="${PALETTE.warm}" stroke-width="4"/>`,
        `<text x="${x + 290}" y="${y + 282}" font-family="${MONO}" font-size="22" fill="${PALETTE.ink}" text-anchor="middle">evidence</text>`,
        `<line x1="${x + 130}" y1="${y + 176}" x2="${x + 246}" y2="${y + 216}" stroke="${PALETTE.muted}" stroke-width="4"/>`,
        `<circle cx="${x + 196}" cy="${y + 196}" r="18" fill="${PALETTE.warm}"/>`,
        `<text x="${x + 196}" y="${y + 203}" font-family="${FONT}" font-size="24" fill="${PALETTE.panel}" text-anchor="middle">?</text>`,
      ].join('\n    ');
    }
    /* Thanh sai số trên trục. */
    case 'error-bars': {
      const out = [
        `<line x1="${x + 24}" y1="${y + h / 2}" x2="${x + w - 24}" y2="${y + h / 2}" stroke="${PALETTE.line}" stroke-width="3"/>`,
      ];
      const means = [cx - 100, cx - 10, cx + 86];
      const spreads = [44, 20, 66];
      means.forEach((mx, i) => {
        const s = spreads[i];
        out.push(`<circle cx="${mx}" cy="${y + h / 2}" r="12" fill="${PALETTE.accent}"/>`);
        out.push(
          `<line x1="${mx - s}" y1="${y + h / 2}" x2="${mx + s}" y2="${y + h / 2}" stroke="${PALETTE.warm}" stroke-width="5"/>`,
        );
        out.push(
          `<line x1="${mx - s}" y1="${y + h / 2 - 14}" x2="${mx - s}" y2="${y + h / 2 + 14}" stroke="${PALETTE.warm}" stroke-width="5"/>`,
        );
        out.push(
          `<line x1="${mx + s}" y1="${y + h / 2 - 14}" x2="${mx + s}" y2="${y + h / 2 + 14}" stroke="${PALETTE.warm}" stroke-width="5"/>`,
        );
      });
      return out.join('\n    ');
    }
    default:
      throw new Error(`unknown motif: ${motif}`);
  }
}

/** Bọc tiêu đề thành các dòng, mỗi dòng không vượt quá `maxChars` ký tự. */
function wrapTitle(title, maxChars) {
  const words = title.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/**
 * Hệ số bề rộng trung bình của một ký tự so với cỡ chữ, dùng cho font stack
 * sans-serif hệ thống ở weight 650.
 *
 * SVG **không** có phép đo chữ trước khi render (không có `getBBox` lúc build),
 * nên nếu không ước lượng thì tiêu đề dài sẽ tràn khung ở font khác hệ thống
 * của người đọc — và "tràn khung" ở đây là tiêu đề đè lên motif. Hệ số 0.52 là
 * giá trị thận trọng cho chữ sans pha chữ thường; nó **cố ý chọn về phía thu
 * nhỏ** — tiêu đề hơi nhỏ hơn cần thiết thì vẫn đẹp, tiêu đề tràn thì hỏng bố
 * cục.
 */
const CHAR_WIDTH_RATIO = 0.52;

/** Font lớn nhất mà tiêu đề vẫn nằm gọn trong `TITLE_BOX` (cả bề ngang lẫn chiều cao). */
function fitTitle(title) {
  const candidates = [30, 28, 26, 24, 22, 20, 18];
  let best = null;
  for (const maxChars of candidates) {
    const lines = wrapTitle(title, maxChars);
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
    for (let fs = 58; fs >= 40; fs -= 2) {
      const fitsWidth = longest * CHAR_WIDTH_RATIO * fs <= TITLE_BOX.w;
      const lineHeight = fs + 14;
      const fitsHeight = lines.length * lineHeight <= TITLE_BOX.h;
      if (fitsWidth && fitsHeight) {
        // Ưu tiên bản có nhiều dòng hơn một chút nhưng chữ to hơn: thử đường
        // xuống trong danh sách `maxChars`, giữ phương án font lớn nhất của
        // đường xuống đầu tiên tìm được.
        if (best === null) best = { lines, fontSize: fs, lineHeight };
        break;
      }
    }
    if (best !== null) break;
  }
  return best ?? { lines: wrapTitle(title, 18), fontSize: 40, lineHeight: 54 };
}

/** Số thứ tự bài dạng nhãn nhỏ trên cover. */
function kicker(article) {
  return `Lesson ${String(article.order).padStart(2, '0')} of 30 · ${SERIES_TITLE_SHORT[article.seriesId] ?? article.seriesId}`;
}

const SERIES_TITLE_SHORT = {
  'mathematical-foundations': 'Mathematical foundations',
  'classical-machine-learning': 'Classical machine learning',
  'language-modeling': 'Language modeling',
  pretraining: 'Pretraining and scaling',
  inference: 'Inference and adaptation',
  'evaluation-and-rag': 'Evaluation and RAG',
};

/** Thụt lề mọi dòng của khối SVG thêm hai space cho dễ đọc source. */
function indentBlock(markup) {
  return markup
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/** Render một cover hoàn chỉnh. */
export function renderCover(article) {
  const { lines, fontSize, lineHeight } = fitTitle(article.title);
  const blockHeight = lines.length * lineHeight;
  const top = TITLE_BOX.y + Math.max(0, (TITLE_BOX.h - blockHeight) / 2);

  const titleMarkup = lines
    .map(
      (line, i) =>
        `  <text x="${TITLE_BOX.x}" y="${(top + i * lineHeight).toFixed(1)}" font-family="${FONT}" font-size="${fontSize}" font-weight="650" fill="${PALETTE.ink}">${esc(line)}</text>`,
    )
    .join('\n');

  const numbered = `${String(article.order).padStart(2, '0')} / 30`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="cover-title cover-desc">
  <title id="cover-title">Cover: ${esc(article.title)}</title>
  <desc id="cover-desc">Course cover for lesson ${String(article.order).padStart(2, '0')} of 30, ${esc(SERIES_TITLE_SHORT[article.seriesId] ?? article.seriesId)}. Abstract ${esc(article.motif.replace(/-/gu, ' '))} motif beside the lesson title.</desc>

  <rect x="0" y="0" width="${W}" height="${H}" fill="${PALETTE.bg}"/>
  <rect x="0" y="${H - 88}" width="${W}" height="88" fill="${PALETTE.footer}"/>

  <text x="${TITLE_BOX.x}" y="112" font-family="${MONO}" font-size="24" letter-spacing="1" fill="${PALETTE.accent}">${esc(kicker(article))}</text>
  <line x1="${TITLE_BOX.x}" y1="140" x2="${TITLE_BOX.x + 120}" y2="140" stroke="${PALETTE.accent}" stroke-width="4"/>

${titleMarkup}

  <g aria-hidden="true">
${indentBlock(motifPaths(article.motif))}
  </g>

  <text x="${TITLE_BOX.x}" y="${H - 30}" font-family="${FONT}" font-size="24" fill="${PALETTE.muted}">ecoma.io · AI/ML/LLM curriculum</text>
  <text x="${W - 88}" y="${H - 30}" font-family="${MONO}" font-size="24" fill="${PALETTE.muted}" text-anchor="end">${esc(numbered)}</text>
</svg>
`;
}

/* ─────────────────────────────────── content ─────────────────────────────────── */

function frontmatter(article) {
  const lines = [
    '---',
    `title: '${article.title.replace(/'/gu, "''")}'`,
    `description: '${article.description.replace(/'/gu, "''")}'`,
    `date: '${publicationDate(article.order)}'`,
    `author: '${AUTHOR}'`,
    'tags:',
  ];
  for (const tag of tagsFor(article)) {
    lines.push(`  - ${tag}`);
  }
  lines.push(`featured: ${article.order === 1}`);
  lines.push(`cover: ../../../assets/${article.cover}`);
  lines.push(`coverAlt: '${coverAlt(article)}'`);
  lines.push(`articleId: ${article.slug}`);
  lines.push(`seriesId: ${article.seriesId}`);
  lines.push(`seriesOrder: ${seriesOrderFor(article)}`);
  lines.push(`contentType: ${article.contentType}`);
  lines.push(`level: ${article.level}`);
  if (article.prerequisites.length > 0) {
    lines.push('prerequisites:');
    for (const prereq of article.prerequisites) lines.push(`  - ${prereq}`);
  }
  lines.push('relatedArticleIds:');
  for (const rel of article.related) lines.push(`  - ${rel}`);
  lines.push('---');
  return lines.join('\n');
}

function coverAlt(article) {
  return `Abstract ${article.motif.replace(/-/gu, ' ')} motif on a light background beside the lesson title`;
}

function tagsFor(article) {
  const primary = {
    'mathematical-foundations': 'mathematics',
    'classical-machine-learning': 'machine-learning',
    'language-modeling': 'language-modeling',
    pretraining: 'training',
    inference: 'inference',
    'evaluation-and-rag': 'evaluation',
  };
  return [primary[article.seriesId], 'ai'];
}

/** `seriesOrder` là vị trí *trong series*, không phải vị trí toàn cục. */
function seriesOrderFor(article) {
  return (
    CURRICULUM.filter((a) => a.seriesId === article.seriesId).findIndex(
      (a) => a.slug === article.slug,
    ) + 1
  );
}

function placeholderBody(article) {
  return [
    '',
    `# ${article.title}`,
    '',
    '<!-- TODO(lesson): thay toàn bộ phần dưới bằng nội dung thật của bài. -->',
    '',
  ].join('\n');
}

/* ─────────────────────────────────── run ─────────────────────────────────── */

const appRoot = new URL('..', import.meta.url).pathname;
let written = 0;
let skipped = 0;
let covers = 0;

for (const article of CURRICULUM) {
  const dir = join(
    appRoot,
    CONTENT,
    'en',
    'blog',
    `${String(article.order).padStart(2, '0')}.${article.slug}`,
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.md');
  // Chỉ tạo mới khi thiếu, và **không** đụng vào bài đã có nội dung thật: nguồn
  // sự thật của thân bài là file markdown, không phải script này.
  if (!existsSync(file)) {
    writeFileSync(file, `${frontmatter(article)}\n${placeholderBody(article)}`);
    written += 1;
  } else {
    skipped += 1;
  }

  const coverPath = join(appRoot, CONTENT, 'assets', article.cover);
  if (!existsSync(coverPath)) {
    writeFileSync(coverPath, renderCover(article));
    covers += 1;
  }
}

console.log(
  `articles: ${written} written, ${skipped} untouched; covers: ${covers} written; contract: ${CURRICULUM.length}`,
);
