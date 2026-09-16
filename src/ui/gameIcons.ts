/** Original 20×20 stepped silhouettes; integer coordinates keep the UI on a pixel grid. */
const paths: Record<string, string> = {
  metro:
    'M4 1h12v2h2v12h-3l3 4h-3l-2-3H7l-2 3H2l3-4H2V3h2z M5 4v6h10V4z M5 12v2h2v-2z M13 12v2h2v-2z',
  signal: 'M2 19V2h13v2H4v15z M10 5h8v11h-8z M13 6v2h2V6z M13 9v2h2V9z M13 12v2h2v-2z',
  signalRemove: 'M2 19V2h13v2H4v15z M10 5h8v5h-8z M9 13h10v3H9z',
  city: 'M2 18V8h5V3h6v7h5v8H2 M9 5v2h2V5 M4 10v2h1v-2 M9 9v2h2V9 M14 12v2h2v-2',
  people: 'M3 3h5v5H3z M2 10h7v7H7v2H4v-2H2z M12 5h4v4h-4z M11 11h7v6h-2v2h-3v-2h-2z',
  zones: 'M2 3h7v6H2z M11 3h7v6h-7z M2 11h7v6H2z M11 11h7v6h-7z',
  house: 'M2 9h2V7h2V5h2V3h4v2h2v2h2v2h2v2h-2v7H4v-7H2z M8 12v6h4v-6z',
  shop: 'M3 3h14l2 6v2h-2v7H3v-7H1V9z M5 12v4h4v-4z M11 12v6h4v-6z M4 5v4h2V5z M9 5v4h2V5z M14 5v4h2V5z',
  factory: 'M2 10l5-4v4l5-4v4h2V2h3v8h1v8H2z M4 13v2h3v-2z M9 13v2h3v-2z M14 13v2h2v-2z',
  road: 'M7 1h6l5 18H2z M9 3v3h2V3z M9 9v3h2V9z M9 15v3h2v-3z',
  power: 'M10 1h7l-5 7h5L6 19l2-9H3z',
  water: 'M9 1h2v3h2v3h2v3h2v5h-2v2h-2v2H7v-2H5v-2H3v-5h2V7h2V4h2z',
  service: 'M6 2h8v5h5v7h-5v5H6v-5H1V7h5z M8 4v5H3v3h5v5h4v-5h5V9h-5V4z',
  park: 'M8 1h4v3h3v3h2v5h-3v3h-3v4H9v-4H6v-3H3V7h2V4h3z',
  environment: 'M4 5h12v13H4z M2 2h5V1h6v1h5v2H2z M7 7v8h2V7z M11 7v8h2V7z',
  select: 'M3 1v15l4-4 4 7 3-2-4-6h7z',
  bulldoze: 'M3 7h8v6H3z M5 3h6v3H5z M1 14h13v4H1z M15 9h3v7h2v2h-5z',
  chart: 'M2 17V2h2v13h15v2z M6 8h3v5H6z M11 5h3v8h-3z M16 1h3v12h-3z',
  search: 'M4 2h8v2h2v8h-2v2H4v-2H2V4h2z M5 5v6h6V5z M13 13h3v2h2v3h-3v-2h-2z',
  layers: 'M10 1l9 5-9 5-9-5z M1 10l9 5 9-5v3l-9 5-9-5z',
  settings: 'M7 1h6v3h3v3h3v6h-3v3h-3v3H7v-3H4v-3H1V7h3V4h3z M7 7v6h6V7z',
  coin: 'M6 1h8v2h3v3h2v8h-2v3h-3v2H6v-2H3v-3H1V6h2V3h3z M9 4v2H6v5h6v2H6v2h3v2h2v-2h3V9H8V8h6V6h-3V4z',
  target: 'M9 1h2v4h4v4h4v2h-4v4h-4v4H9v-4H5v-4H1V9h4V5h4z M7 7v6h6V7z',
  pause: 'M4 3h4v14H4z M12 3h4v14h-4z',
  play: 'M5 2v16l12-8z',
  fast: 'M2 3v14l8-7z M10 3v14l8-7z',
};

export function gameIcon(name: string): string {
  return `<svg class="game-icon" viewBox="0 0 20 20" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" fill-rule="evenodd" d="${paths[name] ?? paths.city}"/></svg>`;
}

export function decorateGameIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]'))
    el.innerHTML = gameIcon(el.dataset.icon!);
}
