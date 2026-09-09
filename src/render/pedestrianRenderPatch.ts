import { PedestrianLayer } from './pedestrianLayer';

/** 이 배율보다 멀리 줌아웃하면 사람은 너무 작아져 의미가 없으므로 그리지 않는다. */
export const PEDESTRIAN_MIN_RENDER_ZOOM = 0.65;

let currentZoom = 1;
let installed = false;
const originalDraw = PedestrianLayer.prototype.draw;

/** 보행 시뮬레이션은 계속 돌리되, 멀리서 볼 때만 Graphics 생성을 생략한다. */
export function installPedestrianRenderPatch(): void {
  if (installed) return;
  installed = true;
  PedestrianLayer.prototype.draw = function patchedPedestrianDraw(
    this: PedestrianLayer,
    ...args: Parameters<PedestrianLayer['draw']>
  ): void {
    if (currentZoom < PEDESTRIAN_MIN_RENDER_ZOOM) {
      this.graphics.clear();
      return;
    }
    originalDraw.apply(this, args);
  } as PedestrianLayer['draw'];
}

export function setPedestrianRenderZoom(zoom: number): void {
  currentZoom = zoom;
}
