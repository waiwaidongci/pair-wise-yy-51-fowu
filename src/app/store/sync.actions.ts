import { createAction, props } from '@ngrx/store'
import type { AuditRecord, ConflictItem, Draft, ReviewComment, RoutePackage } from '../types'

export const setOnline = createAction('[Sync] Set Online', props<{ online: boolean }>())
export const syncNow = createAction('[Sync] Sync Now')
export const syncStart = createAction('[Sync] Sync Start')
export const syncSuccess = createAction(
  '[Sync] Sync Success',
  props<{
    routes: RoutePackage[]
    comments: ReviewComment[]
    applied: Draft[]
    conflicts: ConflictItem[]
    invalidated: string[]
    audit: AuditRecord[]
    remoteVersion: number
    at: string
  }>(),
)
export const syncFailure = createAction('[Sync] Sync Failure', props<{ error: string; at: string }>())
export const retryDraft = createAction('[Sync] Retry Draft', props<{ draftId: string }>())
export const resolveConflict = createAction('[Sync] Resolve Conflict', props<{ draftId: string; field: string; choice: 'local' | 'remote' }>())
export const conflictResolved = createAction('[Sync] Conflict Resolved', props<{ draftId: string; field: string; routes: RoutePackage[]; comments: ReviewComment[]; audit: AuditRecord[] }>())
export const simulateRemoteEdit = createAction('[Sync] Simulate Remote Edit')
export const requestSimulateFail = createAction('[Sync] Request Simulate Fail')
export const remoteEditApplied = createAction('[Sync] Remote Edit Applied', props<{ routes: RoutePackage[]; comments: ReviewComment[] }>())
export const createDraft = createAction('[Sync] Create Draft', props<{ draft: Draft }>())
export const initFromLocal = createAction('[Sync] Init From Local', props<{ routes: RoutePackage[]; comments: ReviewComment[]; drafts: Draft[]; audit: AuditRecord[] }>())
export const resetAll = createAction('[Sync] Reset All')
