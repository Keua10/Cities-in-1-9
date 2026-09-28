import assert from 'node:assert/strict';
import { commuteDepartureMinute } from '../../src/sim/citizens';
import { sessionDaytimeAt } from '../../src/sim/time';
import { DAYTIME_DAY_MS } from '../../src/sim/simConstants';
import { TrafficSim } from '../../src/sim/traffic/trafficSim';

assert.equal(sessionDaytimeAt(0, 0).minuteOfDay, 450);
assert.equal(sessionDaytimeAt(50_000, 0).minuteOfDay, 510);
assert.equal(sessionDaytimeAt(DAYTIME_DAY_MS, 0).absoluteDay, 1);
for (let slot = 0; slot < 200; slot++) {
  for (const dist of [1, 28, 44, 100, 1000]) {
    const departure = commuteDepartureMinute({ tx: 1, ty: 2 }, slot, {
      tx: 20,
      ty: 2,
      count: 1,
      level: 1,
      zone: 1,
      dist,
    });
    assert(departure >= 450 && departure <= 480, 'normal work starts only at 07:30–08:00');
  }
}
// Exercise the real frame splitter: time that used to be discarded at 4× must reach motion.
for (const delta of [16, 64, 100, 200, 400]) {
  const slices: number[] = [];
  TrafficSim.prototype.update.call(
    { initialized: true, updateSlice: (dt: number) => slices.push(dt) } as any,
    delta,
  );
  assert.equal(
    slices.reduce((a, b) => a + b, 0),
    delta,
  );
  assert(slices.every((dt) => dt > 0 && dt <= 50));
}
console.log(
  'Daily life: shared 50-second hour, 07:30–08:00 departures, full motion time at every speed.',
);

const { daylightAt } = await import('../../src/render/dayNight');
const atHour = (hour: number) => ({ ...sessionDaytimeAt(0, 0), hour });
assert.equal(daylightAt(atHour(12)), 1);
assert.equal(daylightAt(atHour(0)), 0);
assert.equal(daylightAt(atHour(6)), 0.5);
assert.equal(daylightAt(atHour(18)), 0.5);
assert(daylightAt(atHour(5.75)) < daylightAt(atHour(6.25)));
