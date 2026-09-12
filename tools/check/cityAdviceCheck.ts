import { strict as assert } from 'node:assert';
import { cityAdvice, type CityAdviceInput } from '../../src/ui/cityAdvice';

const healthy = (): CityAdviceInput => ({
  money: 10000,
  catchupLeft: 0,
  stats: {
    buildings: 100,
    occupancy: 0.9,
    strandedBuildings: 0,
    overloadedFacilities: 0,
    serviceCoverage: [1, 1, 1, 1],
    amenityFulfilled: 1,
  },
  power: { supply: 1, unpoweredBuildings: 0 },
  water: { supply: 1, drainage: 1, contaminatedBuildings: 0 },
  sanitation: { waste: 1, funeral: 1 },
  netIncome: 100,
});
assert.deepEqual(cityAdvice(healthy()).issues, []);
const low = healthy();
low.stats.occupancy = 0.65;
const message = cityAdvice(low).issues.join(' ');
assert.doesNotMatch(
  message,
  /도로|늘고|성장 중/,
  'low occupancy alone does not prove disconnected roads or a trend',
);
assert.match(message, /통근.*세율/);
const outages = healthy();
outages.water = { supply: 0.3, drainage: 0.2, contaminatedBuildings: 7 };
outages.power = { supply: 0.5, unpoweredBuildings: 20 };
outages.stats.strandedBuildings = 4;
const issues = cityAdvice(outages).issues;
assert.match(issues[0], /수질 오염 7채/);
assert.match(issues[1], /도로 미연결 4채/);
assert.match(issues[2], /전력 공급 50%/);
assert.match(issues[3], /급수 30% · 하수 처리 20%/);
const service = healthy();
service.stats.serviceCoverage = [0.9, 0.3, 0.1, 0.8];
service.stats.amenityFulfilled = 0.4;
service.stats.overloadedFacilities = 2;
service.sanitation = { waste: 0.8, funeral: 0.6 };
service.netIncome = -1200;
const notes = cityAdvice(service).issues.join('\n');
assert.match(notes, /병원 커버 10%/);
assert.match(notes, /주거 건물 40%/);
assert.doesNotMatch(notes, /주민.*40%/);
assert.match(notes, /2곳 과부하/);
assert.match(notes, /쓰레기 처리 80%.*장의 서비스 60%/);
assert.match(notes, /예상 적자 ₩1,200/);
const catchup = { ...outages, catchupLeft: 24 };
assert.deepEqual(cityAdvice(catchup), {
  headline: '도시 변화를 계산하는 중… (24시간 남음)',
  issues: [],
});
const empty = healthy();
empty.stats.buildings = 0;
assert.match(cityAdvice(empty).headline, /지구를 지정/);
console.log(
  'PASS city advice: no invented trend/cause, actual disconnected roads, power/water/contamination, service/amenity units, sanitation, deficit, catchup and empty city',
);
