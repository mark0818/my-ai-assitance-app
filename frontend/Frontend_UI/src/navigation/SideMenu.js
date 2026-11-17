// ============================================================
// SideMenu.js — 왼쪽에서 밀려 나오는 "사이드 메뉴 패널"
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../shared/hooks/useInsets';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors, font, radius, spacing, FILL } from '../shared/theme/theme';
import Icon from '../shared/components/Icon';
import { useMenu } from './MenuContext';
import { MENU_ITEMS, ROUTES } from './routes';
import { useWorkspaces } from '../data/workspaces/WorkspaceStore';

// 메뉴 항목별 아이콘 (Icon.js 이름). home·settings 는 Icon.js 에 없어서 아래에서 직접 그림
const MENU_ICON = {
  [ROUTES.Home]: 'home',
  [ROUTES.Search]: 'search',
  [ROUTES.Calendar]: 'calendar',
  [ROUTES.Ai]: 'sparkles',
  [ROUTES.Projects]: 'folder',
  [ROUTES.Memos]: 'file',
  [ROUTES.Tasks]: 'checkSquare',
  [ROUTES.Favorites]: 'star',
  [ROUTES.Workspace]: 'users',
  [ROUTES.Files]: 'paperclip',
  [ROUTES.Backup]: 'cloud',
  [ROUTES.Trash]: 'trash',
  [ROUTES.Settings]: 'settings',
};

// Icon.js 에 없는 아이콘 두 개 (같은 선 굵기·24x24 기준)
const LOCAL_ICON = {
  home: ['M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8', 'M3 10a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'],
};

function MenuIcon({ name, color }) {
  const local = LOCAL_ICON[name];
  if (!local) return <Icon name={name || 'grid'} size={20} color={color} />;
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {local.map((d) => <Path key={d} d={d} />)}
      {name === 'settings' && <Circle cx={12} cy={12} r={3} />}
    </Svg>
  );
}

// 패널 폭: 화면 폭의 80%, 단 최대 320
const WIDTH = Math.min(Dimensions.get('window').width * 0.8, 320);

export default function SideMenu({ onNavigate, currentRoute }) {
  const { visible, close } = useMenu(); // 열림 여부 / 닫기 함수
  const insets = useSafeAreaInsets();
  const { current } = useWorkspaces(); // 지금 보고 있는 공간 (메뉴 위에 항상 표시)

  // x: 패널의 가로 위치. -WIDTH 면 화면 왼쪽 밖(숨김), 0 이면 화면 안(보임)
  const x = useRef(new Animated.Value(-WIDTH)).current;
  // mounted: 패널을 화면에 "존재시킬지" 여부.
  //   닫힐 때 슬라이드 애니메이션이 끝날 때까지는 존재해야 해서 visible 과 따로 관리합니다.
  const [mounted, setMounted] = useState(false);

  // visible 이 바뀔 때마다 열기/닫기 애니메이션 실행
  useEffect(() => {
    if (visible) {
      setMounted(true); // 먼저 화면에 올리고
      Animated.timing(x, { toValue: 0, duration: 220, useNativeDriver: true }).start(); // 왼쪽에서 들어오기
    } else if (mounted) {
      // 왼쪽 밖으로 나간 뒤(애니메이션 종료 콜백) 화면에서 제거
      Animated.timing(x, { toValue: -WIDTH, duration: 180, useNativeDriver: true }).start(() => setMounted(false));
    }
  }, [visible, mounted, x]);

  // 열려 있지도, 닫히는 중도 아니면 아무것도 그리지 않음
  if (!mounted) return null;

  // 메뉴 항목을 눌렀을 때 실행
  const go = (route) => {
    close(); // 메뉴 닫기
    if (route === currentRoute) return; // 이미 그 화면이면 이동하지 않음
    onNavigate(route); // 해당 화면으로 이동 (실제 이동은 AppNavigator 가 처리)
  };

  return (
    // Modal: 모든 화면 위에 겹쳐서 띄우는 도구. 배경은 투명(transparent)
    <Modal transparent visible animationType="none" onRequestClose={close}>
      <View style={styles.root}>
        {/* 어두운 배경: 눌러서 메뉴 닫기 */}
        <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="메뉴 닫기" />

        {/* 메뉴 패널 본체. translateX: x 만큼 가로로 이동시켜 그림 */}
        <Animated.View
          accessibilityViewIsModal
          style={[styles.panel, { width: WIDTH, paddingTop: insets.top + spacing.lg, transform: [{ translateX: x }] }]}
        >
          {/* 머리: 앱 이름 + 지금 보고 있는 공간 */}
          <Text style={styles.heading} accessibilityRole="header">오늘의 플래너</Text>
          <View style={styles.spacePill} accessibilityLabel={`현재 공간 ${current.name}`}>
            <View style={styles.spaceDot} />
            <Text style={styles.space} numberOfLines={1}>{current.name}</Text>
          </View>
          <View style={styles.sep} />

          {/* 항목이 많아도 스크롤로 볼 수 있게 ScrollView */}
          <ScrollView style={{ marginTop: spacing.sm }} contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}>
            {/* MENU_ITEMS 배열을 하나씩 꺼내서 버튼으로 만듦 */}
            {MENU_ITEMS.map((item) => {
              const active = item.route === currentRoute; // 지금 보는 화면인가?
              return (
                <Pressable
                  key={item.route} // 목록의 각 항목을 구분하는 고유 이름 (React 필수 규칙)
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => go(item.route)}
                  // pressed: 누르고 있는 동안 true → 눌렀을 때도 배경색 변경
                  style={({ pressed }) => [styles.item, (active || pressed) && { backgroundColor: colors.mintSoft }]}
                >
                  <MenuIcon name={MENU_ICON[item.route]} color={active ? colors.mintDark : colors.ink} />
                  <Text style={[styles.itemText, active && { color: colors.mintDark, fontWeight: '800' }]}>
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  // absoluteFillObject: 부모 전체를 덮는 위치/크기. 반투명 어두운색
  backdrop: { ...FILL, backgroundColor: 'rgba(38,57,53,0.4)' },
  spacePill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%', marginTop: spacing.sm, paddingHorizontal: spacing.md, minHeight: 28, borderRadius: radius.pill, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  spaceDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.mint },
  space: { flexShrink: 1, fontSize: font.caption, fontWeight: '700', color: colors.mintDark },
  sep: { height: 1, backgroundColor: colors.line, marginTop: spacing.lg },
  panel: { backgroundColor: colors.cream, paddingHorizontal: spacing.lg, height: '100%' },
  heading: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48, paddingHorizontal: spacing.md, borderRadius: radius.md, marginBottom: 2 },
  itemText: { fontSize: font.bodyLg, color: colors.ink, fontWeight: '600' },
});
