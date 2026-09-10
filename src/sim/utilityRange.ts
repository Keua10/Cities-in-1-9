/** Manhattan distance: diagonal gaps count as two tiles. */
export function rangeOffsets(radius: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      if (Math.abs(dx) + Math.abs(dy) <= radius) out.push([dx, dy]);
    }
  return out;
}
export const utilityKey = (x: number, y: number): string => `${x},${y}`;
