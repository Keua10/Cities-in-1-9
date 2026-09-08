/** Shared quad layout: top-left, top-right, bottom-right, bottom-left. */
export function writeQuad(target: Float32Array, quad: number, x0: number, y0: number, x1: number, y1: number): void {
  const offset = quad * 8;
  target[offset] = x0;
  target[offset + 1] = y0;
  target[offset + 2] = x1;
  target[offset + 3] = y0;
  target[offset + 4] = x1;
  target[offset + 5] = y1;
  target[offset + 6] = x0;
  target[offset + 7] = y1;
}

export function quadIndices(count: number): Uint32Array {
  const indices = new Uint32Array(count * 6);
  for (let q = 0; q < count; q++) {
    const vertex = q * 4, offset = q * 6;
    indices[offset] = vertex;
    indices[offset + 1] = vertex + 1;
    indices[offset + 2] = vertex + 2;
    indices[offset + 3] = vertex;
    indices[offset + 4] = vertex + 2;
    indices[offset + 5] = vertex + 3;
  }
  return indices;
}
