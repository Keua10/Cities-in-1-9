import { DIRS } from '../../world/build';
import type { Route } from './router';

/**
 * Right-hand lane geometry in TILE SPACE.
 *
 * Rendering used to offset cars in screen space while collision/routing stayed on tile centres.
 * That made the visual lane and simulated lane disagree, especially around corners.
 *
 * Every route node now gets a deterministic lane-centre point in tile coordinates.
 * Vehicle rendering and traffic conflict logic both use this route geometry.
 */
export const LANE_OFFSET_TILES = 0.20;

export function routeSegmentDir(route: Route, segmentIndex: number): number {
  const points = route.tiles.length / 2;
  if (points < 2) return 0;
  const i = Math.max(0, Math.min(points - 2, segmentIndex)) * 2;
  const x = route.tiles[i];
  const y = route.tiles[i + 1];
  const nx = route.tiles[i + 2];
  const ny = route.tiles[i + 3];
  for (let d = 0; d < DIRS.length; d++) {
    const dir = DIRS[d];
    if (x + dir[0] === nx && y + dir[1] === ny) return d;
  }
  return 0;
}

export function isTurnNode(route: Route, nodeIndex: number): boolean {
  const points = route.tiles.length / 2;
  if (nodeIndex <= 0 || nodeIndex >= points - 1) return false;
  const incoming = routeSegmentDir(route, nodeIndex - 1);
  const outgoing = routeSegmentDir(route, nodeIndex);
  return incoming !== outgoing;
}

/**
 * Fractional tile coordinate of the physical lane centre.
 * `routeIdx/tileT` stays the simulation progress variable, but the point it represents is
 * no longer the road centre line.
 */
export function lanePosition(
  route: Route,
  routeIdx: number,
  tileT: number,
): [number, number] {
  const points = route.tiles.length / 2;
  if (points <= 0) return [0, 0];
  if (points === 1) return [route.tiles[0], route.tiles[1]];

  const i = Math.max(0, Math.min(points - 2, routeIdx));
  const a = laneNodePoint(route, i);
  const b = laneNodePoint(route, i + 1);
  const t = Math.max(0, Math.min(1, tileT));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Lane-centre waypoint at a route node.
 *
 * Straight: node + right-hand offset.
 * Turn: intersection of the incoming right-lane line and outgoing right-lane line.
 *
 * That makes incoming/outgoing lane segments meet at exactly the same point instead of
 * "sliding" across the road near every corner.
 */
export function laneNodePoint(route: Route, nodeIndex: number): [number, number] {
  const points = route.tiles.length / 2;
  const n = Math.max(0, Math.min(points - 1, nodeIndex));
  const x = route.tiles[n * 2];
  const y = route.tiles[n * 2 + 1];

  if (points <= 1) return [x, y];
  if (n === 0) return shiftedNode(x, y, routeSegmentDir(route, 0));
  if (n === points - 1) return shiftedNode(x, y, routeSegmentDir(route, points - 2));

  const incoming = routeSegmentDir(route, n - 1);
  const outgoing = routeSegmentDir(route, n);
  if (incoming === outgoing) return shiftedNode(x, y, outgoing);

  // U-turns are not normal router output. If one ever appears, prefer the outgoing lane.
  if ((incoming + 2) % 4 === outgoing) return shiftedNode(x, y, outgoing);

  const aDir = DIRS[incoming];
  const bDir = DIRS[outgoing];
  const aRight = rightVector(incoming);
  const bRight = rightVector(outgoing);
  const ax = x + aRight[0];
  const ay = y + aRight[1];
  const bx = x + bRight[0];
  const by = y + bRight[1];

  const denom = cross(aDir[0], aDir[1], bDir[0], bDir[1]);
  if (Math.abs(denom) < 1e-6) return shiftedNode(x, y, outgoing);

  const px = bx - ax;
  const py = by - ay;
  const along = cross(px, py, bDir[0], bDir[1]) / denom;
  return [ax + aDir[0] * along, ay + aDir[1] * along];
}

function shiftedNode(x: number, y: number, dir: number): [number, number] {
  const right = rightVector(dir);
  return [x + right[0], y + right[1]];
}

function rightVector(dir: number): [number, number] {
  // DIRS = +tx, +ty, -tx, -ty. On the ground plane, the next direction is the
  // driver's right-hand side: +tx -> +ty -> -tx -> -ty -> +tx.
  const d = DIRS[(dir + 1) & 3] ?? DIRS[1];
  return [d[0] * LANE_OFFSET_TILES, d[1] * LANE_OFFSET_TILES];
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}
