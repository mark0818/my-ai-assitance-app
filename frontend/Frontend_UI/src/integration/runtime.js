import { AppState, Platform } from 'react-native';
import { deleteDatabaseAsync, openDatabaseAsync, openDatabaseSync } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { createLocalStore, createBridge } from '../../../../backend/local/src/index.js';
import * as engine from '../lib/stella/local-sync';
import { expoSqliteDb } from '../lib/stella/sqlite-expo';
import { supabaseTransport } from '../lib/stella/sync';
import { subscribeWorkspace } from '../lib/stella/realtime';
import { supabase } from '../lib/stella/supabase';
import { listMyWorkspaces } from '../lib/stella/workspaces';
import { listNoteFavorites, setNoteFavorites } from '../lib/stella/favorites';
import { createAIService } from './ai-service';
import { CHAT_LIMITS, answerQuery, askAssistant, excerptFor, planQuery, rankRecords, toSources, todayIn } from '../lib/stella/ai-chat';
import { requireTransmission } from '../../../../shared/contracts/ai-policy.js';
import { retryPlan, transcribeErrorMessage, transcribeUploaded, uploadRecording } from '../lib/stella/transcribe';
import { agendaJudgeErrorMessage, judgeAgendaDiscussion } from '../lib/stella/agenda-judge';
import { File } from 'expo-file-system';
import { SUPABASE_URL, SUPABASE_KEY } from '../lib/stella/config';

let current = null;
let generation = 0;
const preferenceCache = new Map();
const listeners = new Set();
const sessionFlushers = new Set();
export function registerSessionFlush(flush) { sessionFlushers.add(flush); return () => sessionFlushers.delete(flush); }
export const runtimeSubscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) fn(); };
// Adapters whose data lives outside the local store (server sync records, server RPC caches) call this after they change.
export const emitRuntime = emit;
// Sync-engine context for one shared workspace (projects, team, invites are written to the engine directly).
export function syncContext(serverId) {
  const own = runtime();
  if (!serverId) throw new Error('서버에 연결된 공유 공간이 아닙니다');
  return { db: own.syncDb, transport: supabaseTransport, workspaceId: serverId, myAccountId: own.session.id };
}
export function runtime() { if (!current) throw new Error('로그인과 기기 저장소 초기화가 필요합니다'); return current; }
export const maybeRuntime = () => current;
export function aiPolicy(source) {
  const s = readPreference('settings', {}); const ws = runtime().store.getCurrentWorkspace();
  return { route: s.ai?.route ?? 'external', allowedProviders: s.ai?.allowedProviders ?? [],
    consent: s.ai?.consent ?? {}, timezone: s.setup?.timezone ?? 'Asia/Seoul',
    workspaceId: ws.personal ? null : ws.serverId,
    excluded: s.ai?.transmissionDisabled !== false || Boolean(source && readPreference(`ai-excluded:${source.id}`, false)) };
}

