import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  runTransaction,
} from 'firebase/firestore';
import { CHUNK_TILES, SCHEMA_VERSION } from '../core/constants';
import { chunkKey } from '../core/iso';
import type { ChunkOverride, ChunkSnapshot } from '../world/world';
import { decodeOverride, encodeOverride } from './codec';
import { getFirebase } from './firebase';
import type { Session } from './auth';
import { emptyMacro, newSaveToken, type CityDoc, type MacroState } from './types';

/** 다른 기기가 이 도시를 가져갔을 때 던진다. */
export class ConflictError extends Error {
  constructor() {
    super('다른 기기에서 이 도시에 접속했습니다.');
  }
}

export class OfflineError extends Error {}

export interface LoadedCity {
  city: CityDoc;
  /** 청크 키("cx,cy") -> 오버레이. */
  overrides: Map<string, ChunkOverride>;
}

/** 트랜잭션 한 번에 넣는 청크 문서 수 상한. Firestore 한도(500)보다 낮게 잡는다. */
const MAX_CHUNKS_PER_SAVE = 200;

function chunkDocId(cx: number, cy: number): string {
  return `${cx}_${cy}`;
}

/**
 * 로그인한 학생의 도시를 불러온다. 없으면 그 자리에서 만든다.
 *
 * 도시 번호(cityIndex)는 meta/registry 의 nextIndex 에서 하나씩 받아간다.
 * 트랜잭션 안에서 처리하므로 두 학생이 동시에 처음 로그인해도 같은 번호를
 * 받지 않는다. 한 번 받은 번호는 절대 바뀌지 않는다 — 바뀌면 도시가 순간이동한다.
 */
export async function loadCity(session: Session): Promise<LoadedCity> {
  const fb = getFirebase();
  if (!fb) throw new OfflineError('서버 설정이 없습니다.');
  const { db } = fb;

  const cityRef = doc(db, 'cities', session.uid);
  const registryRef = doc(db, 'meta', 'registry');
  const token = newSaveToken();
  const now = Date.now();

  const city = await runTransaction(db, async (tx) => {
    const citySnap = await tx.get(cityRef);

    if (citySnap.exists()) {
      const saved = citySnap.data() as Partial<CityDoc>;
      const merged = normalizeCity(saved, session, token, now);
      // 접속 표식만 새로 박는다. 이 순간부터 예전 기기의 저장은 거부된다.
      tx.update(cityRef, { saveToken: token, updatedAt: now });
      return merged;
    }

    // 첫 로그인 — 도시 번호를 발급받는다.
    const registrySnap = await tx.get(registryRef);
    let cityIndex = 0;
    if (registrySnap.exists()) {
      cityIndex = Number(registrySnap.data().nextIndex ?? 0) || 0;
      tx.update(registryRef, { nextIndex: cityIndex + 1 });
    } else {
      tx.set(registryRef, { nextIndex: 1 });
    }

    const fresh: CityDoc = {
      schemaVersion: SCHEMA_VERSION,
      cityIndex,
      displayName: session.loginId,
      cityName: `${session.loginId}번 도시`,
      explored: [],
      macro: emptyMacro(),
      saveToken: token,
      saveCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(cityRef, fresh);
    return fresh;
  });

  const overrides = await loadOverrides(session.uid);
  return { city, overrides };
}

async function loadOverrides(uid: string): Promise<Map<string, ChunkOverride>> {
  const fb = getFirebase();
  if (!fb) return new Map();
  const snap = await getDocs(collection(fb.db, 'cities', uid, 'chunks'));
  const out = new Map<string, ChunkOverride>();

  for (const d of snap.docs) {
    const [cxText, cyText] = d.id.split('_');
    const cx = Number(cxText);
    const cy = Number(cyText);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      console.warn('청크 문서 이름이 이상합니다:', d.id);
      continue;
    }
    const data = d.data() as Partial<{
      tiles: string;
      heights: string;
      build: string;
    }>;
    const tiles = decodeOverride(data.tiles ?? null, CHUNK_TILES);
    const heights = decodeOverride(data.heights ?? null, CHUNK_TILES);
    const build = decodeOverride(data.build ?? null, CHUNK_TILES);
    if (!tiles && !heights && !build) continue;
    out.set(chunkKey(cx, cy), { tiles, heights, build });
  }
  return out;
}

