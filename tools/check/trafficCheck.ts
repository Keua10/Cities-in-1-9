/**
 * 교통 규칙 검증기 (개발용, 게임 빌드에 포함되지 않는다)
 *
 *   npx esbuild tools/check/trafficCheck.ts --bundle --platform=node --format=esm \
 *     --alias:pixi.js=./tools/check/stub-pixi.ts --outfile=/tmp/trafficCheck.mjs
 *   node /tmp/trafficCheck.mjs
 *
 * 확인하는 것
 *   1. 교차로 검출 — 폭 2타일(4차로) 직선 구간이 교차로로 잡히지 않는가
 *   2. 신호 — 한 교차로 안의 모든 진입로가 같은 위상을 보는가, 동시에 녹색이 없는가
 *   3. 통행 우선순위 — 서로 교차하는 궤적이 동시에 통행권을 갖지 않는가
 *   4. 겹침 — 실제 시뮬레이션 수천 프레임 동안 차체가 한 번이라도 겹치는가
 *   5. 처리량 — 규칙을 세게 걸어놓고도 차가 실제로 목적지에 도착하는가
 */
import { CHUNK_SIZE } from '../../src/core/constants';
import { AssignmentTable } from '../../src/sim/assignment';
import { ZONE_C, ZONE_I, ZONE_R } from '../../src/sim/buildings';
import { CongestionMap } from '../../src/sim/congestion';
import { MacroSim } from '../../src/sim/macro';
import { INTERSECTION_STOP_T, START_MONEY } from '../../src/sim/simConstants';
import { JunctionIndex, TurnKind, turnKind } from '../../src/sim/traffic/junctions';
import { bodiesOverlap } from '../../src/sim/traffic/collision';
import {
  buildJunctionPath,
  IntersectionControl,
  pathsConflict,
  type Approach,
} from '../../src/sim/traffic/intersectionControl';
import { laneHeading, lanePosition } from '../../src/sim/traffic/laneGeometry';
import { SignalState, signalState } from '../../src/sim/traffic/signals';
import { TrafficSim } from '../../src/sim/traffic/trafficSim';
import type { Vehicle } from '../../src/sim/traffic/vehicles';
import { Build } from '../../src/world/build';
import { World } from '../../src/world/world';
import { isWater } from '../../src/world/terrain';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  OK   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ------------------------------------------------------------------ *
 * 1. 교차로 검출
 * ------------------------------------------------------------------ */

/** 도로만 있는 작은 시험용 월드. 지형은 건드리지 않는다. */
function roadWorld(paint: (set: (x: number, y: number) => void) => void): {
  world: World;
  ox: number;
  oy: number;
} {
  const world = new World(0);
  const ox = world.baseCx * CHUNK_SIZE + 8;
  const oy = world.baseCy * CHUNK_SIZE + 8;
  paint((x, y) => world.setBuild(ox + x, oy + y, Build.Road, false));
  return { world, ox, oy };
}

