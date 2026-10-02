import { createReducer, on } from '@ngrx/store'
import type { CommentStatus, ReviewComment, RiskLevel, RoutePackage } from '../types'
import { defaultComments } from './default-data'
import { touchEntity, now } from '../services/sync-merge'
import * as RouteActions from './route.actions'
import * as SyncActions from './sync.actions'

export interface RouteState {
  routes: RoutePackage[]
  selectedRouteId: string
  selectedSegmentId: string
  comments: ReviewComment[]
  loading: boolean
  error: string
  version: number
  baselineLocked: boolean
}

export const initialState: RouteState = {
  routes: [], selectedRouteId: '', selectedSegmentId: '', loading: false, error: '', version: 6,
  comments: defaultComments,
  baselineLocked: false,
}

function findSegment(routes: RoutePackage[], id: string) {
  for (const r of routes) {
    const s = r.segments.find((seg) => seg.id === id)
    if (s) return { route: r, segment: s }
  }
  return undefined
}

export const routeReducer = createReducer(
  initialState,
  on(RouteActions.loadRoutes, (state) => ({ ...state, loading: true, error: '' })),
  on(RouteActions.loadRoutesSuccess, (state, { routes }) => ({ ...state, loading: false, routes, selectedRouteId: state.selectedRouteId || routes[0]?.id || '', selectedSegmentId: state.selectedSegmentId || routes[0]?.segments[0]?.id || '' })),
  on(RouteActions.loadRoutesFailure, (state, { error }) => ({ ...state, loading: false, error })),
  on(RouteActions.selectRoute, (state, { id }) => ({ ...state, selectedRouteId: id, selectedSegmentId: state.routes.find((route) => route.id === id)?.segments[0]?.id ?? '' })),
  on(RouteActions.selectSegment, (state, { id }) => ({ ...state, selectedSegmentId: id })),

  // 乐观应用本地修改（离线/在线都立即更新 UI）
  on(RouteActions.applySegmentLevel, (state, { id, level }) => {
    const at = now()
    const routes = state.routes.map((route) => ({
      ...route,
      segments: route.segments.map((segment) => {
        if (segment.id !== id) return segment
        const nextStatus = level === '高' ? '需绕行' as const : '待复核' as const
        return touchEntity({ ...segment, level, status: nextStatus }, {}, 'local', at)
      }),
    }))
    return { ...state, routes, version: state.version + 1 }
  }),
  on(RouteActions.applyCommentAdd, (state, { comment }) => {
    const at = now()
    const enriched = touchEntity(comment, {}, 'local', at)
    return { ...state, comments: [enriched, ...state.comments], version: state.version + 1 }
  }),
  on(RouteActions.applyCommentResolve, (state, { id, status }) => {
    const at = now()
    const comments = state.comments.map((comment) => {
      if (comment.id !== id) return comment
      const seg = findSegment(state.routes, comment.segmentId)
      const resolvedSegmentV = seg ? (seg.segment._v ?? 0) : comment.resolvedSegmentV
      return touchEntity({ ...comment, status, resolvedSegmentV, invalidated: false, invalidatedAt: undefined }, {}, 'local', at)
    })
    return { ...state, comments, version: state.version + 1 }
  }),
  on(RouteActions.applyCreateAlternative, (state) => ({
    ...state,
    version: state.version + 1,
    routes: state.routes.map((route) => route.id === state.selectedRouteId ? { ...route, id: `${route.id}-ALT`, score: Math.max(72, route.score - 2) } : route),
  })),
  on(RouteActions.applyBaselineLock, (state) => ({ ...state, baselineLocked: true, version: state.version + 1 })),

  // 同步成功：以远端为准重建本地，再把冲突项的本地乐观值盖回去
  on(SyncActions.syncSuccess, (state, { routes, comments, conflicts, at }) => {
    let nextRoutes = routes.map((r) => ({ ...r, segments: r.segments.map((s) => ({ ...s })) }))
    let nextComments = comments.map((c) => ({ ...c }))

    for (const conflict of conflicts) {
      if (conflict.kind === 'segment-level' || conflict.kind === 'segment-status') {
        for (const r of nextRoutes) {
          const idx = r.segments.findIndex((s) => s.id === conflict.entityId)
          if (idx >= 0) {
            r.segments[idx] = { ...r.segments[idx], [conflict.field]: conflict.localValue, _by: 'local' as const }
            break
          }
        }
      } else if (conflict.kind === 'comment-resolve') {
        const idx = nextComments.findIndex((c) => c.id === conflict.entityId)
        if (idx >= 0) nextComments[idx] = { ...nextComments[idx], [conflict.field]: conflict.localValue, _by: 'local' as const }
      }
    }

    return {
      ...state,
      routes: nextRoutes,
      comments: nextComments,
      version: state.version + 1,
      baselineLocked: false,
    }
  }),

  // 远端模拟修改后更新本地
  on(SyncActions.remoteEditApplied, (state, { routes, comments }) => ({ ...state, routes, comments })),

  // 冲突解决后更新本地
  on(SyncActions.conflictResolved, (state, { routes, comments }) => ({ ...state, routes, comments })),

  // 从本地持久化恢复
  on(SyncActions.initFromLocal, (state, { routes, comments }) => ({ ...state, routes, comments })),
)
