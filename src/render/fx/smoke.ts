import { Graphics } from 'pixi.js';
import { CHUNK_SIZE, TILE_HH } from '../../core/constants';
import { tileToWorldX, tileToWorldY } from '../../core/iso';
import { reducedMotion } from '../../core/motion';
import { isAnchor, levelOfCode, zoneOfCode, ZONE_I } from '../../sim/buildings';
import type { FacilityRecord } from '../../sim/services';
import type { Incident } from '../../sim/disasterTypes';
import type { World } from '../../world/world';

/** 굴뚝 연기를 내는 시설: 가스·석탄 발전, 소각, 화장, 식품 가공, 제철, 정유, 군수·전차·탄약 공장. */
const SMOKY_FACILITIES = new Set([12, 14, 15, 35, 45, 46, 47, 51, 52, 61]);
/** 한 화면에서 연기를 내는 곳 최대 수(가까운 순서가 아니라 먼저 찾은 순서). */
const MAX_SOURCES = 36;
const PUFFS = 5;
/** 이보다 멀리 보면 연기를 그리지 않는다. */
const MIN_ZOOM = 0.4;
/** 화재 사건 kind. */
const FIRE = 0;

interface Source {
  x: number;
  y: number;
  /** 연기 크기(부지 칸 수). */
  span: number;
  fire: boolean;
  /** 퍼프 시작을 엇갈리게. */
  phase: number;
}

type Range = { cx0: number; cy0: number; cx1: number; cy1: number };

/**
 * 도시 화면 연기(월드 좌표): 공업 2·3단계 건물과 연기 나는 시설의 굴뚝, 불난 건물.
 * 연기 나는 자리는 화면 범위·도시 틱이 바뀔 때만 다시 찾고, 매 프레임은 퍼프만 다시 그린다.
 */
export class SmokeLayer {
  readonly graphics = new Graphics();
  private stamp = '';
  private sources: Source[] = [];

  constructor() {
    this.graphics.eventMode = 'none';
  }

  draw(
    world: World,
    range: Range,
    zoom: number,
    facilities: readonly FacilityRecord[],
    incidents: readonly Incident[],
    tick: number,
    now: number,
  ): void {
    const g = this.graphics;
    g.clear();
    if (zoom < MIN_ZOOM) {
      g.visible = false;
      return;
    }
    g.visible = true;
    const stamp = `${range.cx0},${range.cy0},${range.cx1},${range.cy1}|${tick}|${facilities.length}|${incidents.length}`;
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      this.sources = findSources(world, range, facilities, incidents);
    }
    const still = reducedMotion();
    const t = now / 1000;
    for (const src of this.sources) {
      const R = (src.fire ? 9 : 6) * Math.sqrt(src.span);
      for (let i = 0; i < PUFFS; i++) {
        // k: 퍼프가 굴뚝에서 떠난 뒤 진행(0~1). 위로 오르며 커지고 옅어진다.
        const k = still
          ? (i + 0.5) / PUFFS
          : (t * (src.fire ? 0.55 : 0.32) + src.phase + i / PUFFS) % 1;
        const drift = Math.sin(src.phase * 7 + k * 3) * R * 0.8 + k * R * 1.4;
        g.circle(src.x + drift, src.y - k * R * 7, R * (0.5 + k * 1.1));
        g.fill({
          color: src.fire ? 0x2f2a28 : 0x9a9a96,
          alpha: (src.fire ? 0.55 : 0.38) * (1 - k),
        });
      }
    }
  }
}

function findSources(
  world: World,
  range: Range,
  facilities: readonly FacilityRecord[],
  incidents: readonly Incident[],
): Source[] {
  const out: Source[] = [];
  const inRange = (tx: number, ty: number) => {
    const cx = Math.floor(tx / CHUNK_SIZE);
    const cy = Math.floor(ty / CHUNK_SIZE);
    return (
      cx >= range.cx0 &&
      cx <= range.cx1 &&
      cy >= range.cy0 &&
      cy <= range.cy1 &&
      world.isExplored(cx, cy)
    );
  };
  /** 부지 위 굴뚝 꼭대기쯤(건물 높이를 대략 부지 크기에 비례로 본다). */
  const top = (tx: number, ty: number, span: number, fire: boolean): Source => {
    const m = (span - 1) / 2;
    const x = tileToWorldX(tx + m, ty + m) - TILE_HH * span * 0.35;
    const y = tileToWorldY(tx + m, ty + m, world.sampleHeight(tx, ty)) - TILE_HH * span * 2.6;
    return { x, y, span, fire, phase: (((tx * 0.37 + ty * 0.61) % 1) + 1) % 1 };
  };
  for (const e of incidents) {
    if (e.kind !== FIRE || !inRange(e.tx, e.ty)) continue;
    out.push(top(e.tx, e.ty, levelOfCode(e.code), true));
  }
  for (const f of facilities) {
    if (out.length >= MAX_SOURCES) return out;
    if (SMOKY_FACILITIES.has(f.kind) && inRange(f.tx, f.ty))
      out.push(top(f.tx, f.ty, f.span, false));
  }
  for (let cy = range.cy0; cy <= range.cy1; cy++)
    for (let cx = range.cx0; cx <= range.cx1; cx++) {
      if (!world.isExplored(cx, cy)) continue;
      const p = world.peekParcel(cx, cy);
      if (!p?.bld) continue;
      for (let i = 0; i < p.bld.length; i++) {
        const code = p.bld[i];
        if (!isAnchor(code) || zoneOfCode(code) !== ZONE_I || levelOfCode(code) < 2) continue;
        if (out.length >= MAX_SOURCES) return out;
        const tx = cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const ty = cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        out.push(top(tx, ty, levelOfCode(code), false));
      }
    }
  return out;
}
