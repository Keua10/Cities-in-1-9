import { WORLD_SEED } from '../../core/constants';
import { Build, DIRS } from '../../world/build';
import type { World } from '../../world/world';
import { simHash } from '../buildings';
import {
  JUNCTION_LEG_MIN_TILES,
  JUNCTION_LEG_SCAN_MAX,
  SIGNAL_CYCLE_MS,
} from '../simConstants';

/**
 * 교차로 영역 검출 — "도로 폭에 상관없이" 진짜 교차로만 찾는다.
 *
 * ── 왜 다시 만들었나 ─────────────────────────────────────────────
 * 예전 판정은 `roadMask` 의 이웃 도로 수가 3개 이상이면 교차로(=신호등)였다.
 * 그런데 폭이 2타일인 도로(=4차로)를 그으면 **직선 구간의 모든 타일**이
 * 이웃 3개를 갖는다.
 *
 *   ...  R R R R R R ...   <- 위 줄 (y=0)
 *   ...  R R R R R R ...   <- 아래 줄 (y=1)
 *
 * y=0 의 타일은 좌/우/아래가 전부 도로다. 그래서 4차로를 깐 순간 도로 전체가
 * "신호등 있는 교차로" 가 되고, 차들이 아무 데서나 빨간불을 만나 **4차로 한가운데
 * 멈춰 선다.** 사용자가 화면에서 본 것이 정확히 이것이다.
 *
 * ── 폭에 의존하지 않는 판정 ───────────────────────────────────────
 * 한 타일 t 에 대해
 *   hRun(t) = t 를 지나는 가로 방향 최대 연속 도로 구간
 *   vRun(t) = t 를 지나는 세로 방향 최대 연속 도로 구간
 * 을 잡는다. 그리고
 *
 *   세로로 갈라진다(branchV) := |vRun(t)| > min{ |vRun(s)| : s ∈ hRun(t) }
 *   가로로 갈라진다(branchH) := |hRun(t)| > min{ |hRun(s)| : s ∈ vRun(t) }
 *
 * `min` 이 곧 그 도로의 **폭**이다. 폭 2짜리 가로도로의 직선 구간은 모든 타일의
 * vRun 이 2 이므로 min 도 2 고, 따라서 branchV 가 거짓이다. 반대로 세로도로와
 * 만나는 타일만 vRun 이 폭보다 길어져 branchV 가 참이 된다.
 * 두 조건이 모두 참인 타일이 **교차로 칸**이다. 도로 폭을 상수로 박지 않으므로
 * 1차로든 6차로든 똑같이 동작한다.
 *
 * 교차로 칸들을 4방향 연결로 묶으면 하나의 **교차로 영역(Junction)** 이 된다.
 * 4차로 x 4차로 교차로는 2x2 = 4칸짜리 영역 하나가 된다. 신호도, 통행 우선순위도,
 * 점유 예약도 전부 이 영역 단위로 처리한다 — 타일 단위로 하면 넓은 교차로에서
 * 궤적이 서로 겹친다.
 */

/** 교차로로 들어오는 한 갈래(진입로). */
export interface JunctionLeg {
  /** 이 방향으로 진행하면 교차로 안으로 들어온다. */
  enterDir: number;
  /** 교차로 바깥으로 이어지는 도로 길이(타일). 1이면 진입로가 아니라 차고지/막다른 칸이다. */
  length: number;
  /** 진입로 폭(타일). 큰길 우선 판정의 기준이다. */
  width: number;
}

export interface Junction {
  id: number;
  /** 영역에 속한 타일. tx, ty 가 번갈아 들어간다. */
  cells: Int32Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  legs: JunctionLeg[];
  /** 진입 가능한 방향 비트마스크. */
  legMask: number;
  /** 신호등이 서는가. */
  signalized: boolean;
  /** 신호 주기 오프셋. 영역마다 고정이라 이웃 교차로가 동시에 열리지 않는다. */
  offsetMs: number;
  /** 가장 넓은 진입로 폭. 비신호 교차로의 "큰길" 판정에 쓴다. */
  maxLegWidth: number;
}

const EMPTY_JUNCTIONS: readonly Junction[] = [];

export class JunctionIndex {
  private x0 = 0;
  private y0 = 0;
  private w = 0;
  private h = 0;
  private ids: Int32Array = new Int32Array(0);
  private list: Junction[] = [];
  /** 이 값이 바뀌면 경로/혼잡 캐시를 버려야 한다. */
  revision = 0;

