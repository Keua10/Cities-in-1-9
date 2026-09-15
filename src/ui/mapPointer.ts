/** Small-map taps open the map; a drag remains a drag even after returning to its start. */
export function bindMapPointer(
  canvas: HTMLCanvasElement,
  move: (event: PointerEvent) => void,
  tap?: () => void,
): void {
  let active: { id: number; x: number; y: number; dragged: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (active || e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    active = { id: e.pointerId, x: e.clientX, y: e.clientY, dragged: false };
    canvas.setPointerCapture(e.pointerId);
    if (!tap) move(e);
  });
  const track = (e: PointerEvent) => {
    if (!active || active.id !== e.pointerId) return false;
    e.preventDefault();
    active.dragged ||= Math.hypot(e.clientX - active.x, e.clientY - active.y) >= 7;
    if (active.dragged || !tap) move(e);
    return true;
  };
  canvas.addEventListener('pointermove', track);
  canvas.addEventListener('pointerup', (e) => {
    if (!track(e) || !active) return;
    const isTap = !active.dragged;
    active = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (isTap) tap?.();
  });
  const cancel = (e: PointerEvent) => {
    if (active?.id !== e.pointerId) return;
    active = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('lostpointercapture', cancel);
}
