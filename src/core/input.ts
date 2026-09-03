import { ZOOM_WHEEL_STEP } from './constants';
import type { Camera } from './camera';

export interface InputHandlers {
  /** 짧게 누른 경우. 월드 좌표를 준다. */
  onTap?: (wx: number, wy: number) => void;
  /** 마우스 커서가 움직일 때만 호출된다. 터치에서는 안 온다. */
  onHover?: (wx: number, wy: number) => void;
  /** 터치 드래그/핀치가 끝나 커서를 지워야 할 때. */
  onHoverEnd?: () => void;

  /* ---------- 2단계: 칠하기 도구 ---------- */

  /**
   * 지금 칠하기 도구(도로·지구·철거)가 켜져 있는가.
   * true 면 한 손가락 드래그가 지도를 움직이지 않고 칠하기가 된다.
   */
  isPainting?: () => boolean;
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
 * 2단계에서 칠하기 도구가 붙으면서 한 손가락 드래그의 의미가 갈린다.
 *
 *   선택 도구      한 손가락 드래그 = 지도 이동   (기존 그대로)
 *   칠하기 도구    한 손가락 드래그 = 칠하기      (지도가 안 움직인다)
 *   어느 쪽이든    두 손가락       = 이동 + 확대/축소
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

      if (painting) {
        painting = false;
        handlers.onPaintEnd?.();
      }

      return;
    }

    if (handlers.isPainting?.()) {
      painting = true;

      const w = camera.screenToWorld(
        e.clientX,
        e.clientY,
      );

      handlers.onPaintStart?.(
        w.wx,
        w.wy,
      );
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

    p.moved = Math.max(
      p.moved,
      Math.hypot(
        e.clientX - p.startX,
        e.clientY - p.startY,
      ),
    );

    p.x = e.clientX;
    p.y = e.clientY;

    const mid = midpoint();

    if (pointers.size >= 2) {
      multiTouchGesture = true;

      const d = distance();

      if (pinchDist > 0 && d > 0) {
        camera.zoomAt(
          mid.x,
          mid.y,
          d / pinchDist,
        );
      }

      pinchDist = d;

      camera.panByScreen(
        mid.x - prevMid.x,
        mid.y - prevMid.y,
      );

      return;
    }

    /*
     * 칠하기 중에는 지도를 움직이지 않는다.
     * 관성도 걸지 않는다(velX/velY 를 건드리지 않고 빠져나간다).
     */
    if (painting) {
      const w = camera.screenToWorld(
        e.clientX,
        e.clientY,
      );

      handlers.onPaintMove?.(
        w.wx,
        w.wy,
      );

      return;
    }

    /*
     * 터치가 18px 안에서 흔들리는 동안에는
     * 카메라를 움직이지 않는다.
     *
     * 이 구간은 끝까지 탭 후보로 유지한다.
     */
    if (
      e.pointerType !== 'mouse' &&
      p.moved <= TAP_MOVE_LIMIT
    ) {
      return;
    }

    const dx =
      e.pointerType === 'mouse'
        ? mid.x - prevMid.x
        : dxPointer;

    const dy =
      e.pointerType === 'mouse'
        ? mid.y - prevMid.y
        : dyPointer;

    camera.panByScreen(dx, dy);

    const now = performance.now();

    const dt = Math.max(
      1,
      now - lastMoveT,
    );

    lastMoveT = now;

    velX =
      velX * 0.6 +
      (dx / dt) * 0.4;

    velY =
      velY * 0.6 +
      (dy / dt) * 0.4;

    if (
      e.pointerType === 'mouse' &&
      handlers.onHover
    ) {
      const w = camera.screenToWorld(
        e.clientX,
        e.clientY,
      );

      handlers.onHover(
        w.wx,
        w.wy,
      );
    }
  };

  const finishPointer = (
    e: PointerEvent,
    cancelled: boolean,
  ): void => {
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

    p.moved = Math.max(
      p.moved,
      Math.hypot(
        e.clientX - p.startX,
        e.clientY - p.startY,
      ),
    );

    p.x = e.clientX;
    p.y = e.clientY;

    if (cancelled) {
      pinchDist = 0;
      velX = 0;
      velY = 0;

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
      lastMoveT = performance.now();
      return;
    }

    if (pointers.size !== 0) {
      return;
    }

    const held =
      performance.now() -
      p.startT;

    const tapped =
      !multiTouchGesture &&
      p.moved <= TAP_MOVE_LIMIT &&
      held <= TAP_TIME_LIMIT;

    if (tapped) {
      /*
       * 탭 허용 범위 안에서 손가락이 조금 움직였더라도
       * 선택 위치는 처음 손가락을 댄 곳을 기준으로 한다.
       */
      const w = camera.screenToWorld(
        p.startX,
        p.startY,
      );

      handlers.onTap?.(
        w.wx,
        w.wy,
      );

      multiTouchGesture = false;
      return;
    }

    if (
      performance.now() -
        lastMoveT <
      80
    ) {
      camera.fling(
        velX,
        velY,
      );
    }

    if (e.pointerType !== 'mouse') {
      handlers.onHoverEnd?.();
    }

    multiTouchGesture = false;
  };

  const onUp = (
    e: PointerEvent,
  ): void => {
    e.preventDefault();
    finishPointer(e, false);
  };

  const onCancel = (
    e: PointerEvent,
  ): void => {
    finishPointer(e, true);
  };

  const onWheel = (
    e: WheelEvent,
  ): void => {
    e.preventDefault();

    const strength =
      e.ctrlKey ? 3 : 1;

    const factor = Math.exp(
      -e.deltaY *
        ZOOM_WHEEL_STEP *
        strength,
    );

    camera.zoomAt(
      e.clientX,
      e.clientY,
      factor,
    );
  };

  const onContext = (
    e: Event,
  ): void => {
    e.preventDefault();
  };

  const onLeave = (
    e: PointerEvent,
  ): void => {
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
