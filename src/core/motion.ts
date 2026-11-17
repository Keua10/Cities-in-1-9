/**
 * 기기의 '동작 줄이기' 설정. 켜져 있으면 흔들림·흐르는 입자·깜빡임을 끄고
 * 같은 정보를 멈춘 그림으로 보여 준다. 설정을 바꾸면 바로 따라간다.
 */
const query =
  typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export function reducedMotion(): boolean {
  return !!query?.matches;
}
