import { Texture } from 'pixi.js';
import { TILE_W } from '../core/constants';
import { FACILITY_COUNT } from '../sim/buildings';
import { FACILITY_SPECS } from '../sim/facilities';
import { FAC_AIRPORT, FAC_COMM_TOWER, FAC_HARBOR, FAC_PRISON } from '../sim/config/special';

export const FACILITY_ATLAS_URL = 'sprites/facilities.png';

export function facilityCellSize(span: number): number {
  return span * TILE_W;
}

export function facilityBandY(span: number): number {
  let y = 0;
  for (let s = 1; s < span; s++) y += facilityCellSize(s);
  return y;
}

/**
 * kind -> fixed column inside its span band. Existing 0~16 positions are unchanged.
 * New STEP 4.6 cells are appended to unused columns only.
 */
export const FACILITY_ATLAS_COLUMN: readonly number[] = [
  0, 1, 0, 1, 0, 2, 2, 3, 4, 5, 3, 6, 4, 5, 6, 7, 7,
  1, 8, 9, 10,
];

function bandColumns(span: number): number {
  let n = 0;
  for (let kind = 0; kind < FACILITY_COUNT; kind++) {
    if (FACILITY_SPECS[kind].span === span) n++;
  }
  return n;
}

export const FACILITY_ATLAS_W = (() => {
  let w = 0;
  for (let span = 1; span <= 3; span++) {
    w = Math.max(w, bandColumns(span) * facilityCellSize(span));
  }
  return w;
})();
export const FACILITY_ATLAS_H = facilityBandY(3) + facilityCellSize(3);

export interface FacilityAtlas {
  texture: Texture;
  placeholder: boolean;
  uv(kind: number): [number, number, number, number];
}

export async function loadFacilityAtlas(): Promise<FacilityAtlas> {
  const art = await loadImage(FACILITY_ATLAS_URL);
  const placeholder = art === null;

  const canvas = document.createElement('canvas');
  canvas.width = FACILITY_ATLAS_W;
  canvas.height = FACILITY_ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 캔버스를 만들 수 없습니다');
  ctx.imageSmoothingEnabled = false;

  if (art) ctx.drawImage(art, 0, 0);
  else drawPlaceholders(ctx);
  drawWaterFacilities(ctx);
  drawPowerFacilities(ctx);
  drawSanitationFacilities(ctx);
  drawSpecialFacilities(ctx);

  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  texture.source.autoGenerateMipmaps = false;

  const w = canvas.width;
  const h = canvas.height;
  return {
    texture,
    placeholder,
    uv(kind) {
      const span = FACILITY_SPECS[kind].span;
      const size = facilityCellSize(span);
      const x = FACILITY_ATLAS_COLUMN[kind] * size;
      const y = facilityBandY(span);
      return [x / w, y / h, (x + size) / w, (y + size) / h];
    },
  };
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || !(head.headers.get('content-type') ?? '').startsWith('image')) return null;
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve(
        (img.naturalWidth === FACILITY_ATLAS_W || img.naturalWidth === 576) &&
          img.naturalHeight === FACILITY_ATLAS_H
          ? img
          : null,
      );
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const BODY: readonly (readonly [string, string, string])[] = [
  ['#e8705f', '#c25446', '#933a30'],
  ['#6f8fd8', '#4f6cb4', '#374d87'],
  ['#e8e2dc', '#c4bdb6', '#948d87'],
  ['#e0b25f', '#b98f45', '#8c6a2f'],
  ['#7fca85', '#5da466', '#3f7c4b'],
  ['#6bc07a', '#4b9c5c', '#337742'],
  ['#5fbfb0', '#419a8d', '#2c766a'],
];

function drawPlaceholders(ctx: CanvasRenderingContext2D): void {
  for (let kind = 0; kind < 7; kind++) {
    const spec = FACILITY_SPECS[kind];
    const size = facilityCellSize(spec.span);
    const ox = FACILITY_ATLAS_COLUMN[kind] * size;
    const oy = facilityBandY(spec.span);
    const groundH = size / 2;
    const body = groundH * (spec.welfare ? 0.3 : 0.7);
    drawFacility(ctx, ox, oy, size, groundH, body, BODY[kind], spec.welfare);
  }
}