  get junctions(): readonly Junction[] {
    return this.list.length ? this.list : EMPTY_JUNCTIONS;
  }

  /** tx, ty 가 색인이 실제로 계산한 사각형 안에 있는가. */
  private inBounds(tx: number, ty: number): boolean {
    const lx = tx - this.x0;
    const ly = ty - this.y0;
    return lx >= 0 && ly >= 0 && lx < this.w && ly < this.h;
  }

  /** 이 타일이 속한 교차로 id. 없으면 -1. 색인 밖도 -1이다. */
  idAt(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return -1;
    return this.ids[(ty - this.y0) * this.w + (tx - this.x0)];
  }

  at(tx: number, ty: number): Junction | null {
    const id = this.idAt(tx, ty);
    return id < 0 ? null : this.list[id];
  }

  byId(id: number): Junction | null {
    return id < 0 || id >= this.list.length ? null : this.list[id];
  }

  /** 색인이 이 타일을 실제로 계산했는가(=밖이면 판정을 믿으면 안 된다). */
  covers(tx: number, ty: number): boolean {
    return this.inBounds(tx, ty);
  }

  /**
   * [x0, y0] ~ [x1, y1] 사각형을 훑어 교차로 영역을 다시 만든다.
   *
   * 사각형 경계에서는 연속 구간이 잘려 폭 판정이 흔들린다. 그래서 호출하는 쪽이
   * 시뮬레이션 영역보다 넉넉히 큰 사각형을 넘긴다(trafficSim 의 JUNCTION_MARGIN).
   */
  build(world: World, x0: number, y0: number, x1: number, y1: number): void {
    this.x0 = x0;
    this.y0 = y0;
    this.w = x1 - x0 + 1;
    this.h = y1 - y0 + 1;
    const w = this.w;
    const h = this.h;
    const n = w * h;

    const road = new Uint8Array(n);
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) {
        road[ly * w + lx] = world.getBuild(x0 + lx, y0 + ly) === Build.Road ? 1 : 0;
      }
    }

    // 가로/세로 최대 연속 구간의 길이와 구간 번호.
    const hLen = new Int32Array(n);
    const vLen = new Int32Array(n);
    const hRun = new Int32Array(n).fill(-1);
    const vRun = new Int32Array(n).fill(-1);
    let hRuns = 0;
    let vRuns = 0;

    for (let ly = 0; ly < h; ly++) {
      let lx = 0;
      while (lx < w) {
        if (!road[ly * w + lx]) { lx++; continue; }
        let end = lx;
        while (end + 1 < w && road[ly * w + end + 1]) end++;
        const len = end - lx + 1;
        for (let i = lx; i <= end; i++) {
          hLen[ly * w + i] = len;
          hRun[ly * w + i] = hRuns;
        }
        hRuns++;
        lx = end + 1;
      }
    }
    for (let lx = 0; lx < w; lx++) {
      let ly = 0;
      while (ly < h) {
        if (!road[ly * w + lx]) { ly++; continue; }
        let end = ly;
        while (end + 1 < h && road[(end + 1) * w + lx]) end++;
        const len = end - ly + 1;
        for (let i = ly; i <= end; i++) {
          vLen[i * w + lx] = len;
          vRun[i * w + lx] = vRuns;
        }
        vRuns++;
        ly = end + 1;
      }
    }

    // 구간별 "가장 얇은 곳" = 그 도로의 폭.
    const hRunMinV = new Int32Array(hRuns).fill(0x7fffffff);
    const vRunMinH = new Int32Array(vRuns).fill(0x7fffffff);
    for (let i = 0; i < n; i++) {
      if (!road[i]) continue;
      const hr = hRun[i];
      if (vLen[i] < hRunMinV[hr]) hRunMinV[hr] = vLen[i];
      const vr = vRun[i];
      if (hLen[i] < vRunMinH[vr]) vRunMinH[vr] = hLen[i];
    }

    const isCell = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!road[i]) continue;
      const branchV = vLen[i] > hRunMinV[hRun[i]];
      const branchH = hLen[i] > vRunMinH[vRun[i]];
      if (branchV && branchH) isCell[i] = 1;
    }

    // 4방향 연결 성분 = 교차로 영역.
    this.ids = new Int32Array(n).fill(-1);
    this.list = [];
    const stack: number[] = [];
    for (let seed = 0; seed < n; seed++) {
      if (!isCell[seed] || this.ids[seed] >= 0) continue;
      const id = this.list.length;
      const cells: number[] = [];
      stack.length = 0;
      stack.push(seed);
      this.ids[seed] = id;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      while (stack.length) {
        const cur = stack.pop()!;
        const lx = cur % w;
        const ly = (cur - lx) / w;
        const tx = x0 + lx;
        const ty = y0 + ly;
        cells.push(tx, ty);
        if (tx < minX) minX = tx;
        if (ty < minY) minY = ty;
        if (tx > maxX) maxX = tx;
        if (ty > maxY) maxY = ty;
        for (let d = 0; d < 4; d++) {
          const nx = lx + DIRS[d][0];
          const ny = ly + DIRS[d][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!isCell[ni] || this.ids[ni] >= 0) continue;
          this.ids[ni] = id;
          stack.push(ni);
        }
      }
      this.list.push({
        id,
        cells: Int32Array.from(cells),
        minX,
        minY,
        maxX,
        maxY,
        legs: [],
        legMask: 0,
        signalized: false,
        offsetMs: simHash(WORLD_SEED, minX, minY, 0x5a17) % SIGNAL_CYCLE_MS,
        maxLegWidth: 1,
      });
    }

    for (const junction of this.list) this.buildLegs(world, junction);
    this.revision++;
  }

  /**
   * 진입로를 모은다.
   *
   * 교차로 칸의 이웃 중 "교차로 밖 도로" 가 진입로다. 그 방향으로 몇 타일이나
   * 이어지는지도 같이 잰다. 길이가 1인 갈래(차고지 진입, 실수로 찍은 한 칸)는
   * 신호등 판정에서 빼야 한다 — 그러지 않으면 도로 옆에 한 칸을 잘못 찍는 순간
   * 그 자리에 신호등이 서 버린다.
   */
  private buildLegs(world: World, junction: Junction): void {
    const widths = [0, 0, 0, 0];
    const lengths = [0, 0, 0, 0];
    for (let c = 0; c < junction.cells.length; c += 2) {
      const tx = junction.cells[c];
      const ty = junction.cells[c + 1];
      for (let d = 0; d < 4; d++) {
        const nx = tx + DIRS[d][0];
        const ny = ty + DIRS[d][1];
        if (world.getBuild(nx, ny) !== Build.Road) continue;
        if (this.idAt(nx, ny) === junction.id) continue;
        // n -> (tx,ty) 로 들어오려면 DIRS[d] 의 반대 방향으로 진행한다.
        const enterDir = (d + 2) & 3;
        widths[enterDir]++;
        let len = 0;
        let px = nx;
        let py = ny;
        while (
          len < JUNCTION_LEG_SCAN_MAX &&
          world.getBuild(px, py) === Build.Road &&
          this.idAt(px, py) !== junction.id
        ) {
          len++;
          px += DIRS[d][0];
          py += DIRS[d][1];
        }
        if (len > lengths[enterDir]) lengths[enterDir] = len;
      }
    }

    const legs: JunctionLeg[] = [];
    let mask = 0;
    let maxWidth = 1;
    let realLegs = 0;
    let axisX = false;
    let axisY = false;
    for (let d = 0; d < 4; d++) {
      if (widths[d] === 0) continue;
      legs.push({ enterDir: d, length: lengths[d], width: widths[d] });
      mask |= 1 << d;
      if (lengths[d] >= JUNCTION_LEG_MIN_TILES) {
        if (widths[d] > maxWidth) maxWidth = widths[d];
        realLegs++;
        if ((d & 1) === 0) axisX = true;
        else axisY = true;
      }
    }
    junction.legs = legs;
    junction.legMask = mask;
    junction.maxLegWidth = maxWidth;
    // 신호등은 "양쪽 축에서 오는 진짜 도로가 3갈래 이상" 일 때만 선다.
    // L자 코너(2갈래)와 차고지 진입(길이 1)에는 서지 않는다.
    junction.signalized = realLegs >= 3 && axisX && axisY;
  }
}

/** 진입 방향 -> 진출 방향의 회전 종류. */
export const enum TurnKind {
  Straight = 0,
  Right = 1,
  Left = 2,
  UTurn = 3,
}

/**
 * 우측통행 기준 회전 분류.
 * laneGeometry 의 "진행방향의 오른쪽 = (dir + 1) & 3" 과 같은 규칙을 쓴다.
 */
export function turnKind(inDir: number, outDir: number): TurnKind {
  if (inDir === outDir) return TurnKind.Straight;
  if (((inDir + 1) & 3) === outDir) return TurnKind.Right;
  if (((inDir + 3) & 3) === outDir) return TurnKind.Left;
  return TurnKind.UTurn;
}
