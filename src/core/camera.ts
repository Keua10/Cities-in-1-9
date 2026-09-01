import type { Container } from 'pixi.js';
import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  PAN_FRICTION,
  PAN_MIN_SPEED,
} from './constants';
import type { Bounds } from './iso';

/**
 * 카메라는 "월드 좌표 중 화면 정중앙에 오는 지점"(x, y)과 zoom 만 들고 있다.
 * 실제 렌더링은 월드 컨테이너를 반대로 밀어서 처리한다.
 */
export class Camera {
  x = 0;
  y = 0;
  zoom = DEFAULT_ZOOM;

  screenW = 1;
  screenH = 1;

  /** 관성 속도 (월드 px / ms) */
  private vx = 0;
  private vy = 0;

  /** 카메라가 벗어날 수 없는 월드 범위. null 이면 무제한. */
  limit: Bounds | null = null;

  resize(w: number, h: number): void {
    this.screenW = Math.max(1, w);
    this.screenH = Math.max(1, h);
    this.clamp();
  }

  centerOnWorld(wx: number, wy: number): void {
    this.x = wx;
    this.y = wy;
    this.vx = 0;
    this.vy = 0;
    this.clamp();
  }

  /** 화면에서 dx, dy 픽셀만큼 손가락을 끌었을 때의 이동. */
  panByScreen(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  /** 손가락을 뗄 때 관성을 넣는다. (px/ms, 화면 기준) */
  fling(vxScreen: number, vyScreen: number): void {
    this.vx = -vxScreen / this.zoom;
    this.vy = -vyScreen / this.zoom;
  }

  stopFling(): void {
    this.vx = 0;
    this.vy = 0;
  }

  /** 화면상의 한 점을 고정한 채 배율만 바꾼다. 핀치/휠 확대의 기본 동작. */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const before = this.screenToWorld(screenX, screenY);
    this.zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.screenToWorld(screenX, screenY);
    this.x += before.wx - after.wx;
    this.y += before.wy - after.wy;
    this.clamp();
  }

  update(dtMs: number): void {
    if (this.vx === 0 && this.vy === 0) return;
    this.x += this.vx * dtMs;
    this.y += this.vy * dtMs;
    const decay = Math.exp(-PAN_FRICTION * dtMs);
    this.vx *= decay;
    this.vy *= decay;
    if (Math.hypot(this.vx, this.vy) < PAN_MIN_SPEED) {
      this.vx = 0;
      this.vy = 0;
    }
    this.clamp();
  }

  screenToWorld(sx: number, sy: number): { wx: number; wy: number } {
    return {
      wx: (sx - this.screenW / 2) / this.zoom + this.x,
      wy: (sy - this.screenH / 2) / this.zoom + this.y,
    };
  }

  worldToScreen(wx: number, wy: number): { sx: number; sy: number } {
    return {
      sx: (wx - this.x) * this.zoom + this.screenW / 2,
      sy: (wy - this.y) * this.zoom + this.screenH / 2,
    };
  }

  /** 현재 화면이 덮는 월드 사각형. 청크 컬링에 쓴다. */
  viewBounds(marginPx = 0): Bounds {
    const hw = this.screenW / 2 / this.zoom + marginPx / this.zoom;
    const hh = this.screenH / 2 / this.zoom + marginPx / this.zoom;
    return {
      minX: this.x - hw,
      maxX: this.x + hw,
      minY: this.y - hh,
      maxY: this.y + hh,
    };
  }

  applyTo(world: Container): void {
    world.scale.set(this.zoom);
    // 픽셀 아트가 흐려지지 않도록 정수 픽셀에 스냅한다.
    world.position.set(
      Math.round(this.screenW / 2 - this.x * this.zoom),
      Math.round(this.screenH / 2 - this.y * this.zoom),
    );
  }

  private clamp(): void {
    const l = this.limit;
    if (!l) return;
    if (this.x < l.minX) {
      this.x = l.minX;
      this.vx = 0;
    }
    if (this.x > l.maxX) {
      this.x = l.maxX;
      this.vx = 0;
    }
    if (this.y < l.minY) {
      this.y = l.minY;
      this.vy = 0;
    }
    if (this.y > l.maxY) {
      this.y = l.maxY;
      this.vy = 0;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
