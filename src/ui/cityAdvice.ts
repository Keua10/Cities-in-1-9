import type { CityStats } from '../sim/cityStats';
import { FACILITY_NAMES } from '../sim/simConstants';

export interface CityAdviceInput {
  money: number;
  catchupLeft: number;
  stats: Pick<
    CityStats,
    | 'buildings'
    | 'occupancy'
    | 'strandedBuildings'
    | 'overloadedFacilities'
    | 'serviceCoverage'
    | 'amenityFulfilled'
  >;
  power: { supply: number; unpoweredBuildings: number };
  water: { supply: number; drainage: number; contaminatedBuildings: number };
  sanitation: { waste: number; funeral: number };
  netIncome: number;
}
export interface CityAdvice {
  headline: string;
  issues: string[];
}
const percent = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 100);

/** Reports measured conditions; a single occupancy sample cannot establish a trend or cause. */
export function cityAdvice(input: CityAdviceInput): CityAdvice {
  const { stats: s, water: w, power: p } = input;
  if (input.catchupLeft > 0)
    return { headline: `도시 변화를 계산하는 중… (${input.catchupLeft}시간 남음)`, issues: [] };
  if (s.buildings === 0)
    return { headline: '도로 주변에 주거·상업·공업 지구를 지정해 보세요', issues: [] };
  const issues: string[] = [];
  if (input.money <= 0) issues.push('가용 자금이 없습니다. 세입과 유지비를 확인하세요.');
  if (w.contaminatedBuildings > 0)
    issues.push(`수질 오염 ${w.contaminatedBuildings}채 · 상수관과 하수관의 접촉을 확인하세요.`);
  if (s.strandedBuildings > 0)
    issues.push(`도로 미연결 ${s.strandedBuildings}채 · 건물에서 도로까지 연결하세요.`);
  if (p.unpoweredBuildings > 0 || p.supply < 0.999)
    issues.push(`전력 공급 ${percent(p.supply)}% · 발전 용량과 전력망 연결을 확인하세요.`);
  if (w.supply < 0.999 || w.drainage < 0.999)
    issues.push(
      `급수 ${percent(w.supply)}% · 하수 처리 ${percent(w.drainage)}% · 배관 연결과 처리 용량을 확인하세요.`,
    );
  if (input.sanitation.waste < 0.99 || input.sanitation.funeral < 0.99)
    issues.push(
      `쓰레기 처리 ${percent(input.sanitation.waste)}% · 장의 서비스 ${percent(input.sanitation.funeral)}% · 시설 연결과 정원을 확인하세요.`,
    );
  const worst = s.serviceCoverage.reduce((a, v, i, all) => (v < all[a] ? i : a), 0);
  if ((s.serviceCoverage[worst] ?? 1) < 0.7)
    issues.push(
      `${FACILITY_NAMES[worst]} 커버 ${percent(s.serviceCoverage[worst])}% · 서비스 범위와 도로 연결을 확인하세요.`,
    );
  if (s.overloadedFacilities > 0)
    issues.push(
      `시설 ${s.overloadedFacilities}곳 과부하 · 서비스 예산 또는 시설 배치를 확인하세요.`,
    );
  if (s.amenityFulfilled < 0.75)
    issues.push(
      `공원·복지 요구 충족 주거 건물 ${percent(s.amenityFulfilled)}% · 부족한 동네의 공원 범위를 확인하세요.`,
    );
  if (input.netIncome < 0)
    issues.push(
      `하루 예상 적자 ₩${Math.round(-input.netIncome).toLocaleString('ko-KR')} · 세입과 유지비를 확인하세요.`,
    );
  const occupancy = percent(s.occupancy);
  const headline = `건물 ${s.buildings}채 · 입주율 ${occupancy}%`;
  if (!issues.length && s.occupancy < 0.75)
    issues.push('입주가 낮은 건물을 선택해 일자리·통근·세율과 개별 서비스 상태를 확인하세요.');
  return { headline, issues };
}
