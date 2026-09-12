import { buildingArt, BUILDING_NAMES } from '../../src/render/buildingArt';
import { facilityArt } from '../../src/render/facilityArt';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import type { PixelArt } from '../../src/render/pixelArt';
import {
  ATLAS_CELL_COUNT,
  CIVIC_CELL_BASE,
  drawCivicCells,
  drawRoadCells,
  drawZoneCells,
  ROAD_CELL_BASE,
  ROAD_CELL_COUNT,
  ZONE_CELL_BASE,
  ZONE_CELL_COUNT,
} from '../../src/render/atlas';
import {
  ATLAS_CELL_H,
  ATLAS_CELL_W,
  ATLAS_COLUMNS,
  ATLAS_PAD,
  TILE_H,
  TILE_W,
} from '../../src/core/constants';

const gallery = document.getElementById('gallery')!;
let filter = 0,
  zoom = 1;
function card(a: PixelArt, name: string, description: string): void {
  const article = document.createElement('article'),
    canvas = document.createElement('canvas');
  canvas.width = canvas.height = a.size;
  canvas.style.width = canvas.style.height = `${a.size * zoom}px`;
  a.paint(canvas.getContext('2d')!);
  const title = document.createElement('h2');
  title.textContent = name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = description;
  article.append(canvas, title, meta);
  gallery.append(article);
}
const CANDIDATE_INFO = [
  ['residential-l1-a', 1, 0, 0, '주거', 125, '0px', false],
  ['residential-l1-b', 1, 0, 1, '주거', 125, '0px', false],
  ['commercial-l1-a', 1, 1, 0, '상업', 126, '0.5px', false],
  ['commercial-l1-b', 1, 1, 1, '상업', 126, '0.5px', false],
  ['industrial-l1-a', 1, 2, 0, '공업', 115, '0px', false],
  ['industrial-l1-b', 1, 2, 1, '공업', 123, '0.5px', false],
  ['residential-l2-a', 2, 0, 0, '주거', 159, '0.5px', false],
  ['residential-l2-b', 2, 0, 1, '주거', 159, '0px', false],
  ['commercial-l2-a', 2, 1, 0, '상업', 160, '0px', false],
  ['commercial-l2-b', 2, 1, 1, '상업', 159, '0px', false],
  ['industrial-l2-a', 2, 2, 0, '공업', 157, '0.5px', false],
  ['industrial-l2-b', 2, 2, 1, '공업', 159, '0.5px', false],
  ['residential-l3-a', 3, 0, 0, '주거', 191, '0px', false],
  ['residential-l3-b', 3, 0, 1, '주거', 222, '0px', true],
  ['commercial-l3-a', 3, 1, 0, '상업', 204, '0.5px', true],
  ['commercial-l3-b', 3, 1, 1, '상업', 192, '0.5px', false],
  ['industrial-l3-a', 3, 2, 0, '공업', 229, '0px', true],
  ['industrial-l3-b', 3, 2, 1, '공업', 191, '0px', false],
] as const;
const normalizedCandidates = CANDIDATE_INFO.map(
  ([id, level, zone, variant, label, colors, error, restored]) => {
    const image = new Image();
    image.src = `/sprites/candidates/${id}.png?v=normalized-3`;
    return { id, level, zone, variant, label, colors, error, restored, image };
  },
);
for (const { image } of normalizedCandidates)
  image.onload = () => {
    if (filter >= 5) render();
  };

function rasterCard(
  image: HTMLImageElement,
  name: string,
  description: string,
  size = 64,
  sourceX = 0,
  sourceY = 0,
): void {
  const article = document.createElement('article'),
    canvas = document.createElement('canvas'),
    ctx = canvas.getContext('2d')!;
  canvas.width = canvas.height = size;
  canvas.style.width = canvas.style.height = `${size * zoom}px`;
  ctx.imageSmoothingEnabled = false;
  if (image.complete && image.naturalWidth)
    ctx.drawImage(image, sourceX, sourceY, size, size, 0, 0, size, size);
  const title = document.createElement('h2');
  title.textContent = name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = description;
  article.append(canvas, title, meta);
  gallery.append(article);
}
const atlas = document.createElement('canvas');
atlas.width = ATLAS_COLUMNS * ATLAS_CELL_W;
atlas.height = Math.ceil(ATLAS_CELL_COUNT / ATLAS_COLUMNS) * ATLAS_CELL_H;
const atlasCtx = atlas.getContext('2d')!;
atlasCtx.imageSmoothingEnabled = false;
drawRoadCells(atlasCtx);
drawZoneCells(atlasCtx);
drawCivicCells(atlasCtx);