export interface SavePatch {
  explored: string[];
  macro: MacroState;
  cityName: string;
}

/**
 * 바뀐 것만 저장한다.
 *
 * 저장 전에 도시 문서의 saveToken 을 확인해서, 그 사이 다른 기기가 접속했다면
 * ConflictError 를 던지고 아무것도 쓰지 않는다. 두 기기가 서로의 도시를
 * 덮어쓰면서 왔다 갔다 하는 걸 막는 장치다.
 */
export async function saveCity(
  uid: string,
  token: string,
  patch: SavePatch,
  chunks: readonly ChunkSnapshot[],
): Promise<void> {
  const fb = getFirebase();
  if (!fb) throw new OfflineError('서버 설정이 없습니다.');
  const { db } = fb;

  if (chunks.length > MAX_CHUNKS_PER_SAVE) {
    // 여기에 걸릴 일은 사실상 없지만, 걸리면 조용히 잘리는 대신 알고 넘어간다.
    console.warn(
      `한 번에 저장할 청크가 ${chunks.length}개입니다. ${MAX_CHUNKS_PER_SAVE}개씩 나눠 저장하세요.`,
    );
  }

  const cityRef = doc(db, 'cities', uid);
  const now = Date.now();
  const emptyChunks: string[] = [];

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(cityRef);
    if (!snap.exists()) throw new ConflictError();
    const data = snap.data() as Partial<CityDoc>;
    if (data.saveToken !== token) throw new ConflictError();

    tx.update(cityRef, {
      explored: patch.explored,
      macro: patch.macro,
      cityName: patch.cityName,
      saveCount: (Number(data.saveCount) || 0) + 1,
      updatedAt: now,
    });

    for (const chunk of chunks.slice(0, MAX_CHUNKS_PER_SAVE)) {
      const id = chunkDocId(chunk.cx, chunk.cy);
      const tiles = encodeOverride(chunk.tiles);
      const heights = encodeOverride(chunk.heights);
      const build = encodeOverride(chunk.build);
      if (!tiles && !heights && !build) {
        // 고쳤다가 원래대로 되돌린 청크. 문서를 남길 이유가 없다.
        emptyChunks.push(id);
        continue;
      }
      tx.set(doc(db, 'cities', uid, 'chunks', id), {
        tiles,
        heights,
        build,
        updatedAt: now,
      });
    }
  });

  // 빈 청크 정리는 실패해도 게임에 영향이 없으므로 트랜잭션 밖에서 조용히 한다.
  for (const id of emptyChunks) {
    try {
      await deleteDoc(doc(db, 'cities', uid, 'chunks', id));
    } catch {
      /* 다음 저장 때 다시 지워진다 */
    }
  }
}

/**
 * 예전 버전으로 저장된 문서에 빠진 필드가 있어도 게임이 죽지 않게 채운다.
 * 스키마를 바꿀 때는 SCHEMA_VERSION 을 올리고 여기에 변환을 추가한다.
 */
function normalizeCity(
  saved: Partial<CityDoc>,
  session: Session,
  token: string,
  now: number,
): CityDoc {
  return {
    schemaVersion: Number(saved.schemaVersion) || SCHEMA_VERSION,
    cityIndex: Number(saved.cityIndex) || 0,
    displayName: saved.displayName ?? session.loginId,
    cityName: saved.cityName ?? `${session.loginId}번 도시`,
    explored: Array.isArray(saved.explored) ? saved.explored : [],
    macro: { ...emptyMacro(), ...(saved.macro ?? {}) },
    saveToken: token,
    saveCount: Number(saved.saveCount) || 0,
    createdAt: Number(saved.createdAt) || now,
    updatedAt: now,
  };
}
