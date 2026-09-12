import { buildingArt, BUILDING_NAMES } from '../../src/render/buildingArt';
import { facilityArt } from '../../src/render/facilityArt';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import type { PixelArt } from '../../src/render/pixelArt';
import { BUILDING_CANDIDATES } from '../../src/render/buildingCandidates';
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
const legacyBuildings = new Image();
legacyBuildings.src = '/sprites/buildings.png';
legacyBuildings.onload = () => {
  if (filter === 5) render();
};

function legacyCard(): void {
  const article = document.createElement('article'),
    canvas = document.createElement('canvas'),
    ctx = canvas.getContext('2d')!;
  canvas.width = canvas.height = 64;
  canvas.style.width = canvas.style.height = `${64 * zoom}px`;
  ctx.imageSmoothingEnabled = false;
  if (legacyBuildings.complete && legacyBuildings.naturalWidth)
    ctx.drawImage(legacyBuildings, 0, 0, 64, 64, 0, 0, 64, 64);
  const title = document.createElement('h2');
  title.textContent = '원본 복원 후보 · 1단계 주거 A';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = '승인 시 게임에 복원하고 이후 변형의 품질 기준으로 사용';
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

function candidateComparison(): void {
  card(buildingArt(1, 0, 0), '현재 게임 버전', '비교용 · 현재 적용 중');
  legacyCard();
  for (const candidate of BUILDING_CANDIDATES)
    card(candidate.art(), candidate.name, `${candidate.description} · 아직 게임에는 미적용`);
}
function render(): void {
  gallery.replaceChildren();
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
  else candidateComparison();
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
  '주거 규격 후보 3종',
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