function surfaceCard(index: number, name: string, description: string): void {
  const article = document.createElement('article'),
    canvas = document.createElement('canvas'),
    ctx = canvas.getContext('2d')!,
    sx = (index % ATLAS_COLUMNS) * ATLAS_CELL_W + ATLAS_PAD,
    sy = Math.floor(index / ATLAS_COLUMNS) * ATLAS_CELL_H + ATLAS_PAD;
  article.className = 'surface';
  canvas.width = TILE_W;
  canvas.height = TILE_H;
  canvas.style.width = `${TILE_W * zoom}px`;
  canvas.style.height = `${TILE_H * zoom}px`;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(atlas, sx, sy, TILE_W, TILE_H, 0, 0, TILE_W, TILE_H);
  const title = document.createElement('h2');
  title.textContent = name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = description;
  article.append(canvas, title, meta);
  gallery.append(article);
}

const ROAD_DIRECTIONS = ['우하', '좌하', '좌상', '우상'];
function roadName(mask: number): string {
  const directions = ROAD_DIRECTIONS.filter((_, direction) => mask & (1 << direction));
  return directions.length ? directions.join(' · ') : '고립 도로';
}

function surfaceGallery(): void {
  for (let mask = 0; mask < ROAD_CELL_COUNT; mask++)
    surfaceCard(ROAD_CELL_BASE + mask, roadName(mask), `도로 연결 마스크 ${mask}`);
  for (let state = 0; state < ZONE_CELL_COUNT; state++) {
    const zone = Math.floor(state / 2),
      hasRoad = state % 2 === 1;
    surfaceCard(
      ZONE_CELL_BASE + state,
      `${['주거', '상업', '공업'][zone]} · ${hasRoad ? '도로 접함' : '도로 없음'}`,
      '64×32 타일 · 기능 아이콘과 접근 상태 눈금',
    );
  }
  surfaceCard(CIVIC_CELL_BASE, '공공 바닥 · 도로 없음', '시설 연결이 끊긴 상태');
  surfaceCard(CIVIC_CELL_BASE + 1, '공공 바닥 · 도로 접함', '정상 운영 가능한 상태');
}

function candidateComparison(level: number): void {
  for (const candidate of normalizedCandidates.filter((item) => item.level === level)) {
    card(
      buildingArt(level, candidate.zone, candidate.variant),
      `현재 ${candidate.label} L${level}-${candidate.variant ? 'B' : 'A'}`,
      '현재 게임 적용본 · 단순 40색 코드 도형',
    );
    rasterCard(
      candidate.image,
      `${candidate.restored ? '절단 복원' : '원본 규격화'} ${candidate.label} L${level}-${candidate.variant ? 'B' : 'A'}`,
      `${level * 64}×${level * 64} · ${candidate.colors}색 · ${candidate.restored ? '잘린 소품 복원·재규격화' : '리스케일/재색칠 없음'} · 바닥 중심 오차 ${candidate.error}`,
      level * 64,
    );
  }
}
function render(): void {
  gallery.replaceChildren();
  const maxNativeSize =
    filter < 3
      ? 192
      : filter === 3
        ? Math.max(...FACILITY_SPECS.map((spec) => spec.span * 64))
        : filter === 4
          ? 64
          : (filter - 4) * 64;
  const minimumCardWidth = Math.max(240, maxNativeSize * zoom + 32);
  gallery.style.gridTemplateColumns = `repeat(auto-fit, minmax(min(100%, ${minimumCardWidth}px), 1fr))`;
  if (filter < 3)
    for (let level = 1; level <= 3; level++)
      for (let v = 0; v < 4; v++)
        card(
          buildingArt(level, filter, v),
          BUILDING_NAMES[filter][level - 1][v],
          `L${level} · ${level}×${level} 타일 · ${level * 64}px 셀`,
        );
  else if (filter === 3)
    for (const s of FACILITY_SPECS)
      card(facilityArt(s.kind), s.name, `${s.span}×${s.span} 타일 · ${s.span * 64}px 셀`);
  else if (filter === 4) surfaceGallery();
  else candidateComparison(filter - 4);
  document
    .querySelectorAll<HTMLButtonElement>('[data-filter]')
    .forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.filter) === filter)));
  document
    .querySelectorAll<HTMLButtonElement>('[data-zoom]')
    .forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.zoom) === zoom)));
}
[
  '주거 12종',
  '상업 12종',
  '공업 12종',
  '특수 시설 26종',
  '도로·지구 24종',
  '원본 규격화 L1 6종',
  '원본 규격화 L2 6종',
  '원본 규격화 L3 6종',
].forEach((name, i) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.dataset.filter = String(i);
  b.onclick = () => {
    filter = i;
    render();
  };
  document.getElementById('filters')!.append(b);
});
for (const z of [0.5, 1, 2]) {
  const b = document.createElement('button');
  b.textContent = `${z * 100}%`;
  b.dataset.zoom = String(z);
  b.onclick = () => {
    zoom = z;
    render();
  };
  document.getElementById('zoom')!.append(b);
}
render();
