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
interface Cond {
  field: string;
  op: string;
  value: unknown;
}
interface Query {
  coll: Ref;
  conds: Cond[];
}
export function where(field: string, op: string, value: unknown): Cond {
  return { field, op, value };
}
export function query(coll: Ref, ...conds: Cond[]): Query {
  return { coll, conds };
}
function matches(d: Data | undefined, c: Cond): boolean {
  const v = d?.[c.field];
  if (c.op === 'array-contains') return Array.isArray(v) && v.includes(c.value);
  if (c.op === 'in') return (c.value as unknown[]).includes(v);
  if (c.op === '==') return v === c.value;
  throw new Error(`가짜 Firestore: ${c.op} 없음`);
}
function listDocs(coll: Ref, conds: Cond[]) {
  return [...store.keys()]
    .filter((p) => p.startsWith(coll.path + '/') && !p.slice(coll.path.length + 1).includes('/'))
    .filter((p) => conds.every((c) => matches(store.get(p), c)))
    .map((p) => snapOf({ kind: 'doc', path: p, id: p.split('/').pop()! }));
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
    // "a.b.c" 경로는 안쪽 객체를 고친다(진짜 Firestore 와 같게).
    const parts = k.split('.');
    let obj = cur as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      if (typeof obj[part] !== 'object' || obj[part] === null) obj[part] = {};
      obj = obj[part] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    if (v === DELETE) delete obj[last];
    else obj[last] = clean({ v }).v as unknown;
  }
  notify();
}
export async function getDoc(ref: Ref) {
  return snapOf(ref);
}
export async function getDocs(target: Ref | Query) {
  return 'conds' in target
    ? { docs: listDocs(target.coll, target.conds) }
    : { docs: listDocs(target, []) };
}
export function onSnapshot(target: Ref | Query, next: (snap: any) => void): () => void {
  const fire = () => {
    if ('conds' in target) next({ docs: listDocs(target.coll, target.conds) });
    else if (target.kind === 'coll') next({ docs: listDocs(target, []) });
    else next(snapOf(target));
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
