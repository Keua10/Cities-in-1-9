import {
  FAC_AIRPORT,
  FAC_AIRPORT_L2,
  FAC_AIRPORT_L3,
  FAC_HARBOR,
  FAC_HARBOR_CARGO,
  FAC_HARBOR_HYBRID_L2,
  FAC_HARBOR_HYBRID_L3,
} from './special';

export type HarborMode = 'passenger' | 'cargo' | 'hybrid';

export interface HarborSpec {
  level: 1 | 2 | 3;
  maxShips: number;
  mode: HarborMode;
}

export interface AirportSpec {
  level: 1 | 2 | 3;
  maxPlanes: number;
  minRunwayTiles: number;
}

/** User-specified 2 / 5 / 13 ship progression. */
export const HARBOR_SPECS: Readonly<Record<number, HarborSpec>> = {
  [FAC_HARBOR]: { level: 1, maxShips: 2, mode: 'passenger' },
  [FAC_HARBOR_CARGO]: { level: 1, maxShips: 2, mode: 'cargo' },
  [FAC_HARBOR_HYBRID_L2]: { level: 2, maxShips: 5, mode: 'hybrid' },
  [FAC_HARBOR_HYBRID_L3]: { level: 3, maxShips: 13, mode: 'hybrid' },
};

/** Aircraft progression is balanced slightly above ship growth because airports need extra runway land. */
export const AIRPORT_SPECS: Readonly<Record<number, AirportSpec>> = {
  [FAC_AIRPORT]: { level: 1, maxPlanes: 2, minRunwayTiles: 6 },
  [FAC_AIRPORT_L2]: { level: 2, maxPlanes: 6, minRunwayTiles: 10 },
  [FAC_AIRPORT_L3]: { level: 3, maxPlanes: 14, minRunwayTiles: 14 },
};

export const RUNWAY_COST = 80;
export const TAXIWAY_COST = 45;

/** Macro effects are intentionally modest: hubs should help a good city, not replace zoning. */
export const AIRPORT_VISITORS_PER_PLANE = 180;
export const PASSENGER_VISITORS_PER_SHIP = 60;
export const PASSENGER_LOCAL_TRIPS_PER_SHIP = 240;
export const CARGO_EXPORT_PER_SHIP = 160;
export const AIRPORT_REVENUE_PER_PLANE = 180;
export const PASSENGER_REVENUE_PER_SHIP = 80;
export const CARGO_REVENUE_PER_SHIP = 140;
