// ============================================================
// AiChatScreen.js — AI 채팅 화면
//   이전 대화(기기에 저장) · 새 채팅 · 사진/파일 첨부 · 클라우드/로컬 AI 선택
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { randomUUID } from 'expo-crypto';
import { askFromDevice } from '../../../integration/runtime';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { openParams } from '../../../data/memos/MemoStore';
import { AI_ROUTE_LABEL, LOCAL_AI_AVAILABLE, addUsage, setAiRoute, setAiTransmission, useSettings } from '../../../data/settings/SettingsStore';
import { deleteChat, saveChat, useChats } from '../../../data/ai/ChatStore';
import { MAX_ATTACHMENTS, describe, extract, pickAttachments } from '../../../services/ai/ChatAttachments';
import { chatErrorMessage } from '../../../lib/stella/ai-chat';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

// 대화가 비어 있을 때 보여줄 "추천 질문" 버튼들. 누르면 그 문장이 바로 전송됩니다.
const SUGGESTIONS = ['중간고사 일정 알려줘', '회의 내용 요약해줘', '발표 자료 어디 있어?', '장보기 목록 알려줘'];
const ATTACH_ONLY_QUESTION = '첨부한 자료를 요약해줘';

// 오류 코드 → 화면 문구 (정책 검사·서버 오류 모두)
function errorText(error) {
  const code = error?.code ?? '';
  if (code === 'CONSENT_REQUIRED' || code === 'TRANSMISSION_DENIED') return 'AI로 자료 보내기가 꺼져 있어요. 위의 [허용하기]를 눌러 주세요';
  if (code === 'NO_SOURCES') return '보낼 수 있는 자료가 없어요';
  if (code === 'NETWORK') return error.message; // 오프라인 · 서버 작업자 재시작 (runtime.gateway 문구)
  return chatErrorMessage(error);
}
const pad = (n) => String(n).padStart(2, '0');
const when = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ------------------------------------------------------------
// 입력 중 표시 (● ● ● 가 차례로 깜빡임)
// ------------------------------------------------------------
function TypingDots() {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.3, duration: 300, useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);
  return (
    <View style={styles.aiRow}>
      <View style={styles.avatar}>
        <Text style={styles.avatarIcon}>✦</Text>
      </View>
      <View style={[styles.aiBubble, styles.dotsBubble]}>
        {dots.map((v, i) => (
          <Animated.View key={i} style={[styles.dot, { opacity: v }]} />
        ))}
      </View>
    </View>
  );
}

