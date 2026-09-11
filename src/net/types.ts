import type { DisasterState } from '../sim/disasterTypes';
import type { CityPolicies } from '../sim/policies';
import { START_MONEY } from '../sim/simConstants';

export interface HarborAllocation {
  passenger: number;
  cargo: number;
}

/** STEP 4.6+ sparse transport settings. Facility placement itself still lives in chunk bld/build. */
export interface TransportState {
  /** Hybrid harbor allocation keyed by anchor tile "tx,ty". */
  harbors?: Record<string, HarborAllocation>;
}

/**
 * 매크로 상태. 파생값은 저장하지 않고, 사용자가 직접 정한 희소 설정만 선택 필드로 저장한다.
 */
export interface MacroState {
  /** STEP 4.7: already explored legacy terrain. Empty list means migration is complete. */
  legacyTerrainChunks?: string[];
  policies?: CityPolicies;
  sanitationStartTick?: number;
  powerStartTick?: number;
  waterStartTick?: number;
  prosperity?: number;
  /** Hybrid harbor passenger/cargo allocation. Old saves simply have no field. */
  transport?: TransportState;
  money: number;
  population: number;
  tick: number;
  tickedAt: number;
  disasters?: DisasterState;
}

export function emptyMacro(): MacroState {
  return { money: START_MONEY, population: 0, tick: 0, tickedAt: Date.now() };
}

export interface CityDoc {
  schemaVersion: number;
  cityIndex: number;
  displayName: string;
  cityName: string;
  explored: string[];
  macro: MacroState;
  saveToken: string;
  saveCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChunkDoc {
  wires?: string | null;
  pipes?: string | null;
  roadLinks?: string | null;
  tiles: string | null;
  heights: string | null;
  build: string | null;
  bld: string | null;
  bornLo: string | null;
  bornHi: string | null;
  updatedAt: number;
}

export interface ChunkPayload {
  wires?: Uint8Array | null;
  pipes?: Uint8Array | null;
  roadLinks?: Uint8Array | null;
  cx: number;
  cy: number;
  tiles: Uint8Array | null;
  heights: Uint8Array | null;
  build: Uint8Array | null;
  bld: Uint8Array | null;
  bornLo: Uint8Array | null;
  bornHi: Uint8Array | null;
}

export function newSaveToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