export function drawWaterFacilities(ctx: CanvasRenderingContext2D): void {
  const colors = ['#63c9ef', '#489cc7', '#9b755c', '#55b7a6'];
  for (let kind = 7; kind < 11; kind++) {
    const spec = FACILITY_SPECS[kind];
    const size = facilityCellSize(spec.span);
    const ox = FACILITY_ATLAS_COLUMN[kind] * size;
    const oy = facilityBandY(spec.span);
    const c = colors[kind - 7];
    drawFacility(ctx, ox, oy, size, size / 2, size * 0.16, [c, '#536d7c', '#344d5c'], false);
    const tanks = kind === 10 ? 3 : kind === 7 ? 1 : 2;
    for (let i = 0; i < tanks; i++) {
      const x = ox + size * (0.35 + i * 0.15);
      const y = oy + size * 0.55;
      ctx.fillStyle = '#253c47';
      ctx.beginPath();
      ctx.ellipse(x, y, size * 0.085, size * 0.046, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = kind === 9 ? '#705642' : c;
      ctx.beginPath();
      ctx.ellipse(x, y - 3, size * 0.065, size * 0.032, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = kind >= 9 ? '#b69068' : '#96e9ff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(ox + size * 0.5, oy + size * 0.71);
    ctx.lineTo(ox + size * 0.5, oy + size * 0.88);
    ctx.stroke();
  }
}

export function drawPowerFacilities(ctx: CanvasRenderingContext2D): void {
  for (let kind = 11; kind < 14; kind++) {
    const size = facilityCellSize(FACILITY_SPECS[kind].span);
    const ox = FACILITY_ATLAS_COLUMN[kind] * size;
    const oy = facilityBandY(FACILITY_SPECS[kind].span);
    drawFacility(ctx, ox, oy, size, size / 2, size * 0.12, ['#748c9d', '#52616d', '#36454e'], false);
    if (kind === 11) {
      const x = ox + size / 2;
      const y = oy + size * 0.35;
      ctx.strokeStyle = '#eff5fa';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, oy + size * 0.75);
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3;
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * size * 0.23, y + Math.sin(a) * size * 0.23);
      }
      ctx.stroke();
    } else if (kind === 12) {
      ctx.fillStyle = '#adb8c1';
      ctx.fillRect(ox + size * 0.55, oy + size * 0.2, size * 0.12, size * 0.37);
      ctx.fillStyle = '#df8657';
      ctx.fillRect(ox + size * 0.55, oy + size * 0.23, size * 0.12, size * 0.06);
    } else {
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 2; j++) {
          ctx.fillStyle = '#244d85';
          ctx.fillRect(
            ox + size * (0.23 + i * 0.18),
            oy + size * (0.47 + j * 0.09),
            size * 0.15,
            size * 0.07,
          );
          ctx.strokeStyle = '#8dbedf';
          ctx.lineWidth = 1;
          ctx.strokeRect(
            ox + size * (0.23 + i * 0.18),
            oy + size * (0.47 + j * 0.09),
            size * 0.15,
            size * 0.07,
          );
        }
    }
  }
}

export function drawSanitationFacilities(ctx: CanvasRenderingContext2D): void {
  for (let kind = 14; kind <= 16; kind++) {
    const size = facilityCellSize(FACILITY_SPECS[kind].span);
    const ox = FACILITY_ATLAS_COLUMN[kind] * size;
    const oy = facilityBandY(FACILITY_SPECS[kind].span);
    const cemetery = kind === 16;
    drawFacility(
      ctx,
      ox,
      oy,
      size,
      size / 2,
      size * (cemetery ? 0.015 : 0.16),
      cemetery
        ? ['#608c5a', '#496f46', '#365735']
        : kind === 14
          ? ['#ad9271', '#826a50', '#635342']
          : ['#c6b7a0', '#988978', '#736658'],
      cemetery,
    );
    if (cemetery) {
      for (let row = 0; row < 3; row++)
        for (let col = 0; col < 4; col++) {
          const x = ox + size * (0.3 + col * 0.1 + row * 0.025);
          const y = oy + size * (0.61 + row * 0.065);
          ctx.fillStyle = '#374c39';
          ctx.fillRect(x - 1, y + size * 0.02, size * 0.065, size * 0.025);
          ctx.fillStyle = '#d1d0c3';
          ctx.fillRect(x, y - size * 0.025, size * 0.04, size * 0.06);
        }
    } else {
      ctx.fillStyle = kind === 14 ? '#71594b' : '#a39686';
      ctx.fillRect(ox + size * 0.6, oy + size * 0.26, size * 0.07, size * 0.33);
      ctx.fillStyle = '#44382f';
      ctx.fillRect(ox + size * 0.59, oy + size * 0.25, size * 0.09, size * 0.025);
      ctx.fillStyle = kind === 14 ? '#df8940' : '#e6d9c7';
      ctx.fillRect(ox + size * 0.36, oy + size * 0.58, size * 0.1, size * 0.09);
      if (kind === 14) {
        ctx.fillStyle = '#65866a';
        for (let i = 0; i < 3; i++)
          ctx.fillRect(
            ox + size * (0.23 + i * 0.075),
            oy + size * 0.75,
            size * 0.055,
            size * 0.055,
          );
      }
    }
  }
}

