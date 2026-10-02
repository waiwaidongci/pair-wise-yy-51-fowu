import type { RouteState } from './route.reducer'

const DRAFT_KEY = 'rail-approval-draft-v1'

/** 本地草稿：未同步变更、冲突项、审计与基线，刷新/断网重进后仍可继续 */
export function saveDraft(state: RouteState): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      routes: state.routes,
      comments: state.comments,
      selectedRouteId: state.selectedRouteId,
      selectedSegmentId: state.selectedSegmentId,
      version: state.version,
      baseVersion: state.baseVersion,
      baseSnapshot: state.baseSnapshot,
      pendingChanges: state.pendingChanges,
      conflicts: state.conflicts,
      audit: state.audit,
      baseline: state.baseline,
      lastSyncAt: state.lastSyncAt,
    }))
  } catch {
    // 存储不可用时静默降级，不阻断编辑
  }
}

export function loadDraft(): Partial<RouteState> | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const draft = JSON.parse(raw) as Partial<RouteState>
    if (!Array.isArray(draft.routes) || !Array.isArray(draft.pendingChanges)) return null
    return draft
  } catch {
    return null
  }
}
