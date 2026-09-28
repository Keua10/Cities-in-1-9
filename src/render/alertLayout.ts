import type { BuildingAlert } from '../sim/environment';

export interface AlertPoint {
  x: number;
  y: number;
  alerts: BuildingAlert[];
}
export interface AlertGroup extends AlertPoint {
  count: number;
}
export const ALERT_PRIORITY: BuildingAlert[] = [
  'road',
  'power',
  'water',
  'sewer',
  'pollution',
  'fire',
  'police',
  'health',
  'environment',
];

/** Fixed screen-pixel spacing. Greedy spatial bins keep every building represented,
 * including across cell boundaries; stable world coordinates prevent pan flicker. */
export function groupAlerts(points: AlertPoint[], zoom: number): AlertGroup[] {
  const spacing = zoom < 0.65 ? 84 : 48;
  const bins = new Map<string, AlertGroup[]>();
  const groups: AlertGroup[] = [];
  for (const point of points) {
    const bx = Math.floor(point.x / spacing),
      by = Math.floor(point.y / spacing);
    let nearest: AlertGroup | undefined;
    let distance = spacing;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        for (const group of bins.get(`${bx + dx},${by + dy}`) ?? []) {
          const d = Math.max(Math.abs(point.x - group.x), Math.abs(point.y - group.y));
          if (d < distance) {
            nearest = group;
            distance = d;
          }
        }
      }
    if (nearest) {
      nearest.count++;
      nearest.alerts = ALERT_PRIORITY.filter(
        (a) => nearest!.alerts.includes(a) || point.alerts.includes(a),
      );
    } else {
      const group = { ...point, alerts: [...point.alerts], count: 1 };
      groups.push(group);
      const key = `${bx},${by}`;
      const bucket = bins.get(key) ?? [];
      bucket.push(group);
      bins.set(key, bucket);
    }
  }
  return groups;
}
