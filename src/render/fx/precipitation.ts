import { Graphics } from 'pixi.js';
import { reducedMotion } from '../../core/motion';
import type { Weather } from '../../sim/nature';

/** 세기 1 일 때 화면 전체 입자 수. 구형 기기를 생각해 넉넉히 잡지 않는다. */
const RAIN_MAX = 150;
const SNOW_MAX = 100;

/**
 * 도시 화면에 내리는 비·눈(화면 좌표). 날씨는 대륙과 같은 값(sim.nature.weather)이다.
 * 입자는 난수 대신 번호로 자리를 정해 시간에 따라 흘린다 — 상태를 들고 있지 않는다.
 * 바람이 불면 그 방향으로 기운다. 동작 줄이기면 그리지 않는다(어두워지는 것만 남는다).
 */
export class PrecipitationLayer {
  readonly graphics = new Graphics();

  constructor() {
    this.graphics.eventMode = 'none';
  }

  draw(weather: Weather, width: number, height: number, now: number): void {
    const g = this.graphics;
    g.clear();
    const kind = weather.precipitation;
    if (kind === 'clear' || reducedMotion()) {
      g.visible = false;
      return;
    }
    g.visible = true;
    const t = now / 1000;
    const k = Math.max(0.25, Math.min(1, weather.intensity));
    // 바람이 화면 가로로 미는 정도(-1~1).
    const lean = Math.max(
      -1,
      Math.min(1, Math.sin((weather.direction * Math.PI) / 180) * (weather.windSpeed / 15)),
    );
    if (kind === 'rain') {
      const n = Math.round(RAIN_MAX * k);
      for (let i = 0; i < n; i++) {
        const fx = ((i * 0.6180339) % 1) * (width + 60);
        const fy = ((i * 0.4142135) % 1) * height;
        const speed = 520 + (i % 5) * 60;
        const y = (fy + t * speed) % (height + 20);
        const x =
          ((((fx + t * speed * 0.18 * lean) % (width + 60)) + width + 60) % (width + 60)) - 30;
        g.moveTo(x, y).lineTo(x - 4 - lean * 6, y + 13);
      }
      g.stroke({ color: 0xc4dbee, width: 1, alpha: 0.5 });
    } else {
      const n = Math.round(SNOW_MAX * k);
      for (let i = 0; i < n; i++) {
        const fx = ((i * 0.6180339) % 1) * width;
        const fy = ((i * 0.4142135) % 1) * height;
        const y = (fy + t * (38 + (i % 4) * 9)) % (height + 6);
        const x = (((fx + Math.sin(t * 0.9 + i) * 14 + t * 30 * lean) % width) + width) % width;
        g.rect(x, y, i % 3 ? 2 : 3, i % 3 ? 2 : 3);
      }
      g.fill({ color: 0xffffff, alpha: 0.85 });
    }
  }
}
