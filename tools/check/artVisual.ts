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
interface CandidateInfo {
  id: string;
  level: number;
  zone: number;
  variant: number;
  mode: 'source-preserved' | 'restored' | 'new-pixel';
  colors: number;
  centerError: number;
}
const candidateManifests = await Promise.all(
    ['/sprites/candidates/manifest.json', '/sprites/candidates/generated-manifest.json'].map(
      async (path) => (await (await fetch(path)).json()) as CandidateInfo[],
    ),
  ),
  normalizedCandidates = candidateManifests
    .flat()
    .sort((a, b) => a.level - b.level || a.zone - b.zone || a.variant - b.variant)
    .map((candidate) => {
      const image = new Image();
      image.src = `/sprites/candidates/${candidate.id}.png?v=complete-36`;
      return { ...candidate, label: ['주거', '상업', '공업'][candidate.zone], image };
    });
for (const { image } of normalizedCandidates)
  image.onload = () => {
    render();
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
    const variantLabel = String.fromCharCode(65 + candidate.variant),
      modeLabel =
        candidate.mode === 'restored'
          ? '절단 복원'
          : candidate.mode === 'source-preserved'
            ? '원본 규격화'
            : '신규 도트';
    card(
      buildingArt(level, candidate.zone, candidate.variant),
      `이전 코드 도형 ${candidate.label} L${level}-${variantLabel}`,
      '교체 전 코드 생성 그래픽 · 비교용',
    );
    rasterCard(
      candidate.image,
      `${modeLabel} ${candidate.label} L${level}-${variantLabel}`,
      `${level * 64}×${level * 64} · ${candidate.colors}색 · 픽셀 보간 없음 · 바닥 중심 오차 ${candidate.centerError}px`,
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
        rasterCard(
          normalizedCandidates.find(
            (candidate) =>
              candidate.level === level && candidate.zone === filter && candidate.variant === v,
          )!.image,
          BUILDING_NAMES[filter][level - 1][v],
          `L${level} · ${level}×${level} 타일 · ${level * 64}px 셀`,
          level * 64,
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
  '완성 픽셀 비교 L1 12종',
  '완성 픽셀 비교 L2 12종',
  '완성 픽셀 비교 L3 12종',
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