export function readPreference(key, fallback) {
  if (preferenceCache.has(key)) return preferenceCache.get(key);
  const r = current?.db.getFirstSync('select value from integration_preferences where key=?', [key]);
  const value = r ? JSON.parse(r.value) : fallback;
  if (current) preferenceCache.set(key, value);
  return value;
}
export function writePreference(key, value) {
  runtime().db.runSync('insert into integration_preferences(key,value) values(?,?) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
  preferenceCache.set(key, value);
  emit(); return value;
}

export async function gateway(path, body, { route = 'external', signal } = {}) {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('로그인이 필요합니다');
  // functions-js 2.57 has no AbortSignal option; use the same HTTP contract with an abortable transport.
  // No header means 'external' on the gateway. Send it only for self_hosted: a gateway whose CORS list lacks
  // x-ai-route (deployed v14) fails the browser preflight, which surfaces as "Failed to fetch" on web.
  const headers = { 'content-type': 'application/json', apikey: SUPABASE_KEY, authorization: `Bearer ${data.session.access_token}` };
  if (route !== 'external') headers['x-ai-route'] = route;
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/ai-gateway/${path}`, {
      method: 'POST', signal, headers, body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    // Offline, or the edge worker was recycled mid-request (its 503 has no CORS headers, so the browser only says
    // "Failed to fetch"). Not retried here: the gateway may already have counted the request.
    throw Object.assign(new Error('AI 서버와 연결이 끊겼어요. 잠시 후 다시 보내 주세요'), { code: 'NETWORK', cause: error });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(payload?.message ?? 'AI 서버 요청에 실패했습니다'), { code: payload?.code ?? 'NETWORK' });
  return payload;
}

// Web only: expo-sqlite's sync calls busy-wait with a short timeout, but the worker's first call
// loads WebAssembly and creates the OPFS file pool, which takes longer. If that first call is sync it
// throws "Sync operation timeout" while the worker finishes anyway, leaving later calls out of step.
// Start the worker with an async call first so every sync call afterwards finds it ready.
let webWarmup = null;
function warmUpWebSQLite() {
  if (Platform.OS !== 'web') return null;
  webWarmup ??= openDatabaseAsync(':memory:').then(db => db.closeAsync())
    .catch(error => { webWarmup = null; throw error; });
  return webWarmup;
}

// ---------------------------------------------------------------------
// 계정별 기기 DB 파일 정리
//   웹의 expo-sqlite는 브라우저 저장소(OPFS)에 파일을 최대 6개까지만 둘 수 있음 (계정 하나에 DB 2개 + 쓰는 동안 임시 파일).
//   탈퇴한 계정의 파일이 남아 있으면 새 계정(예: 탈퇴 후 같은 카카오로 다시 가입 = 새 계정 id)이 DB를 만들지 못함.
// ---------------------------------------------------------------------
const accountDbNames = id => [`planner-${id}.db`, `sync-${id}.db`];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const WEB_ACCOUNTS_KEY = 'planner.web.dbAccounts'; // 이 브라우저에 DB 파일이 있는 계정 id들
// 파일을 새로 만들 자리가 없을 때 expo-sqlite(웹)가 내는 오류들 (만드는 시점에 따라 메시지가 다름)
const isPoolFull = error => /unable to open database file|cannot create file|sqlite3_open_v2/i.test(String(error?.message ?? error));

function webAccounts() {
  try { return JSON.parse(globalThis.localStorage?.getItem(WEB_ACCOUNTS_KEY) || '[]'); } catch { return []; }
}
function rememberWebAccount(id, present) {
  if (Platform.OS !== 'web') return;
  try {
    const next = new Set(webAccounts());
    if (present) next.add(id); else next.delete(id);
    globalThis.localStorage.setItem(WEB_ACCOUNTS_KEY, JSON.stringify([...next]));
  } catch { /* 저장소를 못 써도 정리만 못 할 뿐 */ }
}

// ---------------------------------------------------------------------
// 기기 DB 연결 점검 (11/25)
//   웹에서 PC가 절전 모드에 들어갔다 깨어나면 브라우저가 SQLite 작업(Web Worker·OPFS 파일 연결)을 정리해,
//   열려 있던 연결이 빈 DB를 가리키는 일이 있었음 → "no such table: outbox · integration_preferences".
//   예전에는 같은 계정으로 다시 로그인해도 그 연결을 그대로 다시 써서 새로고침 전까지 로그인이 계속 실패했음.
//   이제: 세션을 다시 쓰기 전 · 앱이 다시 보일 때 · 창에 다시 들어올 때 · 인터넷이 돌아올 때 · 동기화 오류 때 점검하고,
//   깨졌으면 그 세션을 버리고(깨진 DB에는 쓰지 않음) 같은 계정으로 새로 엶.
//   빈 DB는 오류를 내지 않으므로 오류가 아니라 "꼭 있어야 하는 표가 있는지"로 판단함
// ---------------------------------------------------------------------
const REQUIRED_TABLES = { db: ['integration_preferences', 'outbox', 'memos'], sync: ['stella_outbox', 'stella_records'] };
function hasTables(handle, names) {
  const r = handle.getFirstSync(
    `select count(*) as n from sqlite_master where type = 'table' and name in (${names.map(() => '?').join(',')})`, names);
  return Number(r?.n ?? 0) === names.length;
}
/** 세션의 두 기기 DB가 쓸 수 있는 상태인지 (연결이 끊겼거나 빈 DB를 가리키면 false) */
export function deviceDbHealthy(own = current) {
  if (!own) return true;
  try { return hasTables(own.db, REQUIRED_TABLES.db) && hasTables(own.syncNative, REQUIRED_TABLES.sync); } catch { return false; }
}

/**
 * 세션 전용 DB 문: 세션이 버려지면(generation이 바뀌면) 이 객체로는 아무것도 실행하지 않음.
 *   웹 expo-sqlite는 같은 파일을 다시 열면 같은 SQLite 연결을 함께 씀(파일 이름으로 캐시). 그래서 버려진 세션의
 *   남은 동기화가 계속 쓰면 새 세션과 같은 연결에서 트랜잭션이 엉킴 → 버려진 순간부터 오류(SESSION_CLOSED)를 내게 함
 *   (트랜잭션 안에서 나면 그 트랜잭션은 되돌려짐)
 */
function sessionBoundDb(raw, session) {
  const gen = session.generation;
  return new Proxy(raw, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (session.generation !== gen) {
          throw Object.assign(new Error('SESSION_CLOSED: 기기 저장소 세션이 닫혔어요'), { code: 'SESSION_CLOSED' });
        }
        return value.apply(target, args);
      };
    },
  });
}

/** 다시 연 연결이 버려진 세션의 끝나지 않은 트랜잭션을 물려받았으면 되돌림 (같은 파일 = 같은 연결) */
function rollbackLeftoverTransaction(handle, name) {
  try {
    if (handle.isInTransactionSync?.()) {
      console.warn(`[device-db] ${name}: 끊긴 세션이 남긴 트랜잭션을 되돌립니다`);
      handle.execSync('ROLLBACK');
    }
  } catch (error) { console.warn(`[device-db] ${name}: 남은 트랜잭션을 확인하지 못했어요`, error); }
}

const ABANDON_WAIT_MS = 3000;
/**
 * 깨진 세션 버리기: 동기화·실시간·AI를 멈추고, 이미 돌고 있던 동기화가 끝나기를(최대 3초) 기다린 뒤 연결을 닫음.
 * 기다리지 않고 닫으면 그 동기화가 트랜잭션 중간(BEGIN 뒤)에 끊겨, 새로 연 세션과 트랜잭션이 엉킴
 * ("cannot start a transaction within a transaction"). 깨진 DB에 쓰는 정리(편집기 저장)는 하지 않음
 */
async function abandonSession(own) {
  own.session.generation = ++generation;
  try { own.appStateSubscription?.remove?.(); } catch { /* 이미 해제 */ }
  own.appStateSubscription = null;
  try { own.ai?.cancel(); } catch { /* 진행 중인 요청 없음 */ }
  try { own.stop?.(); } catch { /* 이미 멈춤 */ }
  own.stop = null;
  try { own.stopRealtime?.(); } catch { /* 이미 멈춤 */ }
  own.stopRealtime = null;
  if (current === own) current = null;
  preferenceCache.clear();
  // 브리지는 일을 한 줄로 돌리므로, 맨 뒤에 넣은 일이 끝나면 앞의 일도 끝난 것 (깨진 DB라 실패해도 됨)
  let timer;
  await Promise.race([
    Promise.resolve().then(() => own.bridge.refresh('__none__')).catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, ABANDON_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  try { own.db.closeSync(); } catch { /* 이미 닫힘 */ }
  try { own.syncNative.closeSync(); } catch { /* 이미 닫힘 */ }
}

let recovering = null;
let reopening = false;   // 다시 열기 안에서 부르는 openSession인지 (그 밖의 openSession은 다시 열기가 끝나기를 기다림)
/**
 * 기기 DB 연결이 깨졌으면 같은 계정으로 새로 엶. 멀쩡하면 아무것도 안 함. 여러 곳에서 동시에 불러도 한 번만 엶.
 *   반환: 새(또는 그대로인) 세션. 다시 열지 못하면 오류
 */
export function recoverDeviceDb(reason) {
  if (recovering) return recovering;
  const own = current;
  if (!own || deviceDbHealthy(own)) return Promise.resolve(own);
  console.warn('[device-db] 기기 저장소 연결이 끊겨 다시 엽니다', reason?.message ?? reason ?? '');
  recovering = (async () => {
    await abandonSession(own);
    reopening = true;
    try { return await openSession(own.user); } finally { reopening = false; }
  })()
    .catch((error) => { console.error('[device-db] 기기 저장소를 다시 열지 못했어요. 페이지를 새로고침해 주세요', error); throw error; })
    .finally(() => { recovering = null; emit(); });
  return recovering;
}
const recoverQuietly = reason => { void recoverDeviceDb(reason).catch(() => {}); };

// 개발용(웹·__DEV__만, 배포 빌드에는 없음): 절전에서 깨어난 상태를 흉내 내서 점검·다시 열기를 확인
//   __plannerDevtools.breakDeviceDb() → 연결을 닫음 / .healthy() / .openSameAccount() = 같은 계정으로 다시 로그인하는 길
if (typeof __DEV__ !== 'undefined' && __DEV__ && Platform.OS === 'web') {
  let devUser = null;   // 끊은 순간의 계정 (자동 다시 열기가 먼저 돌면 current가 잠깐 비어 있음. 실제 로그인은 Supabase가 계정을 넘김)
  globalThis.__plannerDevtools = {
    healthy: () => deviceDbHealthy(),
    breakDeviceDb: () => { devUser = current?.user ?? devUser; current?.db.closeSync(); return 'closed'; },
    openSameAccount: async () => { const s = await openSession(current?.user ?? devUser); return { healthy: deviceDbHealthy(s), generation: s.session.generation }; },
    generation: () => current?.session.generation ?? null,
  };
}

// 브라우저에 "이 사이트 데이터를 지우지 말아 달라"고 한 번 요청 (저장 공간이 부족할 때 기기 DB가 지워지지 않게).
//   절전 모드로 연결이 끊기는 것은 막지 못함 → 위의 점검·다시 열기가 맡음
let persistAsked = false;
function requestPersistentStorage() {
  if (Platform.OS !== 'web' || persistAsked) return;
  persistAsked = true;
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.persist !== 'function') return;
  void (async () => {
    try {
      if (await storage.persisted?.()) return;
      if (!(await storage.persist())) console.info('[device-db] 브라우저가 사이트 데이터 보관 요청을 받지 않았어요. 저장 공간이 부족하면 기기 기록이 지워질 수 있어요');
    } catch { /* 지원하지 않는 브라우저 */ }
  })();
}

/** 이 계정의 기기 DB 파일을 지움 (탈퇴 뒤). 이미 없으면 넘어감 */
async function deleteAccountFiles(id) {
  for (const name of accountDbNames(id)) {
    try { await deleteDatabaseAsync(name); } catch { /* 없는 파일 */ }
  }
  rememberWebAccount(id, false);
}

/**
 * (웹) 저장 공간이 가득 찼을 때: 다른 계정의 DB 중 탈퇴로 이미 비워진 것(설정·메모·일정이 하나도 없음)만 지움.
 * 기록이 남아 있는 계정(로그아웃만 한 계정)의 파일은 건드리지 않음. 지운 계정 수를 돌려줌
 */
async function freeWebSpace(exceptId) {
  const candidates = new Set(webAccounts());
  try {
    for (const key of Object.keys(globalThis.localStorage ?? {})) for (const m of key.matchAll(UUID_RE)) candidates.add(m[0].toLowerCase());
  } catch { /* 저장소를 못 읽으면 목록만으로 */ }
  candidates.delete(exceptId.toLowerCase());
  let freed = 0;
  for (const id of candidates) {
    let db;
    try { db = await openDatabaseAsync(`planner-${id}.db`); } catch { continue; } // 파일이 없거나 열 수 없음
    let wiped = false;
    try {
      const has = async table => (await db.getFirstAsync('select count(*) as n from sqlite_master where type=\'table\' and name=?', [table])).n > 0;
      const count = async table => ((await has(table)) ? (await db.getFirstAsync(`select count(*) as n from ${table}`)).n : 0);
      wiped = (await count('integration_preferences')) === 0 && (await count('memos')) === 0 && (await count('tasks')) === 0;
    } catch {
      wiped = false;
    } finally {
      await db.closeAsync().catch(() => {});
    }
    if (wiped) { await deleteAccountFiles(id); freed += 1; }
  }
  return freed;
}

export async function openSession(user, { retried = false } = {}) {
  try {
    return await openSessionOnce(user);
  } catch (error) {
    if (Platform.OS !== 'web' || !isPoolFull(error)) throw error;
    if (!retried && (await freeWebSpace(user.id)) > 0) return openSession(user, { retried: true });
    throw new Error('이 브라우저의 기기 저장 공간이 가득 찼어요. 이 브라우저에서 다른 계정으로 쓰던 기록이 남아 있어서 새 계정의 저장소를 만들 수 없어요. 다른 계정으로 로그인해 정리하거나, 브라우저의 사이트 데이터를 지운 뒤 다시 시도해 주세요.');
  }
}

async function openSessionOnce(user) {
  // 기기 DB를 다시 여는 중이면 끝나기를 기다림 (그사이 current가 비어 있어 같은 계정을 두 번 열지 않게)
  if (recovering && !reopening) { try { await recovering; } catch { /* 아래에서 새로 엶 */ } }
  if (current?.session.id === user.id) {
    if (deviceDbHealthy(current)) return current;
    console.warn('[device-db] 같은 계정의 세션이 깨져 있어 새로 엽니다');   // 예전에는 깨진 세션을 그대로 돌려줘 로그인이 계속 실패했음
    await abandonSession(current);
  }
  await closeSession(false);
  if (!/^[0-9a-f-]{36}$/i.test(user.id)) throw new Error('유효한 계정 ID가 필요합니다');
  await warmUpWebSQLite();
  const db = openDatabaseSync(`planner-${user.id}.db`);
  let syncNative = null;
  try {
    // 이 브라우저에서 쓰던 계정인데 기기 DB가 비어 있으면(표가 하나도 없음) 기록을 잃은 것 → 화면에서 백업 복원을 안내
    let deviceDataMissing = false;
    if (Platform.OS === 'web' && webAccounts().includes(user.id)) {
      try { deviceDataMissing = !hasTables(db, ['integration_preferences']); } catch { deviceDataMissing = false; }
      if (deviceDataMissing) console.warn('[device-db] 이 브라우저에 있던 이 계정의 기기 기록을 찾지 못했어요');
    }
    syncNative = openDatabaseSync(`sync-${user.id}.db`);
    rollbackLeftoverTransaction(db, 'planner');
    rollbackLeftoverTransaction(syncNative, 'sync');
    const opened = await initSession(user, db, syncNative);
    opened.deviceDataMissing = deviceDataMissing;
    rememberWebAccount(user.id, true);
    requestPersistentStorage();
    return opened;
  } catch (error) {
    // A failed start must release both handles; otherwise the next attempt (e.g. the queued
    // onAuthStateChange) cannot reopen the same account files (web OPFS handles are exclusive).
    if (current?.db === db) current = null;
    try { db.closeSync(); } catch { /* already closed */ }
    try { syncNative?.closeSync(); } catch { /* already closed */ }
    throw error;
  }
}

// 자동 동기화 결과 중 사람이 봐야 하는 것만 콘솔에 남깁니다(막힌 보낼 목록·거절된 연결·오류).
//   예전에는 결과를 버려서, 휴대폰의 보낼 목록이 막혀도 아무 흔적이 없었습니다.
let lastSyncLog = '';
function logSyncProblems(out) {
  const lines = [];
  for (const [workspaceId, r] of Object.entries(out ?? {})) {
    if (r.status === 'ERROR') lines.push(`${workspaceId} ERROR ${r.code}: ${r.error}`);
    if (r.handOff) lines.push(`${workspaceId} 넘기기 막힘 seq=${r.handOff.seq} ${r.handOff.code}: ${r.handOff.error}`);
    const f = r.flush;
    if (f?.status === 'BLOCKED') lines.push(`${workspaceId} 보내기 막힘 seq=${f.outboxSeq} ${f.code}: ${f.error}`);
    if (f?.status === 'CONFLICT') lines.push(`${workspaceId} 충돌 seq=${f.outboxSeq}`);
    for (const l of f?.failedLinks ?? []) lines.push(`${workspaceId} 연결 거절(건너뜀) seq=${l.outboxSeq} ${l.code}: ${l.error}`);
  }
  const text = lines.join('\n');
  if (text && text !== lastSyncLog) console.warn(`[sync]\n${text}`);   // 같은 내용은 다시 찍지 않음 (재시도마다 반복 방지)
  lastSyncLog = text;
}

// ---------------------------------------------------------------------
// 다른 기기의 변경 받기
//   서버는 공유 공간이 바뀌면 Realtime으로 "바뀌었다" 신호만 보냅니다(realtime.ts). 신호가 오면 그 공간을 동기화합니다.
//   예전에는 구독하지 않아서, 웹 탭을 열어 둔 채로는 휴대폰에서 저장한 것이 탭을 다시 열기 전까지 보이지 않았습니다.
//   신호를 못 받는 경우(연결 끊김, Realtime 서버가 막 켜지는 중) 대비: 웹은 창에 다시 들어올 때·인터넷이 돌아올 때,
//   그리고 연결이 안 된 공간이 있으면 1분마다 한 번 받습니다.
// ---------------------------------------------------------------------
const SIGNAL_DELAY_MS = 300;       // 신호가 몰릴 때 묶는 시간
const FALLBACK_POLL_MS = 60_000;   // 신호 연결이 안 된 공간이 있을 때만

function startRealtime(own) {
  const channels = new Map();      // 서버 공간 id → { stop, connected }
  const timers = new Map();        // 서버 공간 id → 신호 묶음 타이머
  let stopped = false;

  // 기기 DB가 깨졌으면 동기화 대신 다시 열기 (다시 연 세션이 자기 실시간 구독을 새로 만듦)
  const healthy = (why) => {
    if (deviceDbHealthy(own)) return true;
    recoverQuietly(why);
    return false;
  };
  const syncServerWorkspace = serverId => {
    if (stopped || current !== own || !healthy('실시간 신호')) return;
    let ws;
    try { ws = own.store.getWorkspaces().find(w => w.serverId === serverId); } catch (error) { recoverQuietly(error); return; }
    if (!ws) return;
    void own.bridge.syncWorkspace(ws.id)
      .then(result => { logSyncProblems({ [ws.id]: result }); if (current === own) emit(); })
      .catch(error => { console.warn('[sync] 신호를 받고 동기화하지 못했습니다', error); recoverQuietly(error); });
  };
  const schedule = serverId => {
    if (stopped || timers.has(serverId)) return;
    timers.set(serverId, setTimeout(() => { timers.delete(serverId); syncServerWorkspace(serverId); }, SIGNAL_DELAY_MS));
  };
  const syncAll = () => {
    if (stopped || current !== own || !healthy('창으로 돌아옴·인터넷 연결·주기 확인')) return;
    void own.bridge.syncAll()
      .then(out => { logSyncProblems(out); if (current === own) emit(); })
      .catch(error => { console.warn('[sync] 동기화하지 못했습니다', error); recoverQuietly(error); });
  };

  // 기기에 있는 공유 공간과 구독을 맞춤 (새로 들어간 공간은 구독, 나간 공간은 해제)
  const reconcile = () => {
    if (stopped) return;
    let want;
    try {
      want = new Set(own.store.getWorkspaces().filter(w => !w.personal && w.serverId).map(w => w.serverId));
    } catch (error) { recoverQuietly(error); return; }
    for (const [serverId, ch] of channels) if (!want.has(serverId)) { ch.stop(); channels.delete(serverId); }
    for (const serverId of want) {
      if (channels.has(serverId)) continue;
      const ch = { connected: false, stop: () => {} };
      channels.set(serverId, ch);
      ch.stop = subscribeWorkspace(supabase, serverId, {
        onSignal: () => schedule(serverId),
        onStatus: (status, detail) => {
          const was = ch.connected;
          ch.connected = status === 'connected';
          // 연결(재연결 포함)되면 끊긴 동안 놓친 것을 받음. 권한이 없으면 받아 보면서 공간을 닫음
          if (status === 'connected' || status === 'denied') schedule(serverId);
          if (status !== 'connected' && (was || status === 'denied')) console.warn(`[realtime] ${serverId} ${status}${detail ? `: ${detail}` : ''}`);
        },
      });
    }
  };
  reconcile();
  const unsubscribeWorkspaces = own.store.subscribeWorkspaces(reconcile);

  const poll = setInterval(() => {
    if (!healthy('1분 점검')) return;                    // 공유 공간이 없어도 기기 DB는 점검 (절전에서 깨어난 뒤)
    if ([...channels.values()].some(ch => !ch.connected)) syncAll();
  }, FALLBACK_POLL_MS);

  // 웹: 창에 다시 들어올 때(탭 전환이 아니라 다른 창에서 돌아올 때도), 인터넷이 다시 연결될 때
  const win = Platform.OS === 'web' && typeof globalThis.addEventListener === 'function' ? globalThis : null;
  win?.addEventListener('focus', syncAll);
  win?.addEventListener('online', syncAll);
  win?.addEventListener('pageshow', syncAll);   // 뒤로·앞으로 캐시에서 페이지가 되살아날 때

  return () => {
    stopped = true;
    clearInterval(poll);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    win?.removeEventListener('focus', syncAll);
    win?.removeEventListener('online', syncAll);
    win?.removeEventListener('pageshow', syncAll);
    unsubscribeWorkspaces?.();
    for (const ch of channels.values()) ch.stop();
    channels.clear();
  };
}

async function initSession(user, db, syncNative) {
  db.execSync('create table if not exists integration_preferences(key text primary key,value text not null)');
  const session = { id: user.id, generation: ++generation };
  // 저장소·동기화 엔진은 이 세션 전용 DB 문으로만 씀 (세션이 버려지면 바로 막힘). current.db·syncNative는 닫기용 원래 핸들
  const store = createLocalStore({ db: sessionBoundDb(db, session), newId: randomUUID });
  store.bindAccount(user.id);
  const syncDb = expoSqliteDb(sessionBoundDb(syncNative, session));
  await engine.setupLocalSync(syncDb);
  // Both files are account-scoped. Never reuse or wipe another account's pending DB on sign-in.
  await engine.bindSyncAccount(syncDb, user.id);
  const bridge = createBridge({ store, engine, db: syncDb, transport: supabaseTransport, accountId: user.id,
    favorites: { set: (ws, ids, on) => setNoteFavorites(supabase, ws, ids, on), list: ws => listNoteFavorites(supabase, ws) },
    workspaces: { list: async () => (await listMyWorkspaces()).map(m => ({ id: m.workspace.id, name: m.workspace.name,
      description: m.workspace.description, role: m.role })) },
  });
  current = { db, syncNative, syncDb, store, bridge, session, user, stop: null, stopRealtime: null, appStateSubscription: null, ai: null, deviceDataMissing: false };
  preferenceCache.clear();
  const own = current;
  current.ai = createAIService({ store, gateway, newId: randomUUID,
    getSession: () => current?.session,
    getPolicy: aiPolicy,
  });
  current.stop = bridge.start({
    onResult: (out) => { logSyncProblems(out); if (current === own) emit(); },
    onError: (error) => { console.warn('[sync] 동기화하지 못했습니다', error); recoverQuietly(error); },
  });
  current.stopRealtime = startRealtime(own);
  // 앱이 다시 보일 때(절전·백그라운드에서 돌아옴): 기기 DB가 깨졌으면 다시 열고, 멀쩡하면 바로 동기화
  current.appStateSubscription = AppState.addEventListener('change', (nextState) => {
    if (nextState !== 'active' || current !== own) return;
    if (!deviceDbHealthy(own)) { recoverQuietly('앱이 다시 보임'); return; }
    void own.bridge.syncAll().catch(error => { if (current === own) console.warn('[sync] 앱 활성화 시 동기화하지 못했습니다', error); });
  });
  store.subscribe(emit); emit();
  return current;
}

// Chat attachment photo → text (cloud OCR). Same consent gate as chat; local AI has no image model here.
export async function ocrForChat(base64, signal) {
  const own = runtime();
  const policy = aiPolicy();
  if (policy.route !== 'external') throw Object.assign(new Error('사진 글자 인식은 클라우드 AI에서만 쓸 수 있어요'), { code: 'ROUTE_UNSUPPORTED' });
  requireTransmission(policy.route, [policy], policy.consent);
  const r = await gateway('ocr', { client_request_id: randomUUID(), images: [{ base64 }], hint: '채팅에 첨부한 사진', workspace_id: policy.workspaceId },
    { route: policy.route, signal });
  if (current !== own || signal?.aborted) throw new Error('요청이 취소됐습니다');
  return r.draft;
}

// Recording → text (gateway /transcribe, cloud AI only). Same consent gate as chat.
//   job: { uri, seconds, uploadId, requestId, uploaded } — kept by the caller so a retry follows lib/stella
//   retryPlan: same request, new request on the same upload, or upload again (see newTranscribeJob/nextTranscribeJob).
//   The server deletes the uploaded audio after a successful transcription (kept 3 days after a failure).
export const newTranscribeJob = (uri, seconds) => ({ uri, seconds, uploadId: randomUUID(), requestId: randomUUID(), uploaded: false });
export function nextTranscribeJob(job, code) {
  const plan = retryPlan(code);
  if (plan === 'new_request_same_upload') return { ...job, requestId: randomUUID() };
  if (plan === 'reupload') return { ...job, uploadId: randomUUID(), requestId: randomUUID(), uploaded: false };
  return job; // same_request, or stop (the screen shows the message and the user may try again later)
}
async function readAudio(uri) {
  if (Platform.OS === 'web') {
    // expo-audio on web records to a blob: URL (usually audio/webm). Storage rejects mime parameters such as ;codecs=opus
    const blob = await (await fetch(uri)).blob();
    const type = (blob.type || 'audio/webm').split(';')[0].trim();
    return { bytes: blob, mimeType: type, fileName: `recording.${type.split('/')[1] || 'webm'}` };
  }
  const ext = (uri.split('?')[0].match(/\.(\w+)$/)?.[1] ?? 'm4a').toLowerCase();
  const mime = { m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/mp4', caf: 'audio/x-caf', wav: 'audio/wav', mp3: 'audio/mpeg', webm: 'audio/webm', ogg: 'audio/ogg' }[ext] ?? 'audio/mp4';
  return { bytes: await new File(uri).bytes(), mimeType: mime, fileName: `recording.${ext}` };
}
/** Returns { text, remainingMinutes, job } on success; throws { code, message, job } (job = what to retry with). */
export async function transcribeForDevice(job) {
  const own = runtime();
  const policy = aiPolicy();
  if (policy.route !== 'external') throw Object.assign(new Error('녹음 변환은 클라우드 AI에서만 쓸 수 있어요'), { code: 'ROUTE_UNSUPPORTED', job });
  requireTransmission(policy.route, [policy], policy.consent);
  let step = job;
  try {
    if (!step.uploaded) {
      const audio = await readAudio(step.uri);
      await uploadRecording(supabase, { uploadId: step.uploadId, ...audio });
      step = { ...step, uploaded: true };
    }
    const r = await transcribeUploaded(supabase, {
      clientRequestId: step.requestId, uploadId: step.uploadId, durationSeconds: Math.max(1, step.seconds || 1), workspaceId: policy.workspaceId,
    });
    if (current !== own) throw Object.assign(new Error('계정이 바뀌었습니다'), { code: 'CANCELLED' });
    return { text: r.text, remainingMinutes: r.remainingMinutes, job: step };
  } catch (e) {
    const code = e?.code ?? 'UNKNOWN';
    throw Object.assign(new Error(code === 'CANCELLED' ? e.message : transcribeErrorMessage(e)), { code, job: nextTranscribeJob(step, code) });
  }
}

// Agenda compare: was each changed item talked about in that day's meeting notes? (gateway /agenda/judge,
// cloud AI only, same consent gate as chat). Same input is answered from lib/stella's in-memory cache.
export async function judgeAgendaForDevice({ changes, discussions, projectTitle, date }) {
  const own = runtime();
  const policy = aiPolicy();
  if (policy.route !== 'external') throw Object.assign(new Error('안건 판단은 클라우드 AI에서만 쓸 수 있어요'), { code: 'ROUTE_UNSUPPORTED' });
  requireTransmission(policy.route, [policy], policy.consent);
  const ws = policy.workspaceId;
  const r = await judgeAgendaDiscussion(supabase, {
    changes: changes.map(c => ({ ...c, workspaceId: ws })), discussions: discussions.map(d => ({ ...d, workspaceId: ws })),
    newId: randomUUID, projectTitle, date, timezone: policy.timezone,
  });
  if (current !== own) throw Object.assign(new Error('계정이 바뀌었습니다'), { code: 'CANCELLED' });
  return r;
}
export { agendaJudgeErrorMessage };

// Chat title from the conversation (gateway "organize" makes a ≤40-char title). Same consent gate as chat;
// counts toward the monthly organize limit. Only the question and answer text are sent, not the sources.
export async function titleForChat(question, answer, signal) {
  const own = runtime();
  const policy = aiPolicy();
  requireTransmission(policy.route, [policy], policy.consent);
  const text = `채팅 대화의 제목을 정하기 위한 내용입니다.\n\n질문: ${question}\n\n답변: ${answer}`.slice(0, 4000);
  const r = await gateway('organize', { client_request_id: randomUUID(), text, workspace_id: policy.workspaceId }, { route: policy.route, signal });
  if (current !== own || signal?.aborted) throw new Error('요청이 취소됐습니다');
  return String(r.draft?.title ?? '').trim();
}

// Attachments (already turned into text on this device) go first; device records found by the planner follow.
function mergeSources(attached, ranked, keywords) {
  const out = [];
  let total = 0;
  for (const a of attached.slice(0, 3)) {
    const text = excerptFor(a.text, keywords, CHAT_LIMITS.sourceChars);
    out.push({ id: a.id, type: 'file', title: a.title.slice(0, 200), date: null, text, workspace_id: a.workspaceId ?? null });
    total += a.title.length + text.length;
  }
  for (const s of toSources(ranked, keywords)) {
    if (out.length >= CHAT_LIMITS.sources || total + s.title.length + s.text.length > CHAT_LIMITS.sourcesTotalChars) break;
    out.push(s); total += s.title.length + s.text.length;
  }
  return out;
}

export async function askFromDevice(question, signal, { history = [], attachments = [] } = {}) {
  const own = runtime(); const generation = own.session.generation;
  const ws = own.store.getCurrentWorkspace().id;
  const policy = aiPolicy();
  requireTransmission(policy.route, [policy], policy.consent);
  const records = [
    ...own.store.getMemos().map(m => ({ id: m.id, type: 'memo', title: m.title, text: m.body, revision: m.revision, date: new Date(m.updatedAt).toISOString() })),
    ...own.store.getTasks().map(t => ({ id: t.id, type: t.kind, title: t.title, text: t.desc, revision: t.revision, date: t.date, status: t.status === '완료' ? 'done' : 'open' })),
  ].filter(r => !aiPolicy(r).excluded).map(r => ({ ...r, workspaceId: policy.workspaceId }));
  const checkSnapshot = () => {
    if (signal?.aborted || current !== own || own.session.generation !== generation) throw new Error('요청이 취소됐습니다');
    if (own.store.getCurrentWorkspace().id !== ws) throw new Error('작업 공간이 바뀌었습니다');
    requireTransmission(policy.route, [aiPolicy()], aiPolicy().consent);
    for (const record of records) {
      const now = record.type === 'memo' ? own.store.getMemo(record.id) : own.store.getTask(record.id);
      if (!now || now.deletedAt || now.revision !== record.revision) throw new Error('검색 대상 기록이 바뀌었습니다. 다시 질문해 주세요');
      requireTransmission(policy.route, [aiPolicy(now)], aiPolicy().consent);
    }
  };
  const client = { functions: { invoke: async (name, options) => {
    // Recheck before each hop: the query planner may finish after consent or a source changes.
    checkSnapshot();
    return { data: await gateway(name.replace(/^ai-gateway\//, ''), options.body, { route: policy.route, signal }), error: null };
  } } };
  const turns = history.filter(t => t.text && (t.role === 'user' || t.role === 'assistant'));
  const attached = attachments.filter(a => a.text).map(a => ({ id: a.id, title: a.name, text: a.text, workspaceId: policy.workspaceId }));
  let answer;
  if (!attached.length) {
    answer = await askAssistant(client, { question, history: turns, newId: randomUUID, timezone: policy.timezone, findRecords: async () => records });
  } else {
    // The user handed over material: answer from it even when the planner sees no record search in the question.
    const plan = await planQuery(client, { clientRequestId: randomUUID(), question, history: turns, timezone: policy.timezone });
    const ranked = plan.intent === 'search' ? rankRecords(records, plan, { today: todayIn(policy.timezone) }) : [];
    const sources = mergeSources(attached, ranked, plan.keywords ?? []);
    const { answer: a } = await answerQuery(client, { clientRequestId: randomUUID(), question, history: turns, timezone: policy.timezone, sources });
    const byId = new Map(sources.map(s => [s.id, s]));
    answer = { text: a.answer, sources: a.used_source_ids.filter(id => byId.has(id)).map(id => ({ id, type: byId.get(id).type, title: byId.get(id).title || '(제목 없음)' })) };
  }
  checkSnapshot();
  if (signal?.aborted || current !== own || own.session.generation !== generation) throw new Error('요청이 취소됐습니다');
  if (own.store.getCurrentWorkspace().id !== ws) throw new Error('작업 공간이 바뀌었습니다');
  const attachedIds = new Set(attached.map(a => a.id));
  for (const ref of answer.sources) {
    if (attachedIds.has(ref.id)) continue; // attachments are not device records
    const before = records.find(r => r.id === ref.id); const after = before?.type === 'memo' ? own.store.getMemo(ref.id) : own.store.getTask(ref.id);
    if (!after || after.revision !== before.revision || aiPolicy(after).excluded) throw new Error('답변에 사용한 원본이 바뀌었습니다. 다시 질문해 주세요');
  }
  requireTransmission(policy.route, [aiPolicy()], aiPolicy().consent);
  return { ...answer, sources: answer.sources.map(s => ({ ...s, route: attachedIds.has(s.id) ? null : s.type === 'memo' ? 'MemoEdit' : 'TaskEdit' })) };
}

// After account withdrawal: erase this account's device data (personal records live only here), then close.
export async function wipeSessionData() {
  const own = current;
  if (!own) return;
  if (!deviceDbHealthy(own)) {                       // 깨진 연결: 지울 내용을 읽을 수 없으니 파일째 지움
    await abandonSession(own); emit();
    await deleteAccountFiles(own.session.id);
    return;
  }
  own.session.generation = ++generation;
  own.ai.cancel(); own.stop?.(); own.stop = null;
  own.stopRealtime?.(); own.stopRealtime = null;
  await own.bridge.refresh('__none__');
  own.store.clearAll();
  own.db.runSync('delete from integration_preferences');
  preferenceCache.clear();
  await engine.clearLocalSync(own.syncDb);
  await closeSession(false);
  // 탈퇴한 계정의 빈 DB 파일까지 지움 (웹은 저장 공간이 작아서, 남겨 두면 새 계정이 DB를 못 만듦)
  await deleteAccountFiles(own.session.id);
}

export async function closeSession(requireSynced = true) {
  const own = current;
  if (!own) return;
  // 기기 DB 연결이 깨졌으면 저장·확인할 수 없음: 그대로 놓아 줌 (예전에는 여기서 오류가 나 로그아웃도 못 했음)
  if (!deviceDbHealthy(own)) { await abandonSession(own); emit(); return; }
  // Persist mounted editor drafts while their original account DB is still open.
  for (const flush of sessionFlushers) flush({ analyze: false });
  if (requireSynced) {
    const status = await own.bridge.status();
    if (status.unsent > 0 || status.state === 'attention') throw new Error('미전송 변경이나 충돌이 있습니다. 동기화 후 로그아웃해 주세요');
  }
  own.session.generation = ++generation;
  own.ai.cancel(); own.stop?.();
  own.appStateSubscription?.remove?.(); own.appStateSubscription = null;
  own.stopRealtime?.(); own.stopRealtime = null;
  // Drain bridge serialization before closing either database. Late results cannot target a new session.
  await own.bridge.refresh('__none__');
  if (current === own) current = null;
  preferenceCache.clear();
  own.db.closeSync(); own.syncNative.closeSync(); emit();
}
