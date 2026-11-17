import type { Application, Container } from 'pixi.js';
import { RENDER_MARGIN_PX } from '../../core/constants';
import type { Camera } from '../../core/camera';
import { visibleChunkRange } from '../../core/iso';
import type { MacroSim } from '../../sim/macro';
import type { DaytimeSnapshot } from '../../sim/time';
import type { World } from '../../world/world';
import { daylightAt } from '../dayNight';
import { AirRaidLayer } from './airRaid';
import { PrecipitationLayer } from './precipitation';
import { SmokeLayer } from './smoke';
import { StreetLightLayer } from './streetLights';

/**
 * 도시 화면 분위기 효과 묶음. 지형·건물 메시는 건드리지 않고 Graphics 몇 장만 얹는다.
 *
 *   월드 좌표(카메라 따라 움직임, 월드 색조 밖이라 밤에도 밝다):
 *     가로등 → 연기 → 폭격기 그림자  (설치·철거 효과 바로 아래)
 *   화면 좌표: 비·눈(맨 위, UI 아래)
 *   DOM: 공습 경보 테두리
 */
export class CityFx {
  private lights = new StreetLightLayer();
  private smoke = new SmokeLayer();
  private raidLayer = new AirRaidLayer();
  private rain = new PrecipitationLayer();

  constructor(
    private app: Application,
    worldRoot: Container,
    /** 이 Graphics 바로 아래에 월드 효과를 끼운다. */
    below: Container,
    private world: World,
    private sim: MacroSim,
  ) {
    const at = worldRoot.getChildIndex(below);
    worldRoot.addChildAt(this.raidLayer.graphics, at);
    worldRoot.addChildAt(this.smoke.graphics, at);
    worldRoot.addChildAt(this.lights.graphics, at);
    app.stage.addChild(this.rain.graphics);
  }

  /** 공습 경보. bombedChunk 가 있으면 그 위로 폭격기 그림자가 지나간다. */
  raid(bombedChunk: string | null): void {
    this.raidLayer.trigger(this.world, bombedChunk, performance.now());
  }

  update(camera: Camera, now: number, life: DaytimeSnapshot): void {
    const range = visibleChunkRange(camera.viewBounds(RENDER_MARGIN_PX));
    const sim = this.sim;
    this.lights.draw(this.world, range, camera.zoom, 1 - daylightAt(life));
    this.smoke.draw(
      this.world,
      range,
      camera.zoom,
      sim.services.facilityList(),
      sim.disasters.active,
      sim.tick,
      now,
    );
    this.raidLayer.draw(now);
    this.rain.draw(sim.nature.weather, this.app.screen.width, this.app.screen.height, now);
  }
}
