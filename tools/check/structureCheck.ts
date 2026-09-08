import { strict as assert } from 'node:assert';
import { ParcelMeshLayer } from '../../src/render/parcelMeshLayer';
import { Hud } from '../../src/ui/hud';
import { Router } from '../../src/sim/traffic/router';

let checks = 0;
function check(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name);
  checks++;
  console.log(`  OK ${name}`);
}
{
  let created = 0,
    destroyed = 0;
  const children = new Set();
  const parent = { addChild: (m) => children.add(m), removeChild: (m) => children.delete(m) };
  const create = (p) => {
    created++;
    const revision = p.bldRevision;
    return {
      mesh: { zIndex: 0 },
      count: p.count,
      needsRebuild: (q) => q.bldRevision !== revision,
      destroy: () => destroyed++,
    };
  };
  const layer = new ParcelMeshLayer(parent as any, create, 0.6, true);
  const parcel = { cx: -1, cy: 2, bld: new Uint8Array(1), bldRevision: 1, count: 0 } as any;
  for (let frame = 0; frame < 300; frame++) layer.ensure('-1,2', parcel);
  check('시설 없는 청크 300프레임에서 생성은 한 번', created, 1);
  check('빈 시설 메시는 즉시 해제되고 화면에는 남지 않음', [destroyed, children.size], [1, 0]);
  parcel.bldRevision++;
  parcel.count = 1;
  check('시설을 놓으면 빈 청크 캐시를 무효화', layer.ensure('-1,2', parcel), 1);
  check(
    '시설의 기존 깊이 보존',
    [...children].map((m: any) => m.zIndex),
    [1.6],
  );
  layer.ensure('-1,2', parcel);
  check('변하지 않은 시설은 재사용', created, 2);
  parcel.bldRevision++;
  parcel.count = 0;
  check('마지막 시설 철거 뒤 빈 화면으로 복귀', layer.ensure('-1,2', parcel), 0);
  check('이전 시설과 새 빈 메시 모두 해제', [destroyed, children.size], [3, 0]);
  const replacement = { ...parcel, count: 2 };
  check('같은 revision이어도 다른 필지 객체면 재검사', layer.ensure('-1,2', replacement), 2);
  layer.drop('-1,2');
  layer.drop('-1,2');
  check('중복 제거는 안전', [destroyed, children.size], [4, 0]);
  layer.ensure('-1,2', parcel);
  layer.drop('-1,2');
  layer.ensure('-1,2', parcel);
  check('청크 퇴출 시 빈 캐시도 제거', created, 6);
  const buildings = new ParcelMeshLayer(parent as any, create, 0.5);
  buildings.ensure('-1,2', parcel);
  check('지구 건물의 기존 빈 메시 정책은 보존', children.size, 1);
  buildings.ensure('-1,2', undefined);
  check('필지 제거 시 메시 정리', children.size, 0);
}
{
  const element = { innerHTML: '' };
  (globalThis as any).document = { querySelector: () => element };
  const hud = new Hud();
  let reads = 0;
  const data: any = {
    fps: 60,
    zoom: 1,
    tile: null,
    chunk: null,
    terrain: null,
    height: null,
    build: null,
    roadAccess: null,
    daytimeHour: 12,
    sunriseHour: 6,
    sunsetHour: 18,
    gametimeHour: 0,
    averageCongestion: 0,
  };
  for (const now of [0, 100, 199])
    hud.update(now, () => {
      reads++;
      return data;
    });
  check('표시 전 프레임에서 HUD 자료를 계산하지 않음', reads, 0);
  hud.update(200, () => {
    reads++;
    return data;
  });
  const first = element.innerHTML;
  check('표시 시점에만 자료 계산', reads, 1);
  hud.update(399, () => {
    reads++;
    return data;
  });
  check('기존 200ms 표시 주기 유지', reads, 1);
  hud.update(400, data);
  check('객체 입력과 지연 입력의 표시가 동일', element.innerHTML, first);
  delete (globalThis as any).document;
}
{
  // Invalid endpoints still consume budget and call back, without A* noise.
  const router = new Router({ getBuild: () => 255 } as any, {} as any);
  const seen: number[] = [];
  const request = (i: number) =>
    router.request(i, 0, i + 1, 0, 1, (result) => {
      assert.equal(result, null);
      seen.push(i);
      if (i === 0) request(2300);
    });
  for (let i = 0; i < 2300; i++) request(i);
  router.update(0);
  check('경로 예산 0은 콜백을 실행하지 않음', seen.length, 0);
  router.update(1200);
  check('경로 예산을 정확히 소비', seen.length, 1200);
  router.update(2000);
  check(
    '큐 압축과 콜백 재진입 뒤에도 FIFO 순서 보존',
    seen,
    Array.from({ length: 2301 }, (_, i) => i),
  );
  request(2301);
  router.update(1);
  check('큐를 비운 뒤 재사용', seen.at(-1), 2301);
}
console.log(`구조·갱신 검사 ${checks}개 통과`);
