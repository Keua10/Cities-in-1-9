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
    }
  };

  const onMove = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);

    if (!p) {
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

      return;
    }

    e.preventDefault();

    const prevMid = midpoint();

    const dxPointer =
      e.clientX - p.x;

    const dyPointer =
      e.clientY - p.y;

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

      if (
        pinchDist > 0 &&
        d > 0
      ) {
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

    camera.panByScreen(
      dx,
      dy,
    );

    const now = performance.now();

    const dt = Math.max(
      1,
      now - lastMoveT,
    );

    lastMoveT = now;

    /*
     * 지수 평활.
     * 손가락 끝의 마지막 떨림 때문에
     * 관성이 크게 바뀌지 않도록 한다.
     */
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
    const p = pointers.get(
      e.pointerId,
    );

    pointers.delete(
      e.pointerId,
    );

    if (
      el.hasPointerCapture(
        e.pointerId,
      )
    ) {
      el.releasePointerCapture(
        e.pointerId,
      );
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

      if (
        pointers.size === 0
      ) {
        multiTouchGesture = false;
      }

      if (
        e.pointerType !== 'mouse'
      ) {
        handlers.onHoverEnd?.();
      }

      return;
    }

    if (
      pointers.size === 1
    ) {
      /*
       * 핀치에서 한 손가락만 남은 순간.
       * 남은 손가락을 새 기준으로 삼는다.
       */
      pinchDist = 0;
      velX = 0;
      velY = 0;
      lastMoveT = performance.now();

      return;
    }

    if (
      pointers.size !== 0
    ) {
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
      const w = camera.screenToWorld(
        p.x,
        p.y,
      );

      handlers.onTap?.(
        w.wx,
        w.wy,
      );

      /*
       * 터치 탭으로 선택한 타일은
       * 손가락을 뗀 뒤에도 유지한다.
       */
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

    if (
      e.pointerType !== 'mouse'
    ) {
      handlers.onHoverEnd?.();
    }

    multiTouchGesture = false;
  };

  const onUp = (
    e: PointerEvent,
  ): void => {
    e.preventDefault();

    finishPointer(
      e,
      false,
    );
  };

  const onCancel = (
    e: PointerEvent,
  ): void => {
    finishPointer(
      e,
      true,
    );
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
    /*
     * 모바일에서는 터치 종료 직후
     * pointerleave가 발생할 수 있다.
     *
     * 터치 선택은 지우지 않고
     * 마우스 hover만 해제한다.
     */
    if (
      e.pointerType === 'mouse'
    ) {
      handlers.onHoverEnd?.();
    }
  };

  el.addEventListener(
    'pointerdown',
    onDown,
  );

  el.addEventListener(
    'pointermove',
    onMove,
  );

  el.addEventListener(
    'pointerup',
    onUp,
  );

  el.addEventListener(
    'pointercancel',
    onCancel,
  );

  el.addEventListener(
    'wheel',
    onWheel,
    {
      passive: false,
    },
  );

  el.addEventListener(
    'contextmenu',
    onContext,
  );

  el.addEventListener(
    'pointerleave',
    onLeave,
  );

  return () => {
    el.removeEventListener(
      'pointerdown',
      onDown,
    );

    el.removeEventListener(
      'pointermove',
      onMove,
    );

    el.removeEventListener(
      'pointerup',
      onUp,
    );

    el.removeEventListener(
      'pointercancel',
      onCancel,
    );

    el.removeEventListener(
      'wheel',
      onWheel,
    );

    el.removeEventListener(
      'contextmenu',
      onContext,
    );

    el.removeEventListener(
      'pointerleave',
      onLeave,
    );
  };
}
