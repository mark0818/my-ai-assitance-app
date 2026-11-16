// AI chat history. Kept on this device only (per account and workspace): answers quote memo and task excerpts,
// and personal records never leave the device except for the question being asked.
import { readPreference, scoped, useValue, writePreference, maybeRuntime } from '../hooks';

export const MAX_CHATS = 50;
const MAX_MESSAGES = 100;
const EMPTY = Object.freeze([]);
const key = () => scoped('ai-chats');
// readPreference caches the first fallback for a key: always read with the same one.
export const getChats = () => (maybeRuntime() ? readPreference(key(), EMPTY) ?? EMPTY : EMPTY);
export const useChats = () => useValue(getChats);
export const getChat = id => getChats().find(c => c.id === id) ?? null;

const titleOf = messages => {
  const first = messages.find(m => m.role === 'user')?.text ?? '';
  return first.replace(/\s+/g, ' ').trim().slice(0, 40) || '새 대화';
};
// Only what the screen needs to show the conversation again (no in-flight or attachment payloads).
const clean = m => ({
  id: m.id, role: m.role, text: m.text, error: !!m.error,
  attachments: (m.attachments ?? []).map(a => ({ id: a.id, name: a.name, kind: a.kind })),
  sources: (m.sources ?? []).map(s => ({ id: s.id, type: s.type, title: s.title, route: s.route ?? null })),
});

export function saveChat(id, messages) {
  const done = messages.filter(m => m.role === 'user' || m.done || m.error).map(clean).slice(-MAX_MESSAGES);
  if (!done.length) return;
  const chat = { id, title: titleOf(done), updatedAt: Date.now(), messages: done };
  writePreference(key(), [chat, ...getChats().filter(c => c.id !== id)].slice(0, MAX_CHATS));
}
export const deleteChat = id => writePreference(key(), getChats().filter(c => c.id !== id));
export const deleteAllChats = () => writePreference(key(), EMPTY);