console.log('1. 교차로 검출');
{
  // 폭 2타일 가로도로(y=0,1) x 폭 2타일 세로도로(x=10,11).
  const { world, ox, oy } = roadWorld((set) => {
    for (let x = 0; x < 24; x++) {
      set(x, 0);
      set(x, 1);
    }
    for (let y = -10; y < 12; y++) {
      set(10, y);
      set(11, y);
    }
  });
  const index = new JunctionIndex();
  index.build(world, ox - 20, oy - 20, ox + 40, oy + 30);

  const straight = [2, 5, 8, 15, 20].every(
    (x) => index.idAt(ox + x, oy + 0) < 0 && index.idAt(ox + x, oy + 1) < 0,
  );
  check('4차로 직선 구간은 교차로가 아니다', straight);

  const ids = new Set<number>();
  for (const x of [10, 11]) for (const y of [0, 1]) ids.add(index.idAt(ox + x, oy + y));
  check(
    '4차로 x 4차로 교차로는 하나의 영역이다',
    ids.size === 1 && !ids.has(-1),
    `ids=${[...ids]}`,
  );

  const junction = index.at(ox + 10, oy + 0);
  check(
    '교차로 영역은 2x2 = 4칸이다',
    junction !== null && junction.cells.length === 8,
    `cells=${(junction?.cells.length ?? 0) / 2}`,
  );
  check('4갈래 교차로에 신호등이 선다', junction?.signalized === true);
  check('진입로 폭이 2로 잡힌다', junction?.maxLegWidth === 2, `w=${junction?.maxLegWidth}`);
}
{
  // 1차로 도로에 폭 2타일 도로가 붙는 T자.
  const { world, ox, oy } = roadWorld((set) => {
    for (let x = 0; x < 24; x++) {
      set(x, 0);
      set(x, 1);
    }
    for (let y = 2; y < 14; y++) set(10, y);
  });
  const index = new JunctionIndex();
  index.build(world, ox - 20, oy - 20, ox + 40, oy + 30);
  const a = index.idAt(ox + 10, oy + 0);
  const b = index.idAt(ox + 10, oy + 1);
  check('T자 교차로는 주도로 폭만큼(2칸) 잡힌다', a >= 0 && a === b);
  check('T자에도 신호등이 선다', index.byId(a)?.signalized === true);
  check(
    'T자 옆 칸은 교차로가 아니다',
    index.idAt(ox + 9, oy + 0) < 0 && index.idAt(ox + 12, oy + 1) < 0,
  );
}
{
  // 도로 옆에 한 칸만 튀어나온 진입로(차고지). 신호등이 서면 안 된다.
  const { world, ox, oy } = roadWorld((set) => {
    for (let x = 0; x < 24; x++) {
      set(x, 0);
      set(x, 1);
    }
    set(10, 2);
  });
  const index = new JunctionIndex();
  index.build(world, ox - 20, oy - 20, ox + 40, oy + 30);
  const j = index.at(ox + 10, oy + 1);
  check('한 칸짜리 진입로에는 신호등이 서지 않는다', j === null || !j.signalized);
}
{
  // 1차로 격자. 예전 규칙과 결과가 같아야 한다(교차점만 교차로).
  const { world, ox, oy } = roadWorld((set) => {
    for (let i = 0; i < 30; i++) {
      set(i, 6);
      set(6, i);
      set(i, 18);
      set(18, i);
    }
  });
  const index = new JunctionIndex();
  index.build(world, ox - 20, oy - 20, ox + 50, oy + 50);
  check(
    '1차로 격자: 교차점만 교차로다',
    index.idAt(ox + 6, oy + 6) >= 0 &&
      index.idAt(ox + 18, oy + 6) >= 0 &&
      index.idAt(ox + 10, oy + 6) < 0 &&
      index.idAt(ox + 6, oy + 12) < 0,
  );
  check('1차로 4갈래 교차로는 1칸이다', index.at(ox + 6, oy + 6)?.cells.length === 2);
}

/* ------------------------------------------------------------------ *
 * 2. 신호
 * ------------------------------------------------------------------ */

console.log('2. 신호');
{
  const { world, ox, oy } = roadWorld((set) => {
    for (let x = 0; x < 24; x++) {
      set(x, 0);
      set(x, 1);
    }
    for (let y = -10; y < 12; y++) {
      set(10, y);
      set(11, y);
    }
  });
  const index = new JunctionIndex();
  index.build(world, ox - 20, oy - 20, ox + 40, oy + 30);
  const junction = index.at(ox + 10, oy + 0)!;

  let bothGreen = 0;
  let axisSplit = 0;
  let anyGreen = 0;
  let allRed = 0;
  for (let t = 0; t < 60_000; t += 50) {
    const s0 = signalState(junction, 0, t);
    const s2 = signalState(junction, 2, t);
    const s1 = signalState(junction, 1, t);
    const s3 = signalState(junction, 3, t);
    if (s0 !== s2 || s1 !== s3) axisSplit++;
    if (s0 === SignalState.Green && s1 === SignalState.Green) bothGreen++;
    if (s0 === SignalState.Green || s1 === SignalState.Green) anyGreen++;
    if (s0 === SignalState.Red && s1 === SignalState.Red) allRed++;
  }
  check('마주 보는 진입로는 항상 같은 신호다', axisSplit === 0);
  check('직교하는 두 축이 동시에 녹색이 되지 않는다', bothGreen === 0);
  check('녹색 시간이 실제로 존재한다', anyGreen > 0);
  check('전적색(모두 빨강) 구간이 있다', allRed > 0);
}

