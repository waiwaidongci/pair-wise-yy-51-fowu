import { createAction, props } from '@ngrx/store'
import type { CommentStatus, ReviewComment, RiskLevel, RoutePackage } from '../types'

export const loadRoutes = createAction('[Route Workbench] Load Routes')
export const loadRoutesSuccess = createAction('[Route API] Load Routes Success', props<{ routes: RoutePackage[] }>())
export const loadRoutesFailure = createAction('[Route API] Load Routes Failure', props<{ error: string }>())
export const selectRoute = createAction('[Route Workbench] Select Route', props<{ id: string }>())
export const selectSegment = createAction('[Risk Map] Select Segment', props<{ id: string }>())

// 意图动作（组件派发）：离线时进入草稿队列，在线时合并
export const updateSegmentLevel = createAction('[Risk Map] Update Level', props<{ id: string; level: RiskLevel }>())
export const addComment = createAction('[Approval] Add Comment', props<{ comment: ReviewComment }>())
export const resolveComment = createAction('[Approval] Resolve Comment', props<{ id: string; status: CommentStatus }>())
export const createAlternative = createAction('[Risk Map] Create Alternative')
export const lockBaseline = createAction('[Approval] Lock Baseline')

// 乐观应用动作（effect 派发，reducer 处理）
export const applySegmentLevel = createAction('[Route Apply] Segment Level', props<{ id: string; level: RiskLevel }>())
export const applyCommentAdd = createAction('[Route Apply] Comment Add', props<{ comment: ReviewComment }>())
export const applyCommentResolve = createAction('[Route Apply] Comment Resolve', props<{ id: string; status: CommentStatus }>())
export const applyCreateAlternative = createAction('[Route Apply] Create Alternative')
export const applyBaselineLock = createAction('[Route Apply] Lock Baseline')
