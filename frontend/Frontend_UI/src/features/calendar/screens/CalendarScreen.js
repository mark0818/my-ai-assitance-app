// ============================================================
// CalendarScreen.js — 캘린더 화면
// ============================================================

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import CalendarSheet from '../components/CalendarSheet';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { useLeadAction } from '../../../navigation/ScreenEntry';
import { colors } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';

export default function CalendarScreen({ navigation, calendar }) {
  // "오른쪽으로 밀면 메뉴" 제스처
  const menuSwipe = useSwipeToOpenMenu();
  // 왼쪽 위: 사이드 메뉴로 열었으면 ☰, 홈 시트를 끝까지 올려서 왔으면 ‹
  const lead = useLeadAction(navigation.goBack);

  return (
    // 화면 전체. 시트가 이 안을 꽉 채우며 올라와 있는 상태로 보입니다.
    <View style={styles.root} {...menuSwipe}>
      <CalendarSheet
        calendar={calendar}
        startFull // 처음부터 끝까지 올라온 상태
        onAddTask={(date) => navigation.navigate(ROUTES.TaskEdit, { date })}
        onEditTask={(taskId) => navigation.navigate(ROUTES.TaskEdit, { taskId })}
        onClose={navigation.goBack} // 아래로 밀어 닫으면 이전 화면으로
        lead={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lead.menu ? '메뉴 열기' : '뒤로 가기'}
            onPress={lead.onPress}
            hitSlop={12}
          >
            <Text style={styles.icon}>{lead.menu ? '☰' : '‹'}</Text>
          </Pressable>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  icon: { fontSize: 26, color: colors.ink }, // ScreenHeader 와 같은 크기
});
