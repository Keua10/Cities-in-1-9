import type { Camera } from './camera';
import { ZOOM_WHEEL_STEP } from './constants';

export interface InputHandlers {
  /** 짧게 누른 경우. 월드 좌표를 준다. */
  onTap?: (wx: number, wy: number) => void;
  /** 마우스 커서가 움직일 때만 호출된다. 터치에서는 안 온다. */
  onHover?: (wx: number, wy: number) => void;
  /** 터치 드래그/핀치가 끝나 커서를 지워야 할 때. */
  onHoverEnd?: () => void;

  /* ---------- 2단계: 칠하기 도구 ---------- */

  /**
   * 지금 칠하기 도구가 켜져 있는가.
   * - true: 기존처럼 한 손가락 드래그가 칠하기가 된다.
   * - 'tap': 터치에서는 짧은 탭만 설치하고, 드래그는 지도 이동으로 쓴다.
   *   마우스 입력은 기존 즉시 설치 동작을 유지한다.
   */
  isPainting?: () => boolean | 'tap';
  onPaintStart?: (wx: number, wy: number) => void;
  onPaintMove?: (wx: number, wy: number) => void;
  onPaintEnd?: () => void;
}

const TAP_MOVE_LIMIT = 18; // px
const TAP_TIME_LIMIT = 600; // ms

interface P {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startT: number;
  moved: number;
}

