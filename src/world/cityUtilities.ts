import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../core/constants';
import {
  capacityOf,
  facilityKindOfCode,
  isAnchor,
  isFacilityAnchor,
  levelOfCode,
  zoneOfCode,
} from '../sim/buildings';
import { FAC_GAS, facilityPowerDemand } from '../sim/config/power';
import { FAC_GROUNDWATER, FAC_TREATMENT } from '../sim/config/water';
import { FAC_INCINERATOR, FAC_CREMATORIUM, FAC_CEMETERY } from '../sim/config/sanitation';
import {
  canPlaceFacility,
  FACILITY_SPECS,
  touchesRoadTiles,
  touchesWater,
} from '../sim/facilities';
import { edgeNeighbors } from '../sim/roadGraph';
import { Build } from './build';
import { Terrain, isWater } from './terrain';
import type { World } from './world';

/** New-city bootstrap only. Existing saves never enter this path. */
export function seedCityUtilities(world: World, bornDay: number): void {
  const size = BASE_CHUNK_SPAN * CHUNK_SIZE,
    ox = world.baseCx * CHUNK_SIZE,
    oy = world.baseCy * CHUNK_SIZE;
  let demand = 0,
    civicDemand = 0;
  for (const p of world.developedParcels())
    if (p.bld)
      for (const code of p.bld) {
        if (isAnchor(code)) demand += capacityOf(zoneOfCode(code), levelOfCode(code));
        else if (isFacilityAnchor(code))
          civicDemand += facilityPowerDemand(facilityKindOfCode(code));
      }
  const waterCount = Math.max(1, Math.ceil((demand * 1.15) / 1000));
  const sewerCount = Math.max(1, Math.ceil((demand * 1.15) / 5000));
  const powerCount = Math.max(
    1,
    Math.ceil(
      ((demand +
        9 * facilityPowerDemand(FAC_INCINERATOR) +
        5 * facilityPowerDemand(FAC_CREMATORIUM) +
        4 * facilityPowerDemand(FAC_CEMETERY) +
        civicDemand +
        waterCount * facilityPowerDemand(FAC_GROUNDWATER) +
        sewerCount * facilityPowerDemand(FAC_TREATMENT)) *
        1.25) /
        12000,
    ),
  );
  // Two separate comb networks: opposite trunks and staggered branches never touch.
  for (let y = 2; y < size - 2; y++) {
    world.setPipe(ox + 2, oy + y, 1);
    world.setPipe(ox + size - 3, oy + y, 2);
    world.setWire(ox + 2, oy + y, true);
  }
  for (let y = 6; y < size - 2; y += 8)
    for (let x = 2; x < size - 4; x++) world.setPipe(ox + x, oy + y, 1);
  for (let y = 10; y < size - 2; y += 8)
    for (let x = 4; x < size - 2; x++) world.setPipe(ox + x, oy + y, 2);
  for (let y = 3; y < size - 2; y += 6)
    for (let x = 2; x < size - 2; x++) world.setWire(ox + x, oy + y, true);

  // Use flat land beside the existing generated roads. Never strand a plant on a mountain/island.
  const candidates: Array<[number, number]> = [];
  for (let y = 4; y < size - 7; y++)
    for (let x = 4; x < size - 7; x++) candidates.push([ox + x, oy + y]);
  const boundaryDistance = (x: number, y: number) =>
    Math.min(x - ox, y - oy, ox + size - x, oy + size - y);
  candidates.sort(
    (a, b) => boundaryDistance(...a) - boundaryDistance(...b) || a[1] - b[1] || a[0] - b[0],
  );
  const plotFits = (x: number, y: number, span: number): boolean => {
    if (!touchesRoadTiles(world, x, y, span)) return false;
    const height = world.sampleHeight(x, y);
    for (let dy = 0; dy < span; dy++)
      for (let dx = 0; dx < span; dx++) {
        const build = world.getBuild(x + dx, y + dy);
        if (
          build === Build.Road ||
          build === Build.Civic ||
          isWater(world.getTile(x + dx, y + dy)) ||
          world.sampleHeight(x + dx, y + dy) !== height
        )
          return false;
      }
    return true;
  };
  const install = (kind: number, count: number, near?: [number, number]): void => {
    let installed = 0;
    const span = FACILITY_SPECS[kind].span;
    const ordered = near
      ? [...candidates].sort(
          (a, b) =>
            Math.abs(a[0] - near[0]) +
            Math.abs(a[1] - near[1]) -
            (Math.abs(b[0] - near[0]) + Math.abs(b[1] - near[1])),
        )
      : candidates;
    for (const [x, y] of ordered) {
      if (installed >= count) break;
      if (!plotFits(x, y, span)) continue;
      let outlet: [number, number] | undefined;
      if (kind === FAC_TREATMENT && !touchesWater(world, x, y, span)) {
        // Inland cities get a small prepared effluent channel beside the treatment plant.
        outlet = [...edgeNeighbors(x, y, span)].find(
          ([tx, ty]) => world.getBuild(tx, ty) === Build.None && !world.buildingCovering(tx, ty),
        );
        if (!outlet) continue;
      }
      for (let dy = 0; dy < span; dy++)
        for (let dx = 0; dx < span; dx++) world.setBuild(x + dx, y + dy, Build.None, false);
      if (outlet) world.setTile(outlet[0], outlet[1], Terrain.WaterShallow);
      const result = canPlaceFacility(world, x, y, kind, 5);
      if (!result.ok)
        throw new Error(`생성 기반시설 ${FACILITY_SPECS[kind].name}: ${result.reason}`);
      world.placeFacility(x, y, kind, bornDay);
      installed++;
    }
    if (installed < count)
      throw new Error(`생성 도시 ${FACILITY_SPECS[kind].name} 부지가 부족합니다`);
  };
  const neighborhoods = [0.2, 0.5, 0.8].flatMap((fy) => [0.2, 0.5, 0.8].map((fx) => [fx, fy]));
  for (const [i, [fx, fy]] of neighborhoods.entries()) {
    const near: [number, number] = [ox + Math.floor(size * fx), oy + Math.floor(size * fy)];
    install(FAC_INCINERATOR, 1, near);
    install(i % 2 ? FAC_CEMETERY : FAC_CREMATORIUM, 1, near);
  }
  install(FAC_TREATMENT, sewerCount);
  install(FAC_GAS, powerCount);
  install(FAC_GROUNDWATER, waterCount);
}
