import { strict as assert } from 'node:assert';
import { bindMapPointer } from '../../src/ui/mapPointer';

class Surface extends EventTarget {
  captured = new Set<number>();
  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number) {
    this.captured.delete(id);
  }
  send(type: string, x: number, y: number, id = 1, primary = true) {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, { clientX: x, clientY: y, pointerId: id, button: 0, isPrimary: primary });
    this.dispatchEvent(e);
  }
}
const small = new Surface();
let opened = 0;
const positions: number[] = [];
bindMapPointer(
  small as unknown as HTMLCanvasElement,
  (e) => positions.push(e.clientX),
  () => opened++,
);
small.send('pointerdown', 10, 10);
small.send('pointerup', 12, 12);
assert.equal(opened, 1);
assert.equal(positions.length, 0, 'tap must not unexpectedly move camera');
small.send('pointerdown', 10, 10);
small.send('pointermove', 40, 10);
small.send('pointermove', 90, 10);
small.send('pointerup', 10, 10);
assert.equal(opened, 1, 'returning to start after drag must not open map');
assert.deepEqual(positions, [40, 90, 10], 'camera follows drag continuously');
small.send('pointerdown', 10, 10);
small.send('pointermove', 100, 10, 2, false);
small.send('pointerup', 100, 10, 2, false);
small.send('pointercancel', 10, 10);
small.send('pointerup', 10, 10);
assert.equal(opened, 1, 'second finger and cancelled touch cannot open map');
assert.equal(small.captured.size, 0);
small.send('pointerdown', 10, 10);
small.send('pointerup', 100, 10);
assert.equal(opened, 1, 'large up delta is drag even without move event');
small.send('pointerdown', 10, 10);
small.send('lostpointercapture', 10, 10);
small.send('pointerup', 10, 10);
assert.equal(opened, 1);
const large = new Surface();
let moved = 0;
bindMapPointer(large as unknown as HTMLCanvasElement, () => moved++);
large.send('pointerdown', 10, 10);
large.send('pointermove', 50, 20);
large.send('pointerup', 50, 20);
assert.equal(moved, 3, 'large map keeps direct click and drag navigation');
console.log(
  'Minimap pointer passed: tap, drag, return, cancel, capture loss, second finger, large map.',
);
