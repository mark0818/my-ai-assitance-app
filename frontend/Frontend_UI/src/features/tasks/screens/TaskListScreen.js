// ============================================================
// TaskListScreen.js — 할 일 목록
// ============================================================


import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import Icon from '../../../shared/components/Icon';
import { Chip, CircleButton, DashedButton, Tag } from '../../../shared/components/Ui';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { toKey } from '../../calendar/utils/DateUtils';
import { classify, shortDate, tagText, toggleDone, useTasks } from '../../../data/tasks/TaskStore';
import { projectOf, useProjects } from '../../../data/projects/ProjectStore';

const FILTERS = [
  { id: 'all', label: '전체' },
  { id: 'today', label: '오늘' },
  { id: 'upcoming', label: '예정' },
  { id: 'soon', label: '임박' },
  { id: 'overdue', label: '초과' },
  { id: 'done', label: '완료' },
];

// 남은/지난 날짜를 말로: '2일 지남', '내일', '3일 남음' (일주일 넘게 남으면 '예정')
function whenText(t, todayKey) {
  const c = classify(t, todayKey);
  const days = Math.round((Date.parse(t.date) - Date.parse(todayKey)) / 86400000);
  if (c === 'overdue' && days < 0) return `${-days}일 지남`;
  if ((c === 'soon' || c === 'upcoming') && days === 1) return '내일';
  if ((c === 'soon' || c === 'upcoming') && days > 1 && days < 7) return `${days}일 남음`;
  return tagText(t, todayKey);
}

export default function TasksScreen({ navigation }) {
  const menuSwipe = useSwipeToOpenMenu();
  const tasks = useTasks();
  useProjects(); // 프로젝트 이름이 바뀌면 꼬리표도 다시 그리기
  const [filter, setFilter] = useState('all');
  const todayKey = toKey(new Date());

  const counts = useMemo(() => {
    const c = { all: tasks.length, today: 0, upcoming: 0, soon: 0, overdue: 0, done: 0 };
    tasks.forEach((t) => {
      c[classify(t, todayKey)] += 1;
    });
    return c;
  }, [tasks, todayKey]);

  const list = useMemo(() => {
    const filtered = filter === 'all' ? tasks : tasks.filter((t) => classify(t, todayKey) === filter);
    // 완료 항목은 맨 아래
    return filtered.slice().sort((a, b) => (a.status === '완료') - (b.status === '완료'));
  }, [tasks, filter, todayKey]);

  return (
    <View style={styles.root} {...menuSwipe}>
      <ScreenHeader
        title="할 일 목록"
        onBack={navigation.goBack}
        right={<CircleButton icon="plus" label="할 일 추가" onPress={() => navigation.navigate(ROUTES.TaskEdit, { date: todayKey })} />}
      />
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {FILTERS.map((f) => (
            <Chip key={f.id} label={`${f.label} ${counts[f.id]}`} active={filter === f.id} onPress={() => setFilter(f.id)} />
          ))}
        </ScrollView>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        <DashedButton label="할 일 추가" onPress={() => navigation.navigate(ROUTES.TaskEdit, { date: todayKey })} />

        {list.length === 0 ? (
          <Text style={styles.empty}>해당하는 항목이 없어요</Text>
        ) : (
          list.map((t) => {
            const done = t.status === '완료';
            const c = classify(t, todayKey);
            const proj = projectOf('tasks', t.id);
            return (
              <View key={t.id} style={styles.item}>
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: done }}
                  accessibilityLabel={`${t.title} 완료 표시`}
                  onPress={() => toggleDone(t.id)}
                  hitSlop={8}
                >
                  <Icon name={done ? 'checkSquare' : 'square'} size={22} color={done ? colors.mintDark : colors.muted} />
                </Pressable>
                <Pressable
                  style={styles.body}
                  accessibilityRole="button"
                  onPress={() => navigation.navigate(ROUTES.TaskEdit, { taskId: t.id })}
                >
                  <Text style={[styles.title, done && styles.titleDone]} numberOfLines={1}>{t.title}</Text>
                  <Text style={[styles.meta, c === 'overdue' && { color: colors.coral }]} numberOfLines={1}>
                    {shortDate(t)} · {whenText(t, todayKey)}{t.start ? ` · ${t.start}` : ''}
                  </Text>
                </Pressable>
                {!!proj && <Tag label={proj.title} style={styles.tag} />}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  chips: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.md },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: 10 },
  empty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.lg, textAlign: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  body: { flex: 1, minHeight: 44, justifyContent: 'center', gap: 2 },
  title: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  titleDone: { color: colors.muted, textDecorationLine: 'line-through' },
  meta: { fontSize: font.caption, color: colors.muted },
  tag: { alignSelf: 'center', maxWidth: 110 },
});
