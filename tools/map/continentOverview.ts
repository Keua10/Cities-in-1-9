import { CHUNK_SIZE } from '../../src/core/constants';
import {
  CONTINENT_H,
  CONTINENT_W,
  CONTINENT_X0,
  CONTINENT_Y0,
  quickSite,
} from '../../src/world/continent';

/** 미리보기 1픽셀이 덮는 칸 수. */
export const OVERVIEW_STEP = 16;

const COLORS: Record<number, [number, number, number]> = {
  0: [27, 63, 86],
  1: [44, 104, 128],
  2: [205, 186, 132],
  3: [96, 150, 80],
  4: [140, 162, 86],
  5: [150, 122, 86],
  6: [150, 150, 154],
  7: [64, 112, 64],
};

/** 시작 화면 지도. 높을수록 밝고, 개울·강은 파란 선으로 그린다. */
export function renderOverview(): { width: number; height: number; rgba: Uint8ClampedArray } {
  const width = (CONTINENT_W * CHUNK_SIZE) / OVERVIEW_STEP;
  const height = (CONTINENT_H * CHUNK_SIZE) / OVERVIEW_STEP;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const s = quickSite(
        CONTINENT_X0 * CHUNK_SIZE + px * OVERVIEW_STEP + OVERVIEW_STEP / 2,
        CONTINENT_Y0 * CHUNK_SIZE + py * OVERVIEW_STEP + OVERVIEW_STEP / 2,
      );
      let [r, g, b] = COLORS[s.tile];
      if (s.water === 1 || s.water === 2 || (!s.water && s.waterDist <= OVERVIEW_STEP / 2)) {
        [r, g, b] = s.water === 2 ? [52, 120, 170] : [70, 145, 190];
      } else if (!s.water) {
        const k = 0.82 + s.height * 0.05;
        r *= k;
        g *= k;
        b *= k;
      }
      const i = (py * width + px) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}