/** STEP 4.6 runtime art. Existing facilities.png does not need to be replaced. */
export function drawSpecialFacilities(ctx: CanvasRenderingContext2D): void {
  drawCommunicationTower(ctx);
  drawAirport(ctx);
  drawHarbor(ctx);
  drawPrison(ctx);
}

function cell(kind: number): { size: number; ox: number; oy: number } {
  const size = facilityCellSize(FACILITY_SPECS[kind].span);
  return {
    size,
    ox: FACILITY_ATLAS_COLUMN[kind] * size,
    oy: facilityBandY(FACILITY_SPECS[kind].span),
  };
}

function drawCommunicationTower(ctx: CanvasRenderingContext2D): void {
  const { size, ox, oy } = cell(FAC_COMM_TOWER);
  drawFacility(ctx, ox, oy, size, size / 2, size * 0.05, ['#8c969c', '#68747a', '#4e5b61'], false);
  const cx = ox + size / 2;
  const top = oy + size * 0.16;
  const bottom = oy + size * 0.73;
  ctx.strokeStyle = '#d7dee2';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx - size * 0.12, bottom);
  ctx.moveTo(cx, top);
  ctx.lineTo(cx + size * 0.12, bottom);
  ctx.moveTo(cx - size * 0.09, oy + size * 0.58);
  ctx.lineTo(cx + size * 0.09, oy + size * 0.58);
  ctx.moveTo(cx - size * 0.06, oy + size * 0.42);
  ctx.lineTo(cx + size * 0.06, oy + size * 0.42);
  ctx.stroke();
  ctx.fillStyle = '#f2b94b';
  ctx.fillRect(cx - 2, top - 4, 4, 4);
}

function drawAirport(ctx: CanvasRenderingContext2D): void {
  const { size, ox, oy } = cell(FAC_AIRPORT);
  drawFacility(ctx, ox, oy, size, size / 2, size * 0.08, ['#c9d1d5', '#8e9ba2', '#65747b'], false);
  ctx.fillStyle = '#333b40';
  ctx.fillRect(ox + size * 0.19, oy + size * 0.58, size * 0.62, size * 0.09);
  ctx.fillStyle = '#eef2e5';
  for (let i = 0; i < 7; i++)
    ctx.fillRect(ox + size * (0.23 + i * 0.075), oy + size * 0.62, size * 0.04, size * 0.012);
  ctx.fillStyle = '#9eb4c4';
  ctx.fillRect(ox + size * 0.37, oy + size * 0.43, size * 0.26, size * 0.09);
  ctx.fillStyle = '#e4e8ea';
  ctx.fillRect(ox + size * 0.53, oy + size * 0.27, size * 0.035, size * 0.2);
  ctx.fillRect(ox + size * 0.47, oy + size * 0.32, size * 0.15, size * 0.025);
}

function drawHarbor(ctx: CanvasRenderingContext2D): void {
  const { size, ox, oy } = cell(FAC_HARBOR);
  drawFacility(ctx, ox, oy, size, size / 2, size * 0.06, ['#ab9678', '#7e705b', '#5e5547'], false);
  ctx.fillStyle = '#315f7c';
  ctx.fillRect(ox + size * 0.56, oy + size * 0.62, size * 0.2, size * 0.08);
  const containers = ['#b9604a', '#5c7893', '#c59847'];
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = containers[i % containers.length];
    ctx.fillRect(ox + size * (0.25 + (i % 3) * 0.11), oy + size * (0.57 + Math.floor(i / 3) * 0.06), size * 0.09, size * 0.045);
  }
  ctx.strokeStyle = '#d5c06a';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(ox + size * 0.63, oy + size * 0.35);
  ctx.lineTo(ox + size * 0.63, oy + size * 0.6);
  ctx.lineTo(ox + size * 0.79, oy + size * 0.46);
  ctx.stroke();
}