/* ------------------------------------------------------------------ *
 * 3. 회전 분류와 궤적 충돌
 * ------------------------------------------------------------------ */

console.log('3. 회전/궤적');
{
  check('우측통행: +tx 에서 +ty 는 우회전', turnKind(0, 1) === TurnKind.Right);
  check('우측통행: +tx 에서 -ty 는 좌회전', turnKind(0, 3) === TurnKind.Left);
  check('같은 방향은 직진', turnKind(2, 2) === TurnKind.Straight);
  check('반대 방향은 유턴', turnKind(1, 3) === TurnKind.UTurn);

  const index = new JunctionIndex();
  const { world, ox, oy } = roadWorld((set) => {
    for (let i = 0; i < 30; i++) {
      set(i, 10);
      set(10, i);
    }
  });
  index.build(world, ox - 20, oy - 20, ox + 50, oy + 50);

  const path = (pts: [number, number][]) =>
    buildJunctionPath(
      { tiles: Int32Array.from(pts.flatMap(([x, y]) => [ox + x, oy + y])), costAtPlan: 0 },
      0,
      index,
    )!;

  const eastStraight = path([
    [8, 10],
    [9, 10],
    [10, 10],
    [11, 10],
    [12, 10],
  ]);
  const westStraight = path([
    [12, 10],
    [11, 10],
    [10, 10],
    [9, 10],
    [8, 10],
  ]);
  const southStraight = path([
    [10, 8],
    [10, 9],
    [10, 10],
    [10, 11],
    [10, 12],
  ]);
  const eastLeft = path([
    [8, 10],
    [9, 10],
    [10, 10],
    [10, 9],
    [10, 8],
  ]);
  const eastRight = path([
    [8, 10],
    [9, 10],
    [10, 10],
    [10, 11],
    [10, 12],
  ]);

  check('마주 오는 직진끼리는 통과', !pathsConflict(eastStraight, westStraight));
  check('직교하는 직진끼리는 충돌', pathsConflict(eastStraight, southStraight));
  check('좌회전은 마주 오는 직진과 충돌', pathsConflict(eastLeft, westStraight));
  check('우회전은 같은 방향 직진과 충돌하지 않는다', !pathsConflict(eastRight, eastStraight));
  check('같은 차선으로 합류하면 충돌', pathsConflict(eastRight, southStraight));

  // 넓은 교차로: 서로 다른 칸을 지나도 차체가 스치면 충돌이어야 한다.
  const wide = new JunctionIndex();
  const w2 = roadWorld((set) => {
    for (let x = 0; x < 24; x++) {
      set(x, 0);
      set(x, 1);
    }
    for (let y = -10; y < 12; y++) {
      set(10, y);
      set(11, y);
    }
  });
  wide.build(w2.world, w2.ox - 20, w2.oy - 20, w2.ox + 40, w2.oy + 30);
  const wpath = (pts: [number, number][]) =>
    buildJunctionPath(
      { tiles: Int32Array.from(pts.flatMap(([x, y]) => [w2.ox + x, w2.oy + y])), costAtPlan: 0 },
      0,
      wide,
    )!;
  const rowEast = wpath([
    [8, 0],
    [9, 0],
    [10, 0],
    [11, 0],
    [12, 0],
    [13, 0],
  ]);
  const rowWest = wpath([
    [13, 1],
    [12, 1],
    [11, 1],
    [10, 1],
    [9, 1],
    [8, 1],
  ]);
  const colSouth = wpath([
    [10, -2],
    [10, -1],
    [10, 0],
    [10, 1],
    [10, 2],
    [10, 3],
  ]);
  check('4차로: 마주 오는 직진은 서로 다른 칸을 써서 통과', !pathsConflict(rowEast, rowWest));
  check('4차로: 직교 직진은 칸이 달라도 충돌', pathsConflict(rowEast, colSouth));
}

