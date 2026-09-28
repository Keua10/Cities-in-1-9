import type { DaytimeSnapshot } from '../sim/time';

/** A one-hour twilight either side of sunrise/sunset. UI stays outside this filter. */
export function daylightAt(life: DaytimeSnapshot): number {
  const rise = Math.max(0, Math.min(1, life.hour - life.sunriseHour + 0.5));
  const set = Math.max(0, Math.min(1, life.sunsetHour - life.hour + 0.5));
  const t = Math.min(rise, set);
  return t * t * (3 - 2 * t);
}

export function applyDayNight(canvas: HTMLCanvasElement, life: DaytimeSnapshot): void {
  const light = daylightAt(life);
  const twilight = 4 * light * (1 - light);
  const filter = `brightness(${(0.52 + 0.48 * light).toFixed(3)}) saturate(${(0.72 + 0.28 * light).toFixed(3)}) sepia(${(0.22 * twilight).toFixed(3)})`;
  if (canvas.style.filter !== filter) canvas.style.filter = filter;
}
