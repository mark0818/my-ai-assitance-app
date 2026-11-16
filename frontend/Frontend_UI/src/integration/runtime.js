import { Platform } from 'react-native';
import { openDatabaseAsync, openDatabaseSync } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { createLocalStore, createBridge } from '../../../../backend/local/src/index.js';
import * as engine from '../lib/stella/local-sync';
import { expoSqliteDb } from '../lib/stella/sqlite-expo';
import { supabaseTransport } from '../lib/stella/sync';
import { supabase } from '../lib/stella/supabase';
import { listMyWorkspaces } from '../lib/stella/workspaces';
import { listNoteFavorites, setNoteFavorites } from '../lib/stella/favorites';
import { createAIService } from './ai-service';
import { CHAT_LIMITS, answerQuery, askAssistant, excerptFor, planQuery, rankRecords, toSources, todayIn } from '../lib/stella/ai-chat';
import { requireTransmission } from '../../../../shared/contracts/ai-policy.js';
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

export async function openSession(user) {
  if (current?.session.id === user.id) return current;
  await closeSession(false);
  if (!/^[0-9a-f-]{36}$/i.test(user.id)) throw new Error('유효한 계정 ID가 필요합니다');
  await warmUpWebSQLite();
  const db = openDatabaseSync(`planner-${user.id}.db`);
  let syncNative = null;
  try {
    syncNative = openDatabaseSync(`sync-${user.id}.db`);
    return await initSession(user, db, syncNative);
  } catch (error) {
    // A failed start must release both handles; otherwise the next attempt (e.g. the queued
    // onAuthStateChange) cannot reopen the same account files (web OPFS handles are exclusive).
    if (current?.db === db) current = null;
    try { db.closeSync(); } catch { /* already closed */ }
    try { syncNative?.closeSync(); } catch { /* already closed */ }
    throw error;
  }
}

async function initSession(user, db, syncNative) {
  db.execSync('create table if not exists integration_preferences(key text primary key,value text not null)');
  const store = createLocalStore({ db, newId: randomUUID });
  store.bindAccount(user.id);
  const session = { id: user.id, generation: ++generation };
  const syncDb = expoSqliteDb(syncNative);
  await engine.setupLocalSync(syncDb);
  // Both files are account-scoped. Never reuse or wipe another account's pending DB on sign-in.
  await engine.bindSyncAccount(syncDb, user.id);
  const bridge = createBridge({ store, engine, db: syncDb, transport: supabaseTransport, accountId: user.id,
    favorites: { set: (ws, ids, on) => setNoteFavorites(supabase, ws, ids, on), list: ws => listNoteFavorites(supabase, ws) },
    workspaces: { list: async () => (await listMyWorkspaces()).map(m => ({ id: m.workspace.id, name: m.workspace.name,
      description: m.workspace.description, role: m.role })) },
  });
  current = { db, syncNative, syncDb, store, bridge, session, stop: null, ai: null };
  preferenceCache.clear();
  const own = current;
  current.ai = createAIService({ store, gateway, newId: randomUUID,
    getSession: () => current?.session,
    getPolicy: aiPolicy,
  });
  current.stop = bridge.start({ onResult: () => { if (current === own) emit(); } });
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
  own.session.generation = ++generation;
  own.ai.cancel(); own.stop?.(); own.stop = null;
  await own.bridge.refresh('__none__');
  own.store.clearAll();
  own.db.runSync('delete from integration_preferences');
  preferenceCache.clear();
  await engine.clearLocalSync(own.syncDb);
  await closeSession(false);
}

export async function closeSession(requireSynced = true) {
  const own = current;
  if (!own) return;
  // Persist mounted editor drafts while their original account DB is still open.
  for (const flush of sessionFlushers) flush({ analyze: false });
  if (requireSynced) {
    const status = await own.bridge.status();
    if (status.unsent > 0 || status.state === 'attention') throw new Error('미전송 변경이나 충돌이 있습니다. 동기화 후 로그아웃해 주세요');
  }
  own.session.generation = ++generation;
  own.ai.cancel(); own.stop?.();
  // Drain bridge serialization before closing either database. Late results cannot target a new session.
  await own.bridge.refresh('__none__');
  if (current === own) current = null;
  preferenceCache.clear();
  own.db.closeSync(); own.syncNative.closeSync(); emit();
}
