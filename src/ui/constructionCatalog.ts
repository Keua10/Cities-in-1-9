import type { ToolId } from './tools';
import { METRO_TUNNEL_COST, METRO_STATION_COST } from '../sim/metro';
import { formatMoney } from './money';
import { FACILITY_SPECS } from '../sim/facilities';
import { COST_ROAD, COST_ZONE } from '../sim/simConstants';
import { PIPE_COST, WATER_SPECS } from '../sim/config/water';
import { POWER_SPECS, WIRE_COST } from '../sim/config/power';
import { RUNWAY_COST, TAXIWAY_COST } from '../sim/config/transport';

export const BUILD_CATEGORIES = [
  { id: 'zones', name: '구역', icon: 'zones', color: '#9bca80', hint: '주거 · 상업 · 공업' },
  {
    id: 'transport',
    name: '교통',
    icon: 'road',
    color: '#b1c8d9',
    hint: '도로 · 지하철 · 공항 · 항구',
  },
  { id: 'power', name: '전기', icon: 'power', color: '#e8c778', hint: '발전소 · 전선' },
  { id: 'water', name: '수도', icon: 'water', color: '#7fc6db', hint: '급수 · 하수 처리 · 배관' },
  {
    id: 'service',
    name: '공공',
    icon: 'service',
    color: '#df9b81',
    hint: '소방 · 경찰 · 의료 · 교육',
  },
  { id: 'park', name: '공원', icon: 'park', color: '#a8c87b', hint: '공원 · 체육 · 장식' },
  { id: 'environment', name: '환경', icon: 'environment', color: '#c1afa0', hint: '쓰레기 · 장의' },
] as const;
export type BuildCategory = (typeof BUILD_CATEGORIES)[number]['id'];
export interface BuildItem {
  id: string;
  category: BuildCategory;
  tool: ToolId;
  kind?: number;
  name: string;
  cost: number;
  detail: string;
  unlock: number;
  icon: string;
}
const items: BuildItem[] = [];
function tool(category: BuildCategory, id: ToolId, name: string, cost: number, detail: string) {
  items.push({
    id,
    category,
    tool: id,
    name,
    cost,
    detail,
    unlock: 1,
    icon:
      (
        {
          zoneR: 'house',
          zoneC: 'shop',
          zoneI: 'factory',
          signalInstall: 'signal',
          signalRemove: 'signalRemove',
          metroTunnel: 'metro',
          metroStation: 'metro',
          metroErase: 'bulldoze',
          metroView: 'metro',
        } as Record<string, string>
      )[id] ?? BUILD_CATEGORIES.find((c) => c.id === category)!.icon,
  });
}
tool('zones', 'zoneR', '주거 구역', COST_ZONE, '주택이 들어서는 구역 · 도로와 공급망 필요');
tool('zones', 'zoneC', '상업 구역', COST_ZONE, '상점과 업무시설이 들어서는 구역');
tool('zones', 'zoneI', '공업 구역', COST_ZONE, '공장과 생산시설이 들어서는 구역');
tool('transport', 'road', '도로', COST_ROAD, '드래그로 도로 연결 · 클릭으로 독립 타일 설치');
tool(
  'transport',
  'metroTunnel',
  '지하철 터널',
  METRO_TUNNEL_COST,
  '드래그 연결 · 지상 건물 아래에 건설',
);
tool(
  'transport',
  'metroStation',
  '지하철역',
  METRO_STATION_COST,
  '도로 아래/옆에 설치 · 터널 포함 · 별도 출입구 없음',
);
tool('transport', 'metroView', '지하철 보기', 0, '역과 터널 연결 확인 · 역을 눌러 정보 보기');
tool('transport', 'metroErase', '지하철 철거', 0, '선택한 칸의 역·터널만 제거 · 지상 시설 유지');
tool('transport', 'signalInstall', '신호등 설치', 0, '도로에만 설치 · 교차로는 영역 전체에 적용');
tool('transport', 'signalRemove', '신호등 제거', 0, '도로에만 적용 · 해당 교차로 자동 설치도 해제');
tool('transport', 'runway', '활주로', RUNWAY_COST, '일직선으로 설치 · 공항 등급별 최소 길이 필요');
tool('transport', 'taxiway', '유도로', TAXIWAY_COST, '공항 터미널과 활주로를 연결');
tool('power', 'wire', '전선', WIRE_COST, '건물 사이 전력 공유 · 빈 땅은 전선으로 연결');
tool('power', 'wireErase', '전선 철거', 0, '전선만 제거 · 지상 건물 보존');
tool('water', 'waterPipe', '상수도관', PIPE_COST, '급수 반경 4칸 · 하수도관과 한 칸 이상 간격');
tool('water', 'sewerPipe', '하수도관', PIPE_COST, '하수 반경 4칸 · 상수도관과 한 칸 이상 간격');
tool('water', 'pipeErase', '배관 철거', 0, '배관만 제거 · 지상 건물 보존');
for (const spec of FACILITY_SPECS) {
  const k = spec.kind;
  const category: BuildCategory =
    k <= 3 || k === 20
      ? 'service'
      : k <= 6 || k === 17
        ? 'park'
        : WATER_SPECS[k]
          ? 'water'
          : POWER_SPECS[k]
            ? 'power'
            : k >= 14 && k <= 16
              ? 'environment'
              : 'transport';
  const capacity = POWER_SPECS[k]?.capacity ?? WATER_SPECS[k]?.capacity ?? spec.capacity;
  items.push({
    id: `facility-${k}`,
    category,
    tool: 'facility',
    kind: k,
    name: spec.name,
    cost: spec.cost,
    unlock: spec.unlockLevel,
    icon: BUILD_CATEGORIES.find((c) => c.id === category)!.icon,
    detail:
      `${spec.span}×${spec.span} · 유지 ${formatMoney(spec.upkeepPerDay)}/일` +
      (capacity ? ` · 용량 ${capacity.toLocaleString('ko-KR')}` : '') +
      (spec.needsRoad ? ' · 도로 필요' : '') +
      (k === 17 ? ' · 장식용, 현재 도시 기능 없음' : '') +
      (WATER_SPECS[k]?.needsWater || [19, 21, 22, 23].includes(k) ? ' · 수역 인접' : '') +
      ([18, 24, 25].includes(k) ? ' · 외부 활주로·유도로 연결 필요' : ''),
  });
}
export const BUILD_ITEMS: readonly BuildItem[] = items;
