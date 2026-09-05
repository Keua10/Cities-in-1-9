import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../core/constants';
import { ZONE_C, ZONE_I, ZONE_R } from '../sim/buildings';
import { Build } from './build';
import { isWater } from './terrain';
import type { World } from './world';

/**
 * 테스트가 빈 맵에서 시작하지 않게 만드는 아주 작은 결정론적 샘플 도시.
 * 저장된 도로/지구가 하나라도 있으면 절대 손대지 않는다.
 */
export function seedTestCityIfEmpty(world: World, bornDay = 0): { tx: number; ty: number } | null {
  if (world.developedParcels().length > 0) return null;

  const origin = findDryRect(world, 20, 20);
  if (!origin) return null;

  const ox = origin.tx;
  const oy = origin.ty;
  const roads = new Set([4, 10, 16]);

  // 20x20 안에 3x3 격자 도로와 R/C/I 지구를 만든다.
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const tx = ox + x;
      const ty = oy + y;
      if (roads.has(x) || roads.has(y)) {
        world.setBuild(tx, ty, Build.Road, false);
        continue;
      }

      // 왼쪽은 주거, 오른쪽 위는 상업, 오른쪽 아래는 공업.
      let build: number = Build.ZoneR;
      if (x > 10 && y < 10) build = Build.ZoneC;
      else if (x > 10 && y > 10) build = Build.ZoneI;
      else if (x > 4 && x < 10 && y > 10) build = Build.ZoneC;
      world.setBuild(tx, ty, build, false);
    }
  }

  // 첫 접속부터 차량이 보이도록 일부 건물은 즉시 넣는다.
  const homes: Array<[number, number, number]> = [
    [1, 3, 1], [2, 5, 1], [5, 2, 2], [7, 5, 1],
    [2, 8, 1], [5, 7, 2], [8, 8, 1], [2, 12, 1],
    [5, 13, 2], [8, 14, 1],
  ];
  const shops: Array<[number, number, number]> = [
    [12, 2, 2], [15, 5, 1], [18, 7, 1], [7, 12, 2], [8, 15, 1],
  ];
  const industry: Array<[number, number, number]> = [
    [12, 12, 2], [15, 14, 1], [18, 18, 1], [12, 17, 1],
  ];

  place(world, ox, oy, homes, ZONE_R, bornDay);
  place(world, ox, oy, shops, ZONE_C, bornDay);
  place(world, ox, oy, industry, ZONE_I, bornDay);

  return { tx: ox + 10, ty: oy + 10 };
}

function place(
  world: World,
  ox: number,
  oy: number,
  specs: readonly [number, number, number][],
  zone: number,
  bornDay: number,
): void {
  for (const [x, y, level] of specs) {
    const tx = ox + x;
    const ty = oy + y;
    if (!footprintMatchesZone(world, tx, ty, level, zone)) continue;
    world.placeBuilding(tx, ty, zone, level, bornDay);
  }
}

function footprintMatchesZone(world: World, tx: number, ty: number, level: number, zone: number): boolean {
  const wanted = zone === ZONE_R ? Build.ZoneR : zone === ZONE_C ? Build.ZoneC : Build.ZoneI;
  for (let dy = 0; dy < level; dy++) {
    for (let dx = 0; dx < level; dx++) {
      if (world.getBuild(tx + dx, ty + dy) !== wanted) return false;
    }
  }
  return true;
}

function findDryRect(world: World, w: number, h: number): { tx: number; ty: number } | null {
  const baseX = world.baseCx * CHUNK_SIZE;
  const baseY = world.baseCy * CHUNK_SIZE;
  const span = BASE_CHUNK_SPAN * CHUNK_SIZE;
  const centerX = baseX + Math.floor(span / 2);
  const centerY = baseY + Math.floor(span / 2);

  // 중앙에서 바깥으로 4타일 간격으로 후보를 본다. 테스트 시 1회만 돈다.
  for (let radius = 0; radius < span / 2 - Math.max(w, h); radius += 4) {
    for (let dy = -radius; dy <= radius; dy += 4) {
      for (let dx = -radius; dx <= radius; dx += 4) {
        if (radius > 0 && Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const ox = centerX + dx - Math.floor(w / 2);
        const oy = centerY + dy - Math.floor(h / 2);
        if (isDryRect(world, ox, oy, w, h)) return { tx: ox, ty: oy };
      }
    }
  }
  return null;
}

function isDryRect(world: World, ox: number, oy: number, w: number, h: number): boolean {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isWater(world.getTile(ox + x, oy + y))) return false;
    }
  }
  return true;
}