/* ------------------------------------------------------------------ *
 * 4~5. 실제 시뮬레이션
 * ------------------------------------------------------------------ */

console.log('4. 실제 주행 (4차로 격자 도시)');
{
  const world = new World(0);
  const base = { x: world.baseCx * CHUNK_SIZE + 6, y: world.baseCy * CHUNK_SIZE + 6 };
  const SIZE = 46;

  // 물이 없는 자리를 고른다.
  let dry = false;
  for (let attempt = 0; attempt < 40 && !dry; attempt++) {
    dry = true;
    for (let y = 0; y < SIZE && dry; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (isWater(world.getTile(base.x + x, base.y + y))) {
          dry = false;
          break;
        }
      }
    }
    if (!dry) {
      base.x += 3;
      base.y += 2;
    }
  }

  // 폭 2타일(=4차로) 격자. 12칸 간격.
  const isRoad = (v: number) => v % 12 === 0 || v % 12 === 1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const tx = base.x + x;
      const ty = base.y + y;
      if (isRoad(x) || isRoad(y)) {
        world.setBuild(tx, ty, Build.Road, false);
      } else {
        const zone = x < SIZE / 2 ? Build.ZoneR : y < SIZE / 2 ? Build.ZoneC : Build.ZoneI;
        world.setBuild(tx, ty, zone, false);
      }
    }
  }
  for (let y = 2; y < SIZE - 2; y += 4) {
    for (let x = 2; x < SIZE - 2; x += 4) {
      if (isRoad(x) || isRoad(y) || isRoad(x + 1) || isRoad(y + 1)) continue;
      const zone = x < SIZE / 2 ? ZONE_R : y < SIZE / 2 ? ZONE_C : ZONE_I;
      world.placeBuilding(base.x + x, base.y + y, zone, 2, 0);
    }
  }

  const sim = new MacroSim(world, {
    money: START_MONEY,
    population: 0,
    tick: 0,
    tickedAt: Date.now(),
  });
  const congestion = new CongestionMap();
  const assignment = new AssignmentTable();
  sim.attachTraffic(congestion, assignment);
  for (let i = 0; i < 120; i++) sim.step();

  const traffic = new TrafficSim(world, sim, congestion, assignment);
  const cx = Math.floor((base.x + SIZE / 2) / CHUNK_SIZE);
  const cy = Math.floor((base.y + SIZE / 2) / CHUNK_SIZE);
  traffic.setActiveChunk(cx, cy);

  const index = traffic.junctions;
  let junctionCells = 0;
  for (const j of index.junctions) junctionCells += j.cells.length / 2;
  const signalized = index.junctions.filter((j) => j.signalized).length;
  console.log(
    `     교차로 ${index.junctions.length}개 (신호등 ${signalized}개, 총 ${junctionCells}칸)`,
  );
  check('격자 도시에 교차로가 검출된다', index.junctions.length >= 4);

  let worstOverlap = 0;
  let overlapFrames = 0;
  let peak = 0;
  let seen = 0;
  let signalViolations = 0;
  let redRightTurns = 0;
  let redRightNoStop = 0;
  let concurrentConflicts = 0;
  let movingSamples = 0;
  let samples = 0;
  let lateAvgSpeed = 0;
  let lateSamples = 0;
  const framePattern = process.env.TRAFFIC_FRAME_MS?.split(',').map(Number) ?? [16.67];
  if (framePattern.some((n) => !Number.isFinite(n) || n <= 0 || n > 100))
    throw new Error('TRAFFIC_FRAME_MS must be 0..100ms');
  const meanFrame = framePattern.reduce((a, b) => a + b, 0) / framePattern.length;
  const FRAMES = Math.ceil(200_000 / meanFrame);

  const all = (): Vehicle[] => {
    const out: Vehicle[] = [];
    for (let ccy = cy - 1; ccy <= cy + 1; ccy++) {
      for (let ccx = cx - 1; ccx <= cx + 1; ccx++) {
        out.push(...traffic.vehiclesInChunk(ccx, ccy));
      }
    }
    return out;
  };

  // 정지선을 넘는 "그 순간" 의 신호를 본다. 교차로 안에 있는 차를 그냥 세면,
  // 녹색에 들어가 정상적으로 통과하는 중인 차까지 위반으로 잡힌다.
  interface Watch {
    route: typeof Vehicle.prototype.route;
    path: NonNullable<ReturnType<typeof buildJunctionPath>>;
    progress: number;
    /** 정지선 앞에서 실제로 한 번 멈췄는가. 적신호 우회전의 "일시정지" 검증용. */
    didStop: boolean;
    crossed: boolean;
  }
  const watch = new Map<Vehicle, Watch>();

  for (let frame = 0; frame < FRAMES; frame++) {
    traffic.update(framePattern[frame % framePattern.length]);
    const vehicles = all();
    peak = Math.max(peak, vehicles.length);
    seen = Math.max(seen, traffic.activeCount);

    const live = new Set<Vehicle>();
    for (const v of vehicles) {
      live.add(v);
      let entry = watch.get(v);
      if (!entry || entry.route !== v.route || v.routeIdx > entry.path.exitIndex) {
        const path = buildJunctionPath(v.route, v.routeIdx, index);
        if (!path) {
          watch.delete(v);
          continue;
        }
        entry = {
          route: v.route,
          path,
          progress: v.routeIdx + v.tileT,
          didStop: false,
          crossed: v.routeIdx + v.tileT > path.entryIndex - 1 + INTERSECTION_STOP_T + 0.02,
        };
        watch.set(v, entry);
        continue;
      }
      const progress = v.routeIdx + v.tileT;
      const stopLine = entry.path.entryIndex - 1 + INTERSECTION_STOP_T;
      if (v.speed < 0.05 && Math.abs(progress - stopLine) <= 0.02) entry.didStop = true;
      // 정지선에 정확히 붙어 선 차(진행도 == 정지선)는 넘은 것이 아니다.
      // 부동소수 오차로 아주 미세하게 커질 수 있어 여유를 둔다.
      if (!entry.crossed && progress > stopLine + 0.02) {
        entry.crossed = true;
        const junction = index.byId(entry.path.junctionId);
        const grant = traffic.debugGrantSignal(v);
        const clearedOnNonRed = grant === SignalState.Green || grant === SignalState.Yellow;
        // 통행권을 이미 쥔 차는 제외한다. 황색에 "지금 제동해도 정지선을 넘는"
        // 상태로 진입 허가를 받은 뒤, 정지선을 넘는 사이에 적색으로 바뀐 경우가
        // 있다. 실제 도로에서도 그건 위반이 아니다. 허가 없이 적신호에 넘어가는
        // 것만 위반으로 센다.
        if (
          junction?.signalized &&
          entry.path.turn === TurnKind.Right &&
          !clearedOnNonRed &&
          signalState(junction, entry.path.enterDir, traffic.signalTimeMs) === SignalState.Red
        ) {
          // 적신호 우회전: 반드시 정지선에서 한 번 멈춘 뒤여야 한다.
          redRightTurns++;
          if (!entry.didStop) redRightNoStop++;
        }
        if (
          junction?.signalized &&
          entry.path.turn !== TurnKind.Right &&
          !clearedOnNonRed &&
          signalState(junction, entry.path.enterDir, traffic.signalTimeMs) === SignalState.Red
        ) {
          signalViolations++;
        }
      }
      entry.progress = progress;
    }
    for (const v of watch.keys()) if (!live.has(v)) watch.delete(v);

    if (frame % 3 !== 0) continue;

    const bodies = vehicles.map((v) => {
      const [x, y] = lanePosition(v.route, v.routeIdx, v.tileT);
      const [hx, hy] = laneHeading(v.route, v.routeIdx, v.tileT);
      return { x, y, hx, hy };
    });
    let hit = 0;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const dx = bodies[i].x - bodies[j].x;
        const dy = bodies[i].y - bodies[j].y;
        if (dx * dx + dy * dy > 1.4) continue;
        if (bodiesOverlap(bodies[i], bodies[j])) hit++;
      }
    }
    if (hit > 0) {
      overlapFrames++;
      worstOverlap = Math.max(worstOverlap, hit);
    }

    // 같은 교차로 안에서 서로 교차하는 궤적이 동시에 존재하는가.
    const inside = new Map<number, NonNullable<ReturnType<typeof buildJunctionPath>>[]>();
    for (const v of vehicles) {
      const id = index.idAt(v.route.tiles[v.routeIdx * 2], v.route.tiles[v.routeIdx * 2 + 1]);
      if (id < 0) continue;
      const path = buildJunctionPath(v.route, Math.max(0, v.routeIdx - 4), index);
      if (!path || path.junctionId !== id) continue;
      const list = inside.get(id);
      if (list) list.push(path);
      else inside.set(id, [path]);
    }
    for (const list of inside.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (pathsConflict(list[i], list[j])) concurrentConflicts++;
        }
      }
    }

    samples++;
    const moving = vehicles.filter((v) => v.speed > 0.1).length;
    movingSamples += vehicles.length > 0 ? moving / vehicles.length : 1;
    if (frame > FRAMES / 2 && vehicles.length > 0) {
      lateAvgSpeed += vehicles.reduce((sum, v) => sum + v.speed, 0) / vehicles.length;
      lateSamples++;
    }
  }

  const movingRatio = samples > 0 ? movingSamples / samples : 0;
  const lateSpeed = lateSamples > 0 ? lateAvgSpeed / lateSamples : 0;
  console.log(
    `     최대 동시 ${peak}대 · 주행 비율 평균 ${(movingRatio * 100).toFixed(0)}%` +
      ` · 후반 평균 속도 ${lateSpeed.toFixed(2)} 타일/초 · 남은 차량 ${traffic.activeCount}대`,
  );
  check(
    '차체가 한 번도 겹치지 않는다',
    overlapFrames === 0,
    `겹친 프레임 ${overlapFrames}개, 최대 ${worstOverlap}쌍`,
  );
  check(
    '통행권 없이 적신호에 진입하는 차가 없다(우회전 제외)',
    signalViolations === 0,
    `${signalViolations}회`,
  );
  check(
    '교차하는 궤적이 교차로 안에 동시에 존재하지 않는다',
    concurrentConflicts === 0,
    `${concurrentConflicts}회`,
  );
  check('차량이 실제로 다닌다', peak >= 5, `최대 ${peak}대`);
  check('교착 없이 계속 흐른다', lateSpeed > 0.3, `후반 평균 속도 ${lateSpeed.toFixed(2)}`);
  console.log(`     적신호 우회전 ${redRightTurns}회 (일시정지 없이 진행 ${redRightNoStop}회)`);
  check('적신호 우회전을 실제로 관측한다 (공허한 통과 방지)', redRightTurns > 0);
  check(
    '적신호 우회전은 반드시 일시정지 뒤에 이루어진다',
    redRightNoStop === 0,
    `${redRightNoStop}회`,
  );
}

