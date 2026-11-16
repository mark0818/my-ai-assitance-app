// ============================================================
// ScreenEntry.js — 지금 화면을 "어떻게 들어왔는지"를 머리글에 알려 주는 도구
// ============================================================
// 규칙: 사이드 메뉴에서 연 화면은 왼쪽 위가 ☰(메뉴 열기),
//       다른 화면 안에서 들어온 화면은 ‹(이전 화면으로).
//   같은 메모 화면이라도 메뉴로 왔으면 ☰, 검색 결과에서 왔으면 ‹ 가 됩니다.

import { createContext, useContext } from 'react';
import { useMenu } from './MenuContext';

// fromMenu: 사이드 메뉴로 연 화면인지 · goBack: 내비게이터의 뒤로 가기 (화면이 넘긴 onBack 과 비교용)
const ScreenEntry = createContext({ fromMenu: false, goBack: null });
export const ScreenEntryProvider = ScreenEntry.Provider;

/**
 * 머리글 왼쪽 버튼이 할 일.
 *   onBack 이 없으면(홈 등) 항상 메뉴.
 *   onBack 이 내비게이터의 뒤로 가기이고 메뉴로 연 화면이면 메뉴.
 *   그 밖의 onBack(예: 선택 모드 끝내기)은 그대로 ‹.
 */
export function useLeadAction(onBack) {
  const { fromMenu, goBack } = useContext(ScreenEntry);
  const { open } = useMenu();
  const menu = !onBack || (fromMenu && onBack === goBack);
  return { menu, onPress: menu ? open : onBack };
}
