import type { NatureSystem, HazardKind, Precipitation } from '../sim/nature';

export function bindNatureControls(
  parent: HTMLElement,
  nature: NatureSystem,
  center: () => { tx: number; ty: number },
): void {
  const box = document.createElement('fieldset');
  box.innerHTML = `<legend>날씨 / 자연재해 실험</legend>
    <label>날씨<select data-weather><option value="auto">자연 변화</option><option value="clear">맑음</option><option value="rain">비</option><option value="snow">눈</option></select></label>
    <label>강수 강도 (0~100%)<input data-rain type="number" min="0" max="100" value="60"></label>
    <label>바람 (m/s)<input data-wind type="number" min="0" max="70" value="8"></label>
    <label>이동 방향 (0° 북 / 90° 동)<input data-direction type="number" min="0" max="360" value="90"></label>
    <button type="button" data-apply>날씨 적용</button>
    <label>재해<select data-hazard><option value="typhoon">태풍</option><option value="flood">홍수</option><option value="blizzard">폭설</option><option value="earthquake">지진</option></select></label>
    <label>재해 강도 (1~5)<input data-strength type="number" min="1" max="5" value="2"></label>
    <label>이동 속도 (칸/게임 시간)<input data-speed type="number" min="0" max="40" value="8"></label>
    <p>현재 지도 중심에서 시작합니다. 태풍·폭설은 지정 방향으로 이동합니다. 홍수는 저지대에 물이 쌓이고 높은 곳에서 낮은 곳으로 흐릅니다. 재해는 건물을 파괴할 수 있습니다.</p>
    <button type="button" data-start>재해 시작</button><button type="button" data-stop>재해 중지</button>
    <small data-status role="status"></small>`;
  parent.append(box);
  const num = (name: string) =>
    Number(box.querySelector<HTMLInputElement>(`[data-${name}]`)!.value);
  const value = (name: string) => box.querySelector<HTMLSelectElement>(`[data-${name}]`)!.value;
  const status = box.querySelector<HTMLElement>('[data-status]')!;
  box.querySelector('[data-apply]')!.addEventListener('click', () => {
    const type = value('weather');
    nature.setWeather(
      type === 'auto'
        ? null
        : {
            precipitation: type as Precipitation,
            intensity: num('rain') / 100,
            windSpeed: num('wind'),
            direction: num('direction'),
            temperature: type === 'snow' ? -5 : 15,
            cloud: type === 'clear' ? 0.1 : 0.85,
          },
    );
    status.textContent = '날씨를 적용했습니다.';
  });
  box.querySelector('[data-start]')!.addEventListener('click', () => {
    const p = center();
    nature.start(
      value('hazard') as HazardKind,
      num('strength'),
      p.tx,
      p.ty,
      num('direction'),
      num('speed'),
    );
    status.textContent = `재해 시작 위치 ${Math.round(p.tx)}, ${Math.round(p.ty)} · 중지해도 침수·적설·피해는 남습니다.`;
  });
  box.querySelector('[data-stop]')!.addEventListener('click', () => {
    nature.stop();
    status.textContent = '재해 발생을 중지했습니다. 잔류 물과 눈은 자연적으로 줄어듭니다.';
  });
}
