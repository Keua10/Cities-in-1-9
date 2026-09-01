import './style.css';
import { Application } from 'pixi.js';
import {
  BASE_CHUNK_SPAN,
  CHUNK_SIZE,
  DEFAULT_ZOOM,
  TILE_HH,
  TILE_HW,
} from './core/constants';
import { Camera } from './core/camera';
import { attachInput } from './core/input';
import { chunkIndexOf, tileToWorldX, tileToWorldY } from './core/iso';
import { pickTile } from './core/pick';
import { loadTileAtlas } from './render/atlas';
import { WorldRenderer } from './render/worldRenderer';
import { Hud } from './ui/hud';
import { findDryTileNearBase, World } from './world/world';

/** 카메라가 base 밖으로 나갈 수 있는 거리(청크). 이웃의 안개까지는 보이게 둔다. */
const ROAM_CHUNKS = 8;

async function boot(): Promise<void> {
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: '#0e1418',
    antialias: false,
    // 아이패드 레티나에서 해상도를 3배까지 올리면 픽셀 수가 9배가 된다. 2 로 자른다.
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    powerPreference: 'high-performance',
    preference: 'webgl',
  });
  document.body.appendChild(app.canvas);

  // 1단계에서 로그인한 학생의 도시 번호로 바꾼다. 지금은 0번 도시 고정.
  const world = new World(0);
  const atlas = await loadTileAtlas();
  const renderer = new WorldRenderer(world, atlas);
  app.stage.addChild(renderer.root);

  const camera = new Camera();
  camera.resize(app.screen.width, app.screen.height);
  camera.zoom = DEFAULT_ZOOM;
  camera.limit = roamLimit(world);

  const start = findDryTileNearBase(world);
  const centerCamera = (): void => {
    camera.zoom = DEFAULT_ZOOM;
    camera.centerOnWorld(
      tileToWorldX(start.tx, start.ty),
      tileToWorldY(start.tx, start.ty, world.getHeight(start.tx, start.ty)),
    );
  };
  centerCamera();

  const hud = new Hud();
  let cursor: { tx: number; ty: number } | null = null;

  attachInput(app.canvas, camera, {
    onTap: (wx, wy) => {
      cursor = pickTile(world, wx, wy);
      renderer.setCursorTile(cursor);
    },
    onHover: (wx, wy) => {
      cursor = pickTile(world, wx, wy);
      renderer.setCursorTile(cursor);
    },
    onHoverEnd: () => {
      cursor = null;
      renderer.setCursorTile(null);
    },
  });

  app.renderer.on('resize', (w: number, h: number) => {
    camera.resize(w, h);
  });

  bindToolbar(renderer, centerCamera);

  app.ticker.add((ticker) => {
    const now = performance.now();
    camera.update(ticker.deltaMS);
    camera.applyTo(renderer.root);
    renderer.update(camera, now);
    renderer.flush();

    hud.update(now, {
      fps: ticker.FPS,
      zoom: camera.zoom,
      tile: cursor,
      terrain: cursor ? world.getTile(cursor.tx, cursor.ty) : null,
      height: cursor ? world.getHeight(cursor.tx, cursor.ty) : null,
      chunk: cursor
        ? { cx: chunkIndexOf(cursor.tx), cy: chunkIndexOf(cursor.ty) }
        : null,
      visibleChunks: renderer.stats.visibleChunks,
      loadedMeshes: renderer.stats.loadedMeshes,
      placeholderArt: atlas.placeholder,
    });
  });

  document.getElementById('loading')?.classList.add('done');
}

function roamLimit(world: World): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const t0x = (world.baseCx - ROAM_CHUNKS) * CHUNK_SIZE;
  const t0y = (world.baseCy - ROAM_CHUNKS) * CHUNK_SIZE;
  const t1x = (world.baseCx + BASE_CHUNK_SPAN + ROAM_CHUNKS) * CHUNK_SIZE;
  const t1y = (world.baseCy + BASE_CHUNK_SPAN + ROAM_CHUNKS) * CHUNK_SIZE;
  return {
    minX: tileToWorldX(t0x, t1y) - TILE_HW,
    maxX: tileToWorldX(t1x, t0y) + TILE_HW,
    minY: tileToWorldY(t0x, t0y) - TILE_HH,
    maxY: tileToWorldY(t1x, t1y) + TILE_HH,
  };
}

function bindToolbar(renderer: WorldRenderer, centerCamera: () => void): void {
  const fogBtn = document.getElementById('btn-fog');
  const gridBtn = document.getElementById('btn-grid');
  const centerBtn = document.getElementById('btn-center');

  fogBtn?.setAttribute('aria-pressed', String(renderer.showFog));
  gridBtn?.setAttribute('aria-pressed', String(renderer.showGrid));

  fogBtn?.addEventListener('click', () => {
    renderer.showFog = !renderer.showFog;
    fogBtn.setAttribute('aria-pressed', String(renderer.showFog));
  });
  gridBtn?.addEventListener('click', () => {
    renderer.showGrid = !renderer.showGrid;
    gridBtn.setAttribute('aria-pressed', String(renderer.showGrid));
    renderer.forceRedraw();
  });
  centerBtn?.addEventListener('click', centerCamera);
}

boot().catch((err: unknown) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = '지도를 불러오지 못했습니다. 새로고침 해주세요.';
});
