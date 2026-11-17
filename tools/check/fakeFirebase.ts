/**
 * 점검용 메모리 Firestore (전쟁 연결 점검에서만 쓴다). warSession 이 쓰는 함수만 흉내 낸다.
 * onSnapshot 은 쓰기 직후 바로(동기로) 알린다.
 */

type Data = Record<string, unknown>;
const store = new Map<string, Data>();
type Listener = () => void;
const listeners = new Set<Listener>();

const DELETE = Symbol('delete');

export function initializeApp(): object {
  return {};
}
export function getAuth(): object {
  return {};
}
export function getFirestore(): object {
  return {};
}
export function deleteField(): unknown {
  return DELETE;
}
export function serverTimestamp(): unknown {
  return Date.now();
}
export class Timestamp {
  constructor(private ms: number) {}
  toMillis(): number {
    return this.ms;
  }
}

interface Ref {
  kind: 'doc' | 'coll';
  path: string;
  id: string;
}
export function doc(_db: unknown, ...parts: string[]): Ref {
  return { kind: 'doc', path: parts.join('/'), id: parts[parts.length - 1] };
}
export function collection(_db: unknown, ...parts: string[]): Ref {
  return { kind: 'coll', path: parts.join('/'), id: parts[parts.length - 1] };
}
interface Query {
  coll: Ref;
  field: string;
  value: unknown;
}
export function where(
  field: string,
  _op: string,
  value: unknown,
): { field: string; value: unknown } {
  return { field, value };
}
export function query(coll: Ref, w: { field: string; value: unknown }): Query {
  return { coll, field: w.field, value: w.value };
}

function snapOf(ref: Ref) {
  const data = store.get(ref.path);
  return {
    id: ref.id,
    exists: () => data !== undefined,
    data: () => (data ? structuredClone(data) : undefined),
    get: (k: string) => data?.[k],
  };
}
function notify(): void {
  for (const l of [...listeners]) l();
}
function clean(d: Data): Data {
  return JSON.parse(JSON.stringify(d));
}

export async function setDoc(ref: Ref, data: Data): Promise<void> {
  store.set(ref.path, clean(data));
  notify();
}
export async function updateDoc(ref: Ref, data: Data): Promise<void> {
  const cur = store.get(ref.path);
  if (!cur) throw new Error('없는 문서');
  for (const [k, v] of Object.entries(data)) {
    if (v === DELETE) delete cur[k];
    else cur[k] = clean({ v }).v as unknown;
  }
  notify();
}
export async function getDoc(ref: Ref) {
  return snapOf(ref);
}
export async function getDocs(coll: Ref) {
  const docs = [...store.keys()]
    .filter((p) => p.startsWith(coll.path + '/') && !p.slice(coll.path.length + 1).includes('/'))
    .map((p) => snapOf({ kind: 'doc', path: p, id: p.split('/').pop()! }));
  return { docs };
}
export function onSnapshot(target: Ref | Query, next: (snap: any) => void): () => void {
  const fire = () => {
    if ('coll' in target) {
      const docs = [...store.keys()]
        .filter(
          (p) =>
            p.startsWith(target.coll.path + '/') &&
            !p.slice(target.coll.path.length + 1).includes('/'),
        )
        .filter((p) => {
          const v = store.get(p)?.[target.field];
          return Array.isArray(v) && v.includes(target.value);
        })
        .map((p) => snapOf({ kind: 'doc', path: p, id: p.split('/').pop()! }));
      next({ docs });
    } else next(snapOf(target));
  };
  listeners.add(fire);
  fire();
  return () => listeners.delete(fire);
}
export async function runTransaction(): Promise<never> {
  throw new Error('점검용 가짜에는 트랜잭션이 없습니다');
}
export function _store(): Map<string, Data> {
  return store;
}