// ------------------------------------------------------------
// 말풍선 하나 (내 메시지 / AI 메시지)
// ------------------------------------------------------------
function MessageBubble({ message, onOpenSource }) {
  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        {message.attachments?.length > 0 && (
          <View style={styles.sentFiles}>
            {message.attachments.map((a) => (
              <View key={a.id} style={styles.sentFile}>
                <Text style={styles.sentFileText} numberOfLines={1}>{a.kind === 'image' ? '사진 · ' : '파일 · '}{a.name}</Text>
              </View>
            ))}
          </View>
        )}
        <View style={styles.userBubble}>
          <Text style={styles.userText} selectable>{message.text}</Text>
        </View>
      </View>
    );
  }

  const sources = message.done && message.sources ? message.sources : [];
  return (
    <View style={styles.aiRow}>
      <View style={styles.avatar}>
        <Text style={styles.avatarIcon}>✦</Text>
      </View>
      <View style={styles.aiCol}>
        <View style={[styles.aiBubble, styles.aiBubbleFit, message.error && styles.errorBubble]}>
          <Text style={[styles.aiText, message.error && styles.errorText]} selectable>{message.text}</Text>
        </View>
        {sources.length > 0 && (
          <View style={styles.sources}>
            <Text style={styles.sourcesLabel}>출처{sources.some((s) => s.route) ? ' · 누르면 해당 위치로 이동해요' : ''}</Text>
            <View style={styles.sourceChips}>
              {sources.map((src) => (
                <Pressable
                  key={src.id}
                  accessibilityRole={src.route ? 'button' : 'text'}
                  accessibilityLabel={src.route ? `출처 ${src.title} 열기` : `첨부 ${src.title}`}
                  disabled={!src.route}
                  onPress={() => onOpenSource(src)}
                  style={({ pressed }) => [styles.sourceChip, pressed && { opacity: 0.6 }]}
                >
                  <Text style={styles.sourceText} numberOfLines={1}>
                    {src.route ? (src.type === 'memo' ? '메모 · ' : '일정 · ') : '첨부 · '}{src.title}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

export default function AiChatScreen({ navigation }) {
  const menuSwipe = useSwipeToOpenMenu();
  const insets = useSafeAreaInsets();
  const settings = useSettings();
  const ai = settings.ai ?? {};
  const route = ai.route === 'self_hosted' ? 'self_hosted' : 'external';
  const routeReady = route === 'external' || LOCAL_AI_AVAILABLE;
  const allowed = !ai.transmissionDisabled && ai.consent?.[route] === true;
  const chats = useChats();

  // ---------- 상태 ----------
  const [chatId, setChatId] = useState(() => randomUUID()); // 지금 대화의 기록 id
  const [messages, setMessages] = useState([]);              // { id, role, text, done, sources, attachments, error }
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('idle');              // 'idle' | 'thinking' | 'streaming'
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [attachments, setAttachments] = useState([]);        // 보내기 전 첨부 { id, name, kind, status, text, error }
  // 이 대화에서 이미 보낸 첨부의 글자: 뒤이은 질문("예산은?")에도 같이 보냄. 기기 기록에는 저장하지 않음
  const chatFiles = useRef([]);
  const [panel, setPanel] = useState(null);                  // 'history' | 'route' | 'attach' | null
  const [consentBusy, setConsentBusy] = useState(false);
  const [banner, setBanner] = useState('');

  const listRef = useRef(null);
  const timers = useRef({ think: null, type: null });
  const dirty = useRef(false);            // 이번 화면에서 새로 주고받은 내용이 있는지 (불러오기만 한 대화는 다시 저장 안 함)
  const extractAbort = useRef(null);
  const nextId = useCallback(() => randomUUID(), []);

  const clearTimers = useCallback(() => {
    clearTimeout(timers.current.think);
    clearInterval(timers.current.type);
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  useEffect(() => () => extractAbort.current?.abort(), []);

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, () => setKeyboardUp(true));
    const b = Keyboard.addListener(hideEvt, () => setKeyboardUp(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  // 답이 끝나면(쉬는 상태) 지금 대화를 기록에 저장
  useEffect(() => {
    if (status === 'idle' && dirty.current && messages.length) {
      dirty.current = false;
      saveChat(chatId, messages);
    }
  }, [status, messages, chatId]);

  // ---------- 첨부 ----------
  const addFiles = async (mode) => {
    setPanel(null);
    let assets;
    try { assets = await pickAttachments(mode); } catch { return setBanner('파일을 고르지 못했어요'); }
    const room = MAX_ATTACHMENTS - attachments.length;
    if (assets.length > room) setBanner(`첨부는 한 번에 ${MAX_ATTACHMENTS}개까지예요`);
    const items = assets.slice(0, Math.max(0, room)).map(describe);
    if (!items.length) return;
    setAttachments((prev) => [...prev, ...items]);
    extractAbort.current ??= new AbortController();
    const signal = extractAbort.current.signal;
    for (const item of items) {
      const done = await extract(item, signal);
      if (signal.aborted) return;
      setAttachments((prev) => prev.map((a) => (a.id === item.id ? done : a)));
    }
  };
  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));
  const reading = attachments.some((a) => a.status === 'reading');
  const ready = attachments.filter((a) => a.status === 'ready');

  // ---------- 메시지 보내기 ----------
  const requestRef = useRef(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  const send = useCallback(
    async (raw) => {
      const text = raw.trim() || (ready.length ? ATTACH_ONLY_QUESTION : '');
      if (!text || status !== 'idle' || reading) return;
      if (!routeReady) return setBanner('로컬 AI는 아직 연결 전이에요. 클라우드 AI로 바꿔 주세요');

      const aiId = nextId();
      const sentFiles = ready.map(({ id, name, kind, text: body }) => ({ id, name, kind, text: body }));
      const history = messages.filter((m) => !m.error && m.text).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text }));
      dirty.current = true;
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text, attachments: sentFiles }]);
      setInput('');
      setAttachments([]);
      extractAbort.current = null;
      setStatus('thinking');

      addUsage('question');
      const controller = new AbortController(); requestRef.current = controller;
      let answer;
      // 새 첨부가 앞, 앞서 보낸 첨부가 뒤 (서버에 한 번에 보내는 첨부는 최대 3개)
      chatFiles.current = [...sentFiles, ...chatFiles.current.filter((f) => !sentFiles.some((s) => s.id === f.id))].slice(0, MAX_ATTACHMENTS);
      try { answer = await askFromDevice(text, controller.signal, { history, attachments: chatFiles.current }); }
      catch (error) {
        if (!controller.signal.aborted) setMessages((prev) => [...prev, { id: aiId, role: 'ai', text: errorText(error), done: true, sources: [], error: true }]);
        if (requestRef.current === controller) setStatus('idle');
        return;
      }
      if (controller.signal.aborted || requestRef.current !== controller) return;
      const full = answer.text;

      timers.current.think = setTimeout(() => {
        setMessages((prev) => [...prev, { id: aiId, role: 'ai', text: '' }]);
        setStatus('streaming');
        let shown = 0;
        timers.current.type = setInterval(() => {
          shown = Math.min(full.length, shown + 2);
          const finished = shown >= full.length;
          setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, text: full.slice(0, shown), sources: answer.sources, done: finished } : m)));
          if (finished) {
            clearInterval(timers.current.type);
            setStatus('idle');
          }
        }, 30);
      }, 300);
    },
    [status, nextId, messages, ready, reading, routeReady],
  );

  // 정지: 지금까지 나온 글자는 남기고 멈춤
  const stop = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    clearTimers();
    setMessages((prev) => prev.map((m) => (m.role === 'ai' && !m.done ? { ...m, done: true } : m)));
    setStatus('idle');
  };

  // 진행 중인 답을 멈추고 화면을 비움 (지금 대화는 이미 기록에 저장돼 있음)
  const reset = (next = { id: randomUUID(), messages: [] }) => {
    requestRef.current?.abort();
    requestRef.current = null;
    clearTimers();
    extractAbort.current?.abort();
    extractAbort.current = null;
    if (dirty.current && messages.length) saveChat(chatId, messages.map((m) => (m.role === 'ai' ? { ...m, done: true } : m)));
    dirty.current = false;
    chatFiles.current = []; // 불러온 대화에는 첨부 글자가 없음 (기기에 저장하지 않음)
    setChatId(next.id);
    setMessages(next.messages);
    setAttachments([]);
    setInput('');
    setStatus('idle');
    setPanel(null);
  };
  const newChat = () => reset();
  const openChat = (chat) => reset({ id: chat.id, messages: chat.messages.map((m) => ({ ...m, done: true })) });

  // ---------- AI 선택 · 전송 허용 ----------
  const chooseRoute = (next) => {
    setPanel(null);
    if (next === route) return;
    if (next === 'self_hosted' && !LOCAL_AI_AVAILABLE) return;
    setAiRoute(next);
  };
  const allow = async () => {
    if (consentBusy) return;
    setConsentBusy(true);
    try { await setAiTransmission(route, true); setBanner(''); }
    catch (e) { setBanner(e.message); }
    finally { setConsentBusy(false); }
  };

  const canSend = (input.trim().length > 0 || ready.length > 0) && status === 'idle' && !reading && routeReady;

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.flex} {...menuSwipe}>
        <ScreenHeader
          title="AI 채팅"
          onBack={navigation.goBack}
          right={
            <Pressable accessibilityRole="button" accessibilityLabel="이전 대화" onPress={() => setPanel('history')} hitSlop={10}>
              <Text style={styles.headerBtn}>기록</Text>
            </Pressable>
          }
        />

        {/* 도구 줄: 어떤 AI로 보낼지 + 새 채팅 */}
        <View style={styles.toolbar}>
          <Pressable accessibilityRole="button" accessibilityLabel={`AI 선택, 지금 ${AI_ROUTE_LABEL[route]}`} onPress={() => setPanel('route')} style={styles.routeChip}>
            <View style={[styles.routeDot, { backgroundColor: !routeReady ? colors.muted : allowed ? colors.mint : colors.coral }]} />
            <Text style={styles.routeText}>{AI_ROUTE_LABEL[route]}</Text>
            <Text style={styles.routeCaret}>▾</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="새 채팅" onPress={newChat} style={styles.newChatBtn}>
            <Text style={styles.newChatText}>＋ 새 채팅</Text>
          </Pressable>
        </View>

        {!routeReady ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>로컬 AI는 서버 연결 전이라 아직 쓸 수 없어요.</Text>
            <Pressable accessibilityRole="button" onPress={() => chooseRoute('external')} style={styles.noticeBtn}>
              <Text style={styles.noticeBtnText}>클라우드 AI로</Text>
            </Pressable>
          </View>
        ) : !allowed ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>질문과 관련 기록 일부를 {route === 'external' ? '외부 AI' : '자체 모델 서버'}로 보내야 답할 수 있어요.</Text>
            <Pressable accessibilityRole="button" disabled={consentBusy} onPress={allow} style={[styles.noticeBtn, consentBusy && { opacity: 0.5 }]}>
              <Text style={styles.noticeBtnText}>{consentBusy ? '처리 중…' : '허용하기'}</Text>
            </Pressable>
          </View>
        ) : null}
        {!!banner && (
          <Pressable accessibilityRole="button" onPress={() => setBanner('')} style={styles.banner}>
            <Text style={styles.bannerText}>{banner}  ✕</Text>
          </Pressable>
        )}

        {messages.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIconWrap}>
              <Text style={styles.emptyIcon}>✦</Text>
            </View>
            <Text style={styles.emptyTitle}>무엇을 도와드릴까요?</Text>
            <Text style={styles.emptySub}>앱에 저장된 기록과 첨부한 사진·파일을 바탕으로 답해드려요</Text>
            <View style={styles.chips}>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} accessibilityRole="button" onPress={() => send(s)} style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.mintSoft }]}>
                  <Text style={styles.chipText}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => (
              <MessageBubble message={item} onOpenSource={(src) => src.route && navigation.navigate(src.route, openParams(src.type, src.id))} />
            )}
            contentContainerStyle={styles.list}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            ListFooterComponent={status === 'thinking' ? <TypingDots /> : null}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          />
        )}
      </View>

      {/* ---------- 보내기 전 첨부 ---------- */}
      {attachments.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pendingBar} contentContainerStyle={styles.pendingRow}>
          {attachments.map((a) => (
            <View key={a.id} style={[styles.pending, a.status === 'error' && styles.pendingError]}>
              {a.status === 'reading' && <ActivityIndicator size="small" color={colors.mintDark} />}
              <View style={{ maxWidth: 180 }}>
                <Text style={styles.pendingName} numberOfLines={1}>{a.kind === 'image' ? '사진 · ' : '파일 · '}{a.name}</Text>
                <Text style={[styles.pendingSub, a.status === 'error' && { color: colors.coral }]} numberOfLines={2}>
                  {a.status === 'reading' ? (a.kind === 'image' ? '사진 글자 읽는 중…' : '글자 꺼내는 중…') : a.status === 'ready' ? `글자 ${a.text.length.toLocaleString()}자 준비됨` : a.error}
                </Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`${a.name} 빼기`} onPress={() => removeAttachment(a.id)} hitSlop={8}>
                <Text style={styles.pendingX}>✕</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      {/* ---------- 입력창 ---------- */}
      <View style={[styles.inputBar, { paddingBottom: keyboardUp ? spacing.sm : insets.bottom + spacing.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="사진이나 파일 첨부"
          disabled={status !== 'idle' || attachments.length >= MAX_ATTACHMENTS}
          onPress={() => setPanel('attach')}
          style={[styles.attachBtn, (status !== 'idle' || attachments.length >= MAX_ATTACHMENTS) && { opacity: 0.4 }]}
        >
          <Text style={styles.attachIcon}>＋</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={ready.length ? '첨부한 자료에 대해 물어보세요' : '앱 안의 기록에 대해 물어보세요'}
          placeholderTextColor={colors.muted}
          multiline
          maxLength={2000}
          accessibilityLabel="메시지 입력"
        />
        {status === 'idle' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="전송"
            accessibilityState={{ disabled: !canSend }}
            onPress={() => send(input)}
            disabled={!canSend}
            style={[styles.sendBtn, canSend ? styles.sendOn : styles.sendOff]}
          >
            <Text style={styles.sendIcon}>↑</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="답변 중지" onPress={stop} style={[styles.sendBtn, styles.sendOn]}>
            <View style={styles.stopSquare} />
          </Pressable>
        )}
      </View>

      {/* ---------- 첨부 종류 고르기 ---------- */}
      <Modal transparent visible={panel === 'attach'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPanel(null)}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>첨부하기</Text>
            <Pressable accessibilityRole="button" onPress={() => addFiles('image')} style={styles.option}>
              <Text style={styles.optionName}>사진</Text>
              <Text style={styles.optionSub}>사진 속 글자를 읽어서 함께 보내요 (클라우드 AI · 월 사용 횟수 차감)</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => addFiles('file')} style={styles.option}>
              <Text style={styles.optionName}>파일</Text>
              <Text style={styles.optionSub}>PDF·Word·PowerPoint·텍스트의 글자를 꺼내서 함께 보내요</Text>
            </Pressable>
            <Text style={styles.sheetNote}>파일은 저장되지 않고, 꺼낸 글자만 질문과 함께 보내요. 한 번에 {MAX_ATTACHMENTS}개까지.</Text>
          </View>
        </Pressable>
      </Modal>

      {/* ---------- AI 선택 ---------- */}
      <Modal transparent visible={panel === 'route'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPanel(null)}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>어떤 AI로 답할까요?</Text>
            {['external', 'self_hosted'].map((id) => {
              const on = id === route;
              const off = id === 'self_hosted' && !LOCAL_AI_AVAILABLE;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: off }}
                  disabled={off}
                  onPress={() => chooseRoute(id)}
                  style={[styles.option, on && styles.optionOn, off && { opacity: 0.5 }]}
                >
                  <Text style={styles.optionName}>{AI_ROUTE_LABEL[id]}{on ? ' · 사용 중' : off ? ' · 준비 중' : ''}</Text>
                  <Text style={styles.optionSub}>
                    {id === 'external' ? '외부 AI 제공자가 답해요. 빠르고 사진 글자 인식도 돼요' : '팀 서버의 자체 모델이 답해요. 외부 AI로 넘기지 않아요 (서버 연결 후 사용)'}
                  </Text>
                </Pressable>
              );
            })}
            <Text style={styles.sheetNote}>AI를 바꾸면 그 AI로 자료를 보내는 허용을 다시 받아요.</Text>
          </View>
        </Pressable>
      </Modal>

      {/* ---------- 이전 대화 ---------- */}
      <Modal transparent visible={panel === 'history'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <View style={styles.backdrop}>
          <View style={[styles.sheet, styles.historySheet]} accessibilityViewIsModal>
            <View style={styles.historyHead}>
              <Text style={styles.sheetTitle}>이전 대화</Text>
              <Pressable accessibilityRole="button" onPress={() => setPanel(null)} hitSlop={10}>
                <Text style={styles.close}>닫기</Text>
              </Pressable>
            </View>
            {chats.length === 0 ? (
              <Text style={styles.historyEmpty}>아직 저장된 대화가 없어요. 질문하면 이 기기에 자동으로 저장돼요.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: spacing.sm }}>
                {chats.map((c) => (
                  <View key={c.id} style={[styles.historyItem, c.id === chatId && styles.optionOn]}>
                    <Pressable accessibilityRole="button" accessibilityLabel={`${c.title} 대화 열기`} onPress={() => openChat(c)} style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.optionName} numberOfLines={1}>{c.title}</Text>
                      <Text style={styles.optionSub}>{when(c.updatedAt)} · 메시지 {c.messages.length}개</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={`${c.title} 대화 삭제`} onPress={() => { deleteChat(c.id); if (c.id === chatId) newChat(); }} hitSlop={10}>
                      <Text style={styles.deleteText}>삭제</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            )}
            <Text style={styles.sheetNote}>대화는 이 기기에만, 지금 공간별로 최대 50개 저장돼요.</Text>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  flex: { flex: 1 },
  headerBtn: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },

  // ----- 도구 줄 -----
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  routeChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  routeDot: { width: 8, height: 8, borderRadius: 4 },
  routeText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  routeCaret: { fontSize: font.caption, color: colors.muted },
  newChatBtn: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.mintSoft },
  newChatText: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  notice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.coral },
  noticeText: { flex: 1, fontSize: font.caption, color: colors.ink, lineHeight: 18 },
  noticeBtn: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.sm, backgroundColor: colors.mintDark },
  noticeBtnText: { fontSize: font.caption, fontWeight: '800', color: colors.white },
  banner: { marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.mintSoft },
  bannerText: { fontSize: font.caption, color: colors.ink },

  // ----- 대화가 없을 때 -----
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyIconWrap: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  emptyIcon: { fontSize: 30, color: colors.mintDark },
  emptyTitle: { fontSize: font.title, fontWeight: '700', color: colors.ink },
  emptySub: { fontSize: font.body, color: colors.muted, textAlign: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.lg },
  chip: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + 2, borderRadius: radius.lg + 8, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  chipText: { fontSize: font.body, color: colors.ink },

  // ----- 대화 목록 -----
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.lg, gap: spacing.md },
  userRow: { alignItems: 'flex-end', gap: 6 },
  userBubble: { maxWidth: '80%', backgroundColor: colors.mintDark, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: 20, borderBottomRightRadius: 6 },
  userText: { fontSize: font.bodyLg, color: colors.white, lineHeight: 22 },
  sentFiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, maxWidth: '80%' },
  sentFile: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.mintSoft, maxWidth: '100%' },
  sentFileText: { fontSize: font.caption, fontWeight: '600', color: colors.mintDark },
  aiRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center' },
  avatarIcon: { fontSize: 15, color: colors.mintDark },
  aiBubble: { maxWidth: '80%', backgroundColor: colors.white, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: 20, borderTopLeftRadius: 6, borderWidth: 1, borderColor: colors.line },
  aiText: { fontSize: font.bodyLg, color: colors.ink, lineHeight: 22 },
  errorBubble: { borderColor: colors.coral },
  errorText: { color: colors.ink, fontSize: font.body },
  aiCol: { width: '85%', gap: spacing.sm },
  aiBubbleFit: { alignSelf: 'flex-start', maxWidth: '100%' },
  sources: { gap: 6 },
  sourcesLabel: { fontSize: font.caption, color: colors.muted },
  sourceChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sourceChip: { maxWidth: '100%', paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.mintSoft },
  sourceText: { fontSize: font.caption, fontWeight: '600', color: colors.mintDark },
  dotsBubble: { flexDirection: 'row', gap: 5, alignItems: 'center', paddingVertical: spacing.lg },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.muted },

  // ----- 보내기 전 첨부 -----
  pendingBar: { flexGrow: 0, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  pendingRow: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  pending: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  pendingError: { borderColor: colors.coral },
  pendingName: { fontSize: font.caption, fontWeight: '700', color: colors.ink },
  pendingSub: { fontSize: 11, color: colors.muted },
  pendingX: { fontSize: font.body, color: colors.muted },

  // ----- 입력창 -----
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, backgroundColor: colors.cream, borderTopWidth: 1, borderTopColor: colors.line },
  attachBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  attachIcon: { fontSize: 22, color: colors.mintDark, fontWeight: '700' },
  input: { flex: 1, minHeight: 44, maxHeight: 120, paddingHorizontal: spacing.lg, paddingTop: 12, paddingBottom: 12, fontSize: font.bodyLg, color: colors.ink, backgroundColor: colors.white, borderRadius: 22, borderWidth: 1, borderColor: colors.line },
  sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendOn: { backgroundColor: colors.mintDark },
  sendOff: { backgroundColor: colors.line },
  sendIcon: { fontSize: 22, fontWeight: '700', color: colors.white },
  stopSquare: { width: 14, height: 14, borderRadius: 3, backgroundColor: colors.white },

  // ----- 창 -----
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  sheet: { width: '100%', maxWidth: 380, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.sm },
  sheetTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink, marginBottom: spacing.xs },
  sheetNote: { fontSize: font.caption, color: colors.muted, marginTop: spacing.xs },
  option: { padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, gap: 2 },
  optionOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  optionName: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  optionSub: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  historySheet: { maxWidth: 420 },
  historyHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  historyEmpty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.lg },
  historyItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  deleteText: { fontSize: font.caption, fontWeight: '700', color: colors.coral },
});
