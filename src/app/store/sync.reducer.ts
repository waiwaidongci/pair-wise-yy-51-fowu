import { createReducer, on } from '@ngrx/store'
import type { AuditRecord, ConflictItem, Draft } from '../types'
import * as SyncActions from './sync.actions'

export interface SyncState {
  online: boolean
  syncing: boolean
  lastSyncedAt: string
  drafts: Draft[]
  conflicts: ConflictItem[]
  audit: AuditRecord[]
  error: string
  remoteVersion: number
  initialized: boolean
}

export const initialSyncState: SyncState = {
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  syncing: false,
  lastSyncedAt: '',
  drafts: [],
  conflicts: [],
  audit: [],
  error: '',
  remoteVersion: 0,
  initialized: false,
}

export const syncReducer = createReducer(
  initialSyncState,
  on(SyncActions.setOnline, (state, { online }) => ({ ...state, online })),
  on(SyncActions.syncStart, (state) => ({ ...state, syncing: true, error: '' })),
  on(SyncActions.syncSuccess, (state, { applied, conflicts, audit, remoteVersion, at }) => {
    // 已应用的草稿从队列移除；冲突/失败/待处理保留；审计幂等合并
    const appliedIds = new Set(applied.map((d) => d.id))
    const drafts = state.drafts
      .map((d) => (appliedIds.has(d.id) ? { ...d, status: 'applied' as const, auditRecorded: true } : d))
      .filter((d) => d.status !== 'applied')
    const existingAuditIds = new Set(state.audit.map((a) => a.draftId).filter(Boolean) as string[])
    const newAudit = audit.filter((a) => !a.draftId || !existingAuditIds.has(a.draftId))
    return {
      ...state,
      syncing: false,
      lastSyncedAt: at,
      drafts,
      conflicts,
      audit: [...state.audit, ...newAudit],
      remoteVersion,
      error: '',
    }
  }),
  on(SyncActions.syncFailure, (state, { error, at }) => ({
    ...state,
    syncing: false,
    error,
    lastSyncedAt: at,
    // 失败时草稿与冲突项全部保留
  })),
  on(SyncActions.createDraft, (state, { draft }) => ({ ...state, drafts: [draft, ...state.drafts] })),
  on(SyncActions.retryDraft, (state, { draftId }) => ({
    ...state,
    drafts: state.drafts.map((d) => (d.id === draftId ? { ...d, status: 'pending' as const, error: undefined } : d)),
    error: '',
  })),
  on(SyncActions.conflictResolved, (state, { draftId, field, audit }) => {
    const conflicts = state.conflicts.filter((c) => !(c.draftId === draftId && c.field === field))
    const draft = state.drafts.find((d) => d.id === draftId)
    const remaining = conflicts.filter((c) => c.draftId === draftId)
    const drafts = remaining.length === 0
      ? state.drafts.filter((d) => d.id !== draftId)
      : state.drafts.map((d) => (d.id === draftId ? { ...d, status: 'conflict' as const, conflictFields: remaining.map((c) => c.field) } : d))
    const existingAuditIds = new Set(state.audit.map((a) => a.draftId).filter(Boolean) as string[])
    const newAudit = audit.filter((a) => !a.draftId || !existingAuditIds.has(a.draftId))
    return { ...state, conflicts, drafts, audit: [...state.audit, ...newAudit] }
  }),
  on(SyncActions.remoteEditApplied, (state) => ({ ...state })),
  on(SyncActions.initFromLocal, (state, { drafts, audit }) => ({ ...state, drafts, audit, initialized: true })),
  on(SyncActions.resetAll, () => ({ ...initialSyncState })),
)
