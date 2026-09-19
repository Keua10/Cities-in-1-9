import type { Tools } from './tools';

/**
 * 두 점 건설의 확정 바.
 *
 * 건설을 **되돌릴 수 없는 한 번의 동작**으로 만드는 대신, 짓기 직전에 반드시
 * 한 번 멈추게 하는 장치다. 무엇을 몇 칸 얼마에 짓는지 읽고 나서 ✓ 를 눌러야
 * 돈이 나간다. 손이 미끄러져도 ✕ 한 번이면 아무 일도 일어나지 않는다.
 *
 * 화면 갱신은 ticker 에서 부르는 update() 하나로 끝낸다. 상태는 Tools 에만
 * 있으므로 이 파일은 그걸 읽어 DOM 에 옮기기만 한다.
 */
export function bindPlacementBar(tools: Tools): { update(): void } {
  const root = document.getElementById('build-confirm')!;
  const title = document.getElementById('build-confirm-title')!;
  const detail = document.getElementById('build-confirm-detail')!;
  const ok = document.getElementById('build-confirm-ok') as HTMLButtonElement;
  const cancel = document.getElementById('build-confirm-cancel') as HTMLButtonElement;

  ok.addEventListener('click', () => tools.confirmPlacement());
  cancel.addEventListener('click', () => tools.cancelPlacement());
  document.addEventListener('keydown', (e) => {
    if (!tools.hasSelection()) return;
    if (e.key === 'Enter') tools.confirmPlacement();
    // Escape 는 도구 자체를 끄는 데도 쓰인다. 선택이 있을 때는 선택만 지운다.
    else if (e.key === 'Escape') {
      // 이 리스너를 가장 먼저 붙인다(main.ts). 선택이 있을 때의 Escape 는
      // 도구를 끄는 게 아니라 선택만 지우는 것이 맞으므로, 뒤에 붙은
      // 건설 메뉴·패널 닫기 리스너까지 여기서 끊는다.
      e.stopImmediatePropagation();
      tools.cancelPlacement();
    }
  });

  let last = '';
  return {
    update(): void {
      const s = tools.summary();
      const key = `${s.active}|${s.title}|${s.detail}|${s.canConfirm}`;
      if (key === last) return;
      last = key;
      root.hidden = !s.active;
      if (!s.active) return;
      title.textContent = s.title;
      detail.textContent = s.detail;
      detail.classList.toggle('short', !s.canConfirm || s.detail.includes('부족'));
      ok.disabled = !s.canConfirm;
    },
  };
}
