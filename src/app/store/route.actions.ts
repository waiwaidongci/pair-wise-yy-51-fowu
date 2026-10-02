import { createAction, props } from '@ngrx/store'
import type { AuditEntry, Baseline, ConflictItem, ReviewComment, RoutePackage, ServerSnapshot } from '../types'

export const loadRoutes = createAction('[Route Workbench] Load Routes')
export const loadRoutesSuccess = createAction('[Route API] Load Routes Success', props<{ snapshot: ServerSnapshot }>())
export const loadRoutesFailure = createAction('[Route API] Load Routes Failure', props<{ error: string }>())
export const selectRoute = createAction('[Route Workbench] Select Route', props<{ id: string }>())
export const selectSegment = createAction('[Risk Map] Select Segment', props<{ id: string }>())
export const updateSegmentField = createAction('[Approval] Update Segment Field', props<{ id: string; field: 'level' | 'status'; value: string }>())
export const addComment = createAction('[Approval] Add Comment', props<{ comment: ReviewComment }>())
export const resolveComment = createAction('[Approval] Resolve Comment', props<{ id: string; status: ReviewComment['status'] }>())
export const createAlternative = createAction('[Risk Map] Create Alternative')
export const lockBaseline = createAction('[Approval] Lock Baseline')

export const networkStatusChanged = createAction('[Network] Status Changed', props<{ online: boolean }>())
export const syncRequested = createAction('[Sync] Requested')
export const syncNoop = createAction('[Sync] Noop')
export const syncSuccess = createAction('[Sync] Success', props<{
  routes: RoutePackage[]
  comments: ReviewComment[]
  conflicts: ConflictItem[]
  audit: AuditEntry[]
  version: number
  baseline: Baseline | null
  lastSyncAt: string
  appliedChangeIds: string[]
}>())
export const syncFailure = createAction('[Sync] Failure', props<{ error: string }>())
export const resolveConflict = createAction('[Sync] Resolve Conflict', props<{ id: string; choice: 'local' | 'remote' }>())
