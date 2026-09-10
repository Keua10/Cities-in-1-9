export const PIPE_WATER = 1;
export const PIPE_REACH = 4;
export const PIPE_SEWER = 2;
export const PIPE_COST = 12;
export const PIPE_UPKEEP = 0.05;
export const WATER_GRACE_DAYS = 30;
export const WATER_RAMP_DAYS = 30;
export const DISCHARGE_RADIUS = 12;
export const FAC_GROUNDWATER = 7;
export const FAC_RIVER_PUMP = 8;
export const FAC_OUTFALL = 9;
export const FAC_TREATMENT = 10;

/** 수요 단위는 주거 정원/일자리 정원 1당 1. 실제 입주율과 무관하게 산정한다. */
export const WATER_SPECS: Readonly<
  Record<number, { pipe: number; capacity: number; pollution: number; needsWater: boolean }>
> = {
  [FAC_GROUNDWATER]: { pipe: PIPE_WATER, capacity: 1000, pollution: 0, needsWater: false },
  [FAC_RIVER_PUMP]: { pipe: PIPE_WATER, capacity: 4000, pollution: 0, needsWater: true },
  [FAC_OUTFALL]: { pipe: PIPE_SEWER, capacity: 1500, pollution: 1, needsWater: true },
  [FAC_TREATMENT]: { pipe: PIPE_SEWER, capacity: 5000, pollution: 0.15, needsWater: true },
};
