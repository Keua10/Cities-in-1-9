import { ZOOM_WHEEL_STEP } from './constants';
import type { Camera } from './camera';

export interface InputHandlers {
  /** 짧게 누른 경우. 월드 좌표를 준다. */
  onTap?: (wx: number, wy: number) => void;
  /** 마우스 커서가 움직일 때만 호출된다. 터치에서는 안 온다. */
  onHover?: (wx: number, wy: number) => void;
  /** 터치 드래그/핀치가 끝나 커서를 지워야 할 때. */
  onHoverEnd?: () => void;
}

const TAP_MOVE_LIMIT = 12; // px — 손가락의 미세한 떨림 허용
const TAP_TIME_LIMIT = 300; // ms

interface P {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startT: number;
  moved: number;
}

/**
 * 터치 우선 입력. 한 손가락 = 이동, 두 손가락 = 확대/이동, 휠 = 확대.
 * 마우스 우클릭 드래그도 이동으로 친다.
 */
export function attachInput(
  el: HTMLElement,
  camera: Camera,
  handlers: InputHandlers = {},
): () => void {
  const pointers = new Map<number, P>();
  let lastMoveT = 0;
  let velX = 0;
  let velY = 0;
  let pinchDist = 0;

  const midpoint = (): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    for (const p of pointers.values()) {
      x += p.x;
      y += p.y;
    }
    const n = pointers.size || 1;
    return { x: x / n, y: y / n };
  };

  const distance = (): number => {
    const it = pointers.values();
    const a = it.next().value as P | undefined;
    const b = it.next().value as P | undefined;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onDown = (e: PointerEvent): void => {
    el.setPointerCapture(e.pointerId);
    camera.stopFling();
    pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      startT: performance.now(),
      moved: 0,
    });
    velX = 0;
    velY = 0;
    lastMoveT = performance.now();
    if (pointers.size === 2) pinchDist = distance();
  };

  const onMove = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && handlers.onHover) {
        const w = camera.screenToWorld(e.clientX, e.clientY);
        handlers.onHover(w.wx, w.wy);
      }
      return;
    }

    const prevMid = midpoint();

    // 시작 지점에서 가장 멀리 벗어난 거리로 탭/드래그를 판정한다.
    // 이벤트마다 이동량을 누적하면 손가락 미세 떨림만으로 탭이 취소될 수 있다.
    p.moved = Math.max(
      p.moved,
      Math.hypot(e.clientX - p.startX, e.clientY - p.startY),
    );

    p.x = e.clientX;
    p.y = e.clientY;
    const mid = midpoint();

    if (pointers.size >= 2) {
      const d = distance();
      if (pinchDist > 0 && d > 0) camera.zoomAt(mid.x, mid.y, d / pinchDist);
      pinchDist = d;
      camera.panByScreen(mid.x - prevMid.x, mid.y - prevMid.y);
      return;
    }

    const dx = mid.x - prevMid.x;
    const dy = mid.y - prevMid.y;
    camera.panByScreen(dx, dy);

    const now = performance.now();
    const dt = Math.max(1, now - lastMoveT);
    lastMoveT = now;
    // 지수 평활 — 손가락 끝의 마지막 떨림에 관성이 휘둘리지 않게 한다.
    velX = velX * 0.6 + (dx / dt) * 0.4;
    velY = velY * 0.6 + (dy / dt) * 0.4;

    if (e.pointerType === 'mouse' && handlers.onHover) {
      const w = camera.screenToWorld(e.clientX, e.clientY);
      handlers.onHover(w.wx, w.wy);
    }
  };

  const onUp = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);

    if (pointers.size === 1) {
      // 두 손가락 -> 한 손가락. 남은 손가락 기준으로 다시 잡아야 화면이 튀지 않는다.
      pinchDist = 0;
      velX = 0;
      velY = 0;
      lastMoveT = performance.now();
      return;
    }

    if (pointers.size === 0 && p) {
      const held = performance.now() - p.startT;
      const tapped = p.moved < TAP_MOVE_LIMIT && held < TAP_TIME_LIMIT;

      if (tapped) {
        const w = camera.screenToWorld(p.x, p.y);
        handlers.onTap?.(w.wx, w.wy);
        // 터치 탭으로 선택한 커서는 유지한다.
      } else {
        if (performance.now() - lastMoveT < 80) {
          camera.fling(velX, velY);
        }
        if (e.pointerType !== 'mouse') handlers.onHoverEnd?.();
      }
    }
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // 트랙패드 핀치는 ctrlKey 가 붙어서 들어온다. 배율을 조금 더 준다.
    const strength = e.ctrlKey ? 3 : 1;
    const factor = Math.exp(-e.deltaY * ZOOM_WHEEL_STEP * strength);
    camera.zoomAt(e.clientX, e.clientY, factor);
  };

  const onContext = (e: Event): void => e.preventDefault();
  const onLeave = (): void => handlers.onHoverEnd?.();

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', onContext);
  el.addEventListener('pointerleave', onLeave);

  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('contextmenu', onContext);
    el.removeEventListener('pointerleave', onLeave);
  };
}