/**
 * 터치 우선 입력.
 * - 한 손가락: 18px 안쪽은 탭 후보로 유지하고 지도를 움직이지 않는다.
 * - 18px를 넘으면 드래그로 전환한다.
 * - 두 손가락: 핀치 확대/축소 + 이동.
 * - 마우스: 기존 hover / 드래그 / 휠 동작 유지.
 *
 * 칠하기 도구의 한 손가락 동작은 두 종류다.
 *
 *   선택 도구        한 손가락 드래그 = 지도 이동
 *   일반 칠하기 도구 한 손가락 드래그 = 칠하기
 *   탭 설치 도구     짧은 탭 = 설치 / 드래그 = 지도 이동
 *   어느 쪽이든      두 손가락 = 이동 + 확대/축소
 *
 * 두 손가락으로 늘어나면 진행 중이던 칠하기를 즉시 끊는다. 핀치하면서 도로가
 * 그어지면 학생이 지도를 못 움직인다.
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
  let multiTouchGesture = false;
  let painting = false;
  let tapPainting = false;

  const midpoint = (): { x: number; y: number } => {
    let x = 0;
    let y = 0;

    for (const p of pointers.values()) {
      x += p.x;
      y += p.y;
    }

    const n = pointers.size || 1;

    return {
      x: x / n,
      y: y / n,
    };
  };

  const distance = (): number => {
    const it = pointers.values();

    const a = it.next().value as P | undefined;
    const b = it.next().value as P | undefined;

    if (!a || !b) {
      return 0;
    }

    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onDown = (e: PointerEvent): void => {
    e.preventDefault();

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

    if (pointers.size >= 2) {
      multiTouchGesture = true;
      pinchDist = distance();
      tapPainting = false;

      if (painting) {
        painting = false;
        handlers.onPaintEnd?.();
      }

      return;
    }

    const paintMode = handlers.isPainting?.();
    if (paintMode) {
      // 시설처럼 한 번만 놓는 도구는 터치에서 즉시 설치하지 않는다.
      // 손가락이 실제 드래그인지 탭인지 판정한 뒤 탭일 때만 설치한다.
      if (paintMode === 'tap' && e.pointerType !== 'mouse') {
        tapPainting = true;
        return;
      }

      painting = true;

      const w = camera.screenToWorld(e.clientX, e.clientY);

      handlers.onPaintStart?.(w.wx, w.wy);
    }
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

    e.preventDefault();

    const prevMid = midpoint();
    const dxPointer = e.clientX - p.x;
    const dyPointer = e.clientY - p.y;

    p.moved = Math.max(p.moved, Math.hypot(e.clientX - p.startX, e.clientY - p.startY));

    p.x = e.clientX;
    p.y = e.clientY;

    const mid = midpoint();

    if (pointers.size >= 2) {
      multiTouchGesture = true;
      tapPainting = false;

      const d = distance();

      if (pinchDist > 0 && d > 0) {
        camera.zoomAt(mid.x, mid.y, d / pinchDist);
      }

      pinchDist = d;

      camera.panByScreen(mid.x - prevMid.x, mid.y - prevMid.y);

      return;
    }

    /*
     * 일반 칠하기 중에는 지도를 움직이지 않는다.
     * 관성도 걸지 않는다(velX/velY 를 건드리지 않고 빠져나간다).
     */
    if (painting) {
      const w = camera.screenToWorld(e.clientX, e.clientY);

      handlers.onPaintMove?.(w.wx, w.wy);

      return;
    }

    /*
     * 탭 설치 도구도 18px 안쪽에서는 탭 후보로 유지한다.
     * 18px를 넘은 순간부터 설치 후보를 버리고 카메라 드래그로 전환한다.
     */
    if (e.pointerType !== 'mouse' && p.moved <= TAP_MOVE_LIMIT) {
      return;
    }
    if (tapPainting) {
      tapPainting = false;
    }

    const dx = e.pointerType === 'mouse' ? mid.x - prevMid.x : dxPointer;

    const dy = e.pointerType === 'mouse' ? mid.y - prevMid.y : dyPointer;

    camera.panByScreen(dx, dy);

    const now = performance.now();

    const dt = Math.max(1, now - lastMoveT);

    lastMoveT = now;

    velX = velX * 0.6 + (dx / dt) * 0.4;

    velY = velY * 0.6 + (dy / dt) * 0.4;

    if (e.pointerType === 'mouse' && handlers.onHover) {
      const w = camera.screenToWorld(e.clientX, e.clientY);

      handlers.onHover(w.wx, w.wy);
    }
  };

  const finishPointer = (e: PointerEvent, cancelled: boolean): void => {
    const p = pointers.get(e.pointerId);

    pointers.delete(e.pointerId);

    if (el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }

    if (painting && pointers.size === 0) {
      painting = false;
      handlers.onPaintEnd?.();
    }

    if (!p) {
      return;
    }

    p.moved = Math.max(p.moved, Math.hypot(e.clientX - p.startX, e.clientY - p.startY));

    p.x = e.clientX;
    p.y = e.clientY;

    if (cancelled) {
      pinchDist = 0;
      velX = 0;
      velY = 0;
      tapPainting = false;

      if (pointers.size === 0) {
        multiTouchGesture = false;
      }

      if (e.pointerType !== 'mouse') {
        handlers.onHoverEnd?.();
      }

      return;
    }

    if (pointers.size === 1) {
      pinchDist = 0;
      velX = 0;
      velY = 0;
      tapPainting = false;
      lastMoveT = performance.now();
      return;
    }

    if (pointers.size !== 0) {
      return;
    }

    const held = performance.now() - p.startT;

    const tapPainted = tapPainting && !multiTouchGesture && p.moved <= TAP_MOVE_LIMIT;
    const tapped = !multiTouchGesture && p.moved <= TAP_MOVE_LIMIT && held <= TAP_TIME_LIMIT;

    if (tapPainted || tapped) {
      /*
       * 탭 허용 범위 안에서 손가락이 조금 움직였더라도
       * 선택/설치 위치는 처음 손가락을 댄 곳을 기준으로 한다.
       * 시설 설치는 기존 동작을 보존하기 위해 누르고 있는 시간과 무관하게
       * 드래그만 아니면 1회 실행한다.
       */
      const w = camera.screenToWorld(p.startX, p.startY);

      if (tapPainted) {
        handlers.onPaintStart?.(w.wx, w.wy);
        handlers.onPaintEnd?.();
        tapPainting = false;
      }

      if (tapped) {
        handlers.onTap?.(w.wx, w.wy);
      }

      multiTouchGesture = false;
      return;
    }

    tapPainting = false;

    if (performance.now() - lastMoveT < 80) {
      camera.fling(velX, velY);
    }

    if (e.pointerType !== 'mouse') {
      handlers.onHoverEnd?.();
    }

    multiTouchGesture = false;
  };

  const onUp = (e: PointerEvent): void => {
    e.preventDefault();
    finishPointer(e, false);
  };

  const onCancel = (e: PointerEvent): void => {
    finishPointer(e, true);
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();

    const strength = e.ctrlKey ? 3 : 1;

    const factor = Math.exp(-e.deltaY * ZOOM_WHEEL_STEP * strength);

    camera.zoomAt(e.clientX, e.clientY, factor);
  };

  const onContext = (e: Event): void => {
    e.preventDefault();
  };

  const onLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      handlers.onHoverEnd?.();
    }
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', onContext);
  el.addEventListener('pointerleave', onLeave);

  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('contextmenu', onContext);
    el.removeEventListener('pointerleave', onLeave);
  };
}
