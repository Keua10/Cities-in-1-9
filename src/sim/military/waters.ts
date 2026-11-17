import { chunkKey, parseChunkKey } from '../../core/iso';
import { UNIT_SPECS, type UnitType } from '../config/military';
import { chunkTerrain } from './terrain';

/**
 * 영해·영공 (피드백 1차).
 *
 *   영해   내 영토에서 2청크 안의 바다. 그 밖의 바다는 공해.
 *   영공   영토 + 영해 위 하늘.
 *   규율   나라마다 정한다: 자유 통과 · 신고 후 통과 · 허가 후 통과.
 *          규율을 따르지 않고 들어온 군함·군용기는 그 나라가 전쟁 없이 공격할 수 있다.
 *
 * 땅 부대는 평시에 남의 땅에 들어갈 수 없으므로(army.ts findPath) 영해·영공은 군함·공군만 본다.
 */

export const TERRITORIAL_SEA_CHUNKS = 2;

export type PassRule = 'open' | 'notify' | 'permit';
export const PASS_RULE_NAMES: Record<PassRule, string> = {
  open: '자유 통과',
  notify: '신고 후 통과',
  permit: '허가 후 통과',
};

/** 통과 기록(passes/{from}_{to}). notified·granted 는 until 까지 유효. */
export interface PassDoc {
  from: string;
  to: string;
  state: 'notified' | 'asked' | 'granted' | 'denied';
  at: number;
  until?: number;
}

/** 신고는 한 번에 6시간, 허가는 24시간 유효. */
export const NOTIFY_VALID_MS = 6 * 3_600_000;
export const PERMIT_VALID_MS = 24 * 3_600_000;
/** 무단 통과 부대 공격: 같은 청크에 다시 쏘려면 기다리는 시간. */
export const INCIDENT_COOLDOWN_MS = 30_000;
/** 무단 통과 부대를 칠 수 있는 내 부대 거리(청크). */
export const INCIDENT_RANGE_CHUNKS = 2;
/** 공격 한 번에 부대가 잃는 비율의 기준(공격력 10 = 이만큼). */
export const INCIDENT_LOSS_PER_10 = 0.06;

/** 영해: 영토에서 2청크 안의 바다 청크. */
export function territorialSea(owned: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const land = new Set(owned);
  for (const k of land) {
    const { cx, cy } = parseChunkKey(k);
    for (let dy = -TERRITORIAL_SEA_CHUNKS; dy <= TERRITORIAL_SEA_CHUNKS; dy++)
      for (let dx = -TERRITORIAL_SEA_CHUNKS; dx <= TERRITORIAL_SEA_CHUNKS; dx++) {
        const key = chunkKey(cx + dx, cy + dy);
        if (land.has(key) || out.has(key)) continue;
        if (chunkTerrain(cx + dx, cy + dy).kind === 'sea') out.add(key);
      }
  }
  return out;
}

/** 영공: 영토 + 영해. */
export function airspace(owned: Iterable<string>, sea?: Set<string>): Set<string> {
  const out = new Set(owned);
  for (const k of sea ?? territorialSea(out)) out.add(k);
  return out;
}

/** 이 병종이 영해·영공 규율을 받는가(군함·군용기). */
export function bound(type: UnitType): boolean {
  const d = UNIT_SPECS[type].domain;
  return d === 'air' || d === 'sea';
}

/** 지금 통과해도 되는가. */
export function passValid(rule: PassRule, pass: PassDoc | undefined, now: number): boolean {
  if (rule === 'open') return true;
  if (!pass || (pass.until ?? 0) < now) return false;
  return rule === 'notify'
    ? pass.state === 'notified' || pass.state === 'granted'
    : pass.state === 'granted';
}

/**
 * 무단 통과인가: 군함·군용기가 다른 나라의 영해(군함)·영공(군용기)에 규율을 따르지 않고 있다.
 * space = 그 나라의 영공(영토+영해), sea = 그 나라의 영해.
 */
export function trespassing(
  unit: { type: UnitType; cx: number; cy: number },
  space: { sea: Set<string>; air: Set<string> },
  rule: PassRule,
  pass: PassDoc | undefined,
  now: number,
): boolean {
  if (!bound(unit.type)) return false;
  const key = chunkKey(unit.cx, unit.cy);
  const inside = UNIT_SPECS[unit.type].domain === 'sea' ? space.sea.has(key) : space.air.has(key);
  return inside && !passValid(rule, pass, now);
}
