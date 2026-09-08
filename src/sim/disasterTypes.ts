export type DisasterKind = 0 | 1 | 2;
export interface Incident {
  kind: DisasterKind;
  tx: number;
  ty: number;
  code: number;
  born: number;
  startedTick: number;
}
export interface DisasterState {
  version: 1;
  active: Incident[];
  started: number[];
  extinguished: number;
  burned: number;
}