/* ------------------------------------------------------------------ *
 * 5. 적신호 우회전 / 비보호 좌회전 규칙 (통행권 배분기 직접 검증)
 * ------------------------------------------------------------------ */

console.log('5. 회전 규칙');
{
  const { world, ox, oy } = roadWorld((set) => {
    for (let i = 0; i < 30; i++) {
      set(i, 10);
      set(10, i);
    }
  });
  const index = new JunctionIndex();
  index.build(world, ox - 20, oy - 20, ox + 50, oy + 50);
  const junction = index.at(ox + 10, oy + 10)!;

  const makePath = (pts: [number, number][]) =>
    buildJunctionPath(
      { tiles: Int32Array.from(pts.flatMap(([x, y]) => [ox + x, oy + y])), costAtPlan: 0 },
      0,
      index,
    )!;

  const stub = (name: string): Vehicle =>
    ({
      kind: 0,
      tier: 1,
      purpose: 0,
      routeIdx: 0,
      tileT: 0,
      lane: 0,
      speed: 0,
      dir: 0,
      destTx: name.length,
      destTy: name.charCodeAt(0),
      aggressive: false,
      waitMs: 0,
      stoppedMs: 0,
      stuckMs: 0,
      frozenMs: 0,
      jPath: null,
      jPathRoute: null,
      jPathRev: -1,
      route: { tiles: Int32Array.from([0, 0]), costAtPlan: 0 },
    }) as unknown as Vehicle;

  // 축 0(±tx)이 적색인 시각을 찾는다.
  let redForX = -1;
  for (let t = 0; t < 40_000; t += 100) {
    if (
      signalState(junction, 0, t) === SignalState.Red &&
      signalState(junction, 1, t) === SignalState.Green
    ) {
      redForX = t;
      break;
    }
  }
  check('축 0 적색 / 축 1 녹색인 시각이 존재한다', redForX >= 0);

  const rightOnRed = makePath([
    [8, 10],
    [9, 10],
    [10, 10],
    [10, 11],
    [10, 12],
  ]);
  const straightOnRed = makePath([
    [8, 10],
    [9, 10],
    [10, 10],
    [11, 10],
    [12, 10],
  ]);
  const greenStraight = makePath([
    [10, 8],
    [10, 9],
    [10, 10],
    [10, 11],
    [10, 12],
  ]);

  const approach = (v: Vehicle, path: typeof rightOnRed, distance: number): Approach => ({
    vehicle: v,
    path,
    distance,
    speed: 0,
    exitFree: Infinity,
    clearAhead: Infinity,
  });

  // (1) 일시정지 없이 적신호 우회전 -> 불가
  {
    const control = new IntersectionControl();
    const v = stub('a');
    v.stoppedMs = 100;
    control.arbitrate(redForX, [approach(v, rightOnRed, 0)], index);
    check('적신호 우회전: 일시정지 전에는 진행 불가', !control.hasReservation(v));
  }
  // (2) 일시정지 후, 방해 차량 없음 -> 가능
  {
    const control = new IntersectionControl();
    const v = stub('b');
    v.stoppedMs = 2_000;
    control.arbitrate(redForX, [approach(v, rightOnRed, 0)], index);
    check('적신호 우회전: 일시정지 후 차량이 없으면 진행 가능', control.hasReservation(v));
  }
  // (3) 일시정지했어도 녹색 축에서 오는 차와 궤적이 겹치면 -> 불가
  {
    const control = new IntersectionControl();
    const v = stub('queue');
    v.stoppedMs = 2_000;
    control.arbitrate(redForX, [approach(v, rightOnRed, 1)], index);
    check('정지선 1타일 앞의 대기 이력으로 적신호 우회전 불가', !control.hasReservation(v));
    const rolling = approach(v, rightOnRed, 0);
    rolling.speed = 0.2;
    control.arbitrate(redForX, [rolling], index);
    check('정지 시간이 남아 있어도 움직이는 차량은 우회전 불가', !control.hasReservation(v));
  }
  {
    let lastYellow = 0;
    for (let t = 0; t < 40_000; t++) {
      if (
        signalState(junction, 0, t) === SignalState.Yellow &&
        signalState(junction, 0, t + 1) === SignalState.Red
      ) {
        lastYellow = t;
        break;
      }
    }
    const control = new IntersectionControl();
    const v = stub('dilemma');
    const a = approach(v, rightOnRed, 0.37);
    a.speed = 6;
    control.arbitrate(lastYellow, [a], index);
    check(
      '황색 딜레마 존 진입 허가는 황색으로 기록된다',
      control.grantSignalOf(v) === SignalState.Yellow,
    );
    control.arbitrate(lastYellow + 50, [a], index);
    check(
      '50ms 뒤 적색으로 바뀌어도 이미 허가된 통과는 유지된다',
      signalState(junction, 0, lastYellow + 50) === SignalState.Red &&
        control.grantSignalOf(v) === SignalState.Yellow,
    );
  }
  {
    const control = new IntersectionControl();
    const v = stub('c');
    v.stoppedMs = 2_000;
    const other = stub('d');
    control.arbitrate(
      redForX,
      [approach(v, rightOnRed, 0), approach(other, greenStraight, 2)],
      index,
    );
    check('적신호 우회전: 진행 중인 차가 있으면 양보한다', !control.hasReservation(v));
  }
  // (4) 적신호 직진 -> 언제나 불가
  {
    const control = new IntersectionControl();
    const v = stub('e');
    v.stoppedMs = 5_000;
    control.arbitrate(redForX, [approach(v, straightOnRed, 0)], index);
    check('적신호 직진은 일시정지해도 진행 불가', !control.hasReservation(v));
  }
  // (5) 비보호 좌회전은 마주 오는 직진에 양보한다.
  {
    let greenForX = -1;
    for (let t = 0; t < 40_000; t += 100) {
      if (signalState(junction, 0, t) === SignalState.Green) {
        greenForX = t;
        break;
      }
    }
    const left = makePath([
      [8, 10],
      [9, 10],
      [10, 10],
      [10, 9],
      [10, 8],
    ]);
    const oncoming = makePath([
      [12, 10],
      [11, 10],
      [10, 10],
      [9, 10],
      [8, 10],
    ]);
    const control = new IntersectionControl();
    const v = stub('f');
    const other = stub('g');
    other.speed = 5;
    const oncomingApproach: Approach = {
      vehicle: other,
      path: oncoming,
      distance: 1,
      speed: 5,
      exitFree: Infinity,
      clearAhead: Infinity,
    };
    control.arbitrate(greenForX, [approach(v, left, 0), oncomingApproach], index);
    check('비보호 좌회전은 마주 오는 직진에 양보한다', !control.hasReservation(v));
    check('마주 오는 직진은 그대로 통과한다', control.hasReservation(other));

    // 마주 오는 차가 없으면 좌회전이 가능해야 한다.
    const control2 = new IntersectionControl();
    const w = stub('h');
    control2.arbitrate(greenForX, [approach(w, left, 0)], index);
    check('마주 오는 차가 없으면 좌회전 가능', control2.hasReservation(w));
  }
  // (6) 직진이 우회전보다, 우회전이 좌회전보다 먼저 간다(같은 조건일 때).
  {
    const control = new IntersectionControl();
    const straightV = stub('i');
    const leftV = stub('j');
    const left = makePath([
      [12, 10],
      [11, 10],
      [10, 10],
      [10, 11],
      [10, 12],
    ]);
    control.arbitrate(
      redForX + 0,
      [approach(leftV, left, 0), approach(straightV, greenStraight, 0)],
      index,
    );
    check(
      '충돌하는 두 요청 중 하나만 통행권을 받는다',
      control.hasReservation(straightV) !== control.hasReservation(leftV),
    );
  }
}

console.log('');
if (failures > 0) {
  console.log(`검증 실패 ${failures}건`);
  process.exit(1);
}
console.log('교통 규칙 검증 통과');