function drawPrison(ctx: CanvasRenderingContext2D): void {
  const { size, ox, oy } = cell(FAC_PRISON);
  drawFacility(ctx, ox, oy, size, size / 2, size * 0.12, ['#a9abad', '#7b7e80', '#595d60'], false);
  ctx.strokeStyle = '#d6d7d5';
  ctx.lineWidth = 3;
  ctx.strokeRect(ox + size * 0.24, oy + size * 0.48, size * 0.52, size * 0.24);
  ctx.fillStyle = '#4c5356';
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 5; col++)
      ctx.fillRect(ox + size * (0.31 + col * 0.085), oy + size * (0.53 + row * 0.075), size * 0.045, size * 0.03);
  ctx.fillStyle = '#858a8d';
  ctx.fillRect(ox + size * 0.24, oy + size * 0.38, size * 0.07, size * 0.18);
  ctx.fillRect(ox + size * 0.69, oy + size * 0.38, size * 0.07, size * 0.18);
}

function drawFacility(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  size: number,
  groundH: number,
  body: number,
  colors: readonly [string, string, string],
  welfare: boolean,
): void {
  const cxm = ox + size / 2;
  const bottomY = oy + size;
  const midY = bottomY - groundH / 2;
  const topY = bottomY - groundH;
  const left = ox;
  const right = ox + size;
  const inset = size <= 64 ? 4 : 6;
  const k = 1 - (inset * 2) / size;
  const dx = (size / 2) * k;
  const dy = (groundH / 2) * k;
  const roofY = midY - body;

  ctx.fillStyle = welfare ? 'rgba(88,150,92,0.85)' : 'rgba(104,110,116,0.85)';
  ctx.beginPath();
  ctx.moveTo(cxm, topY + 1);
  ctx.lineTo(right - 1, midY);
  ctx.lineTo(cxm, bottomY - 1);
  ctx.lineTo(left + 1, midY);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = colors[1];
  ctx.beginPath();
  ctx.moveTo(cxm, midY + dy);
  ctx.lineTo(cxm + dx, midY);
  ctx.lineTo(cxm + dx, midY - body);
  ctx.lineTo(cxm, midY + dy - body);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = colors[2];
  ctx.beginPath();
  ctx.moveTo(cxm, midY + dy);
  ctx.lineTo(cxm - dx, midY);
  ctx.lineTo(cxm - dx, midY - body);
  ctx.lineTo(cxm, midY + dy - body);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = colors[0];
  ctx.beginPath();
  ctx.moveTo(cxm, roofY - dy);
  ctx.lineTo(cxm + dx, roofY);
  ctx.lineTo(cxm, roofY + dy);
  ctx.lineTo(cxm - dx, roofY);
  ctx.closePath();
  ctx.fill();

  if (welfare) {
    ctx.fillStyle = 'rgba(38,92,48,0.85)';
    const trunk = Math.max(2, size * 0.03);
    for (const [tx, ty] of [[-0.35, 0.1], [0.3, -0.05], [0.05, 0.3]] as const) {
      const px = cxm + dx * tx;
      const py = midY + dy * ty;
      ctx.beginPath();
      ctx.ellipse(px, py - body - trunk * 2, trunk * 2.2, trunk * 1.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = 'rgba(20,26,32,0.42)';
    const floors = size >= 192 ? 4 : 2;
    for (let f = 0; f < floors; f++) {
      const t = (f + 0.6) / (floors + 0.2);
      const y = midY - body * t;
      const w = Math.max(2, dx * 0.5);
      ctx.fillRect(cxm + dx * 0.25, y - Math.max(1, body * 0.06), w * 0.6, Math.max(2, body * 0.09));
      ctx.fillRect(cxm - dx * 0.25 - w * 0.6, y - Math.max(1, body * 0.06), w * 0.6, Math.max(2, body * 0.09));
    }
  }

  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.moveTo(cxm, topY + 1);
  ctx.lineTo(right - 1, midY);
  ctx.lineTo(cxm, bottomY - 1);
  ctx.lineTo(left + 1, midY);
  ctx.closePath();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}
