import { alignFootprint } from './footprintMath.mjs';

/** Waterfront cut-ins are intentional. Do not bridge their transparent setbacks
 * with the generic land-lot perimeter strip. Every sampled source pixel survives. */
export function alignFacilityFootprint(source) {
  const result = alignFootprint(source),
    s = source.width;
  const { scaleY, shearY, dx, shiftY } = result.projection;
  const copied = new Uint8Array(s * s),
    edges = new Int32Array(s).fill(-1);
  for (let y = 1; y < s - 1; y++)
    for (let x = 1; x < s - 1; x++) {
      const sx = x - dx,
        sy = Math.round((y - shearY * sx - shiftY) / scaleY);
      if (sx >= 0 && sx < s && sy >= 0 && sy < s && source.data[(sy * s + sx) * 4 + 3]) {
        copied[y * s + x] = 1;
        edges[x] = y;
      }
    }
  let unsupportedPerimeterPixels = 0,
    joinedPerimeterPixels = 0;
  const maxCorrection = Math.max(6, Math.round(s * 0.03));
  // Join the rasterized front edge over at most max(6px, 3% of the cell).
  // A larger transparent waterfront setback remains transparent.
  for (let x = 1; x < s - 1; x++) {
    const front = s - 2 - Math.ceil((Math.abs(x - (s - 1) / 2) - 0.5) * 0.5),
      edge = edges[x];
    if (edge < 0 || front - edge > maxCorrection) continue;
    for (let y = edge + 1; y <= front; y++) {
      const sy = Math.max(0, edge - ((front - y) % 3)),
        a = (sy * s + x) * 4,
        b = (y * s + x) * 4;
      if (result.raster.data[a + 3]) {
        result.raster.data.set(result.raster.data.slice(a, a + 4), b);
        joinedPerimeterPixels++;
      }
    }
  }
  for (let y = 1; y < s - 1; y++)
    for (let x = 1; x < s - 1; x++) {
      const i = y * s + x;
      if (
        !copied[i] &&
        result.raster.data[i * 4 + 3] &&
        (edges[x] < 0 || y - edges[x] > maxCorrection)
      ) {
        result.raster.data.fill(0, i * 4, i * 4 + 4);
        unsupportedPerimeterPixels++;
      }
    }
  result.projection.unsupportedPerimeterPixels = unsupportedPerimeterPixels;
  result.projection.joinedPerimeterPixels = joinedPerimeterPixels;
  return result;
}
