import { createReducer, on } from '@ngrx/store'
import type { AuditEntry, Baseline, ConflictItem, FieldChange, ReviewComment, RiskSegment, RoutePackage, SnapshotData } from '../types'
import { seedAudit, seedComments } from '../seed'
import { applyFieldChange, digestRoutes, fieldLabel, formatFieldValue, unionById } from './merge'
import { loadDraft } from './draft-storage'
import * as RouteActions from './route.actions'

export interface RouteState {
  routes: RoutePackage[]
  selectedRouteId: string
  selectedSegmentId: string
  comments: ReviewComment[]
  loading: boolean
  error: string
  version: number
  /** 上次同步成功时的服务端版本与快照（三路合并的共同祖先） */
  baseVersion: number
  baseSnapshot: SnapshotData | null
  online: boolean
  syncing: boolean
  syncError: string
  lastSyncAt: string
  /** 离线/未同步的字段级本地修改（草稿） */
  pendingChanges: FieldChange[]
  conflicts: ConflictItem[]
  audit: AuditEntry[]
  baseline: Baseline | null
}

const defaultState: RouteState = {
  routes: [],
  selectedRouteId: '',
  selectedSegmentId: '',
  comments: seedComments.map((comment) => ({ ...comment })),
  loading: false,
  error: '',
  version: 6,
  baseVersion: 0,
  baseSnapshot: null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  syncError: '',
  lastSyncAt: '',
  pendingChanges: [],
  conflicts: [],
  audit: seedAudit.map((entry) => ({ ...entry })),
  baseline: null,
}

// 恢复本地草稿：断网/刷新后未同步的修改与冲突项不丢失
export const initialState: RouteState = { ...defaultState, ...(loadDraft() ?? {}) }

function findSegment(routes: RoutePackage[], segmentId: string): RiskSegment | undefined {
  return routes.flatMap((route) => route.segments).find((segment) => segment.id === segmentId)
}

/** 区段变更后，相关意见立即失效并转为待确认（含已依据旧版本接受的意见） */
function invalidateSegmentComments(comments: ReviewComment[], segmentId: string, segmentVersion: number, now: string): { comments: ReviewComment[]; entries: AuditEntry[] } {
  const entries: AuditEntry[] = []
  const next = comments.map((comment) => {
    if (comment.segmentId !== segmentId || comment.status === '待确认') return comment
    entries.push({
      id: `audit-inv-${comment.id}-${segmentId}-v${segmentVersion}`,
      at: now,
      actor: '系统',
      kind: 'invalidation',
      text: `区段 ${segmentId} 已变更（v${segmentVersion}），意见 ${comment.id}（${comment.role}·${comment.author}）失效，需重新确认`,
    })
    return { ...comment, status: '待确认' as const, invalidatedReason: `区段 ${segmentId} 已变更（v${segmentVersion}），需重新确认` }
  })
  return { comments: next, entries }
}

/** 已锁定基线关联的区段被修改 → 基线失效 */
function checkBaselineStale(baseline: Baseline | null, routes: RoutePackage[], now: string, changeId: string): { baseline: Baseline | null; entries: AuditEntry[] } {
  if (!baseline || baseline.status !== '已锁定') return { baseline, entries: [] }
  const digest = digestRoutes(routes)
  const stale = Object.keys(baseline.segmentDigest).some((segmentId) => digest[segmentId] !== baseline.segmentDigest[segmentId])
  if (!stale) return { baseline, entries: [] }
  return {
    baseline: { ...baseline, status: '已失效' },
    entries: [{
      id: `audit-baseline-stale-${changeId}`,
      at: now,
      actor: '系统',
      kind: 'baseline',
      text: `基线 ${baseline.id} 关联区段被修改，基线失效，需重新确认并锁定`,
    }],
  }
}

export const routeReducer = createReducer(
  initialState,
  on(RouteActions.loadRoutes, (state) => ({ ...state, loading: true, error: '' })),
  on(RouteActions.loadRoutesSuccess, (state, { snapshot }) => {
    // 有未同步草稿或待裁决冲突时保留本地工作状态，等待合并，不覆盖
    if (state.pendingChanges.length > 0 || state.conflicts.length > 0) {
      return { ...state, loading: false }
    }
    return {
      ...state,
      loading: false,
      routes: snapshot.routes,
      comments: snapshot.comments,
      audit: unionById(state.audit, snapshot.audit),
      baseline: snapshot.baseline,
      version: snapshot.version,
      baseVersion: snapshot.version,
      baseSnapshot: { routes: snapshot.routes, comments: snapshot.comments },
      selectedRouteId: state.selectedRouteId || snapshot.routes[0]?.id || '',
      selectedSegmentId: state.selectedSegmentId || snapshot.routes[0]?.segments[0]?.id || '',
    }
  }),
  on(RouteActions.loadRoutesFailure, (state, { error }) => ({ ...state, loading: false, error })),
  on(RouteActions.selectRoute, (state, { id }) => ({ ...state, selectedRouteId: id, selectedSegmentId: state.routes.find((route) => route.id === id)?.segments[0]?.id ?? '' })),
  on(RouteActions.selectSegment, (state, { id }) => ({ ...state, selectedSegmentId: id })),
  on(RouteActions.updateSegmentField, (state, { id, field, value }) => {
    const now = new Date().toISOString()
    const routes = state.routes.map((route) => ({
      ...route,
      segments: route.segments.map((segment) => {
        if (segment.id !== id) return segment
        const next = { ...segment, [field]: value, version: segment.version + 1 }
        if (field === 'level') next.status = value === '高' ? '需绕行' : '待复核'
        return next
      }),
    }))
    const segment = findSegment(routes, id)
    if (!segment) return state
    const fieldKey = `segment:${id}:${field}`
    const changes: FieldChange[] = [
      { id: `${fieldKey}-${now}`, fieldKey, value, source: 'local', actor: '当前审阅人', changedAt: now },
    ]
    if (field === 'level') {
      changes.push({ id: `segment:${id}:status-${now}`, fieldKey: `segment:${id}:status`, value: segment.status, source: 'local', actor: '当前审阅人', changedAt: now })
    }
    const invalidated = invalidateSegmentComments(state.comments, id, segment.version, now)
    const baselineCheck = checkBaselineStale(state.baseline, routes, now, `${id}-${now}`)
    const audit: AuditEntry[] = [
      ...state.audit,
      { id: `audit-local-${fieldKey}-${now}`, at: now, actor: '当前审阅人', kind: 'segment', text: `修改${fieldLabel(fieldKey)}为「${formatFieldValue(value)}」（区段版本 v${segment.version}）` },
      ...invalidated.entries,
      ...baselineCheck.entries,
    ]
    return {
      ...state,
      routes,
      comments: invalidated.comments,
      audit,
      baseline: baselineCheck.baseline,
      version: state.version + 1,
      pendingChanges: [...state.pendingChanges, ...changes],
    }
  }),
  on(RouteActions.addComment, (state, { comment }) => {
    const now = new Date().toISOString()
    const change: FieldChange = { id: `comment:${comment.id}:create-${now}`, fieldKey: `comment:${comment.id}:create`, value: comment, source: 'local', actor: comment.author, changedAt: now }
    const entry: AuditEntry = { id: `audit-comment-${comment.id}`, at: now, actor: comment.author, kind: 'comment', text: `新增意见 ${comment.id}（${comment.role}·${comment.segmentId}）：${comment.content.slice(0, 30)}` }
    return {
      ...state,
      comments: [comment, ...state.comments],
      pendingChanges: [...state.pendingChanges, change],
      audit: [...state.audit, entry],
    }
  }),
  on(RouteActions.resolveComment, (state, { id, status }) => {
    const comment = state.comments.find((item) => item.id === id)
    if (!comment) return state
    const now = new Date().toISOString()
    const segment = findSegment(state.routes, comment.segmentId)
    // 重新确认时锚定当前区段版本
    const segmentVersion = segment?.version ?? comment.segmentVersion
    const comments = state.comments.map((item) => item.id === id
      ? { ...item, status, segmentVersion, updatedAt: now, invalidatedReason: undefined }
      : item)
    const change: FieldChange = { id: `comment:${id}:status-${now}`, fieldKey: `comment:${id}:status`, value: status, source: 'local', actor: '当前审阅人', changedAt: now }
    const entry: AuditEntry = { id: `audit-resolve-${id}-${now}`, at: now, actor: '当前审阅人', kind: 'comment', text: `意见 ${id}（${comment.role}·${comment.segmentId}）标记为「${status}」，依据区段版本 v${segmentVersion}` }
    return {
      ...state,
      comments,
      pendingChanges: [...state.pendingChanges, change],
      audit: [...state.audit, entry],
    }
  }),
  on(RouteActions.createAlternative, (state) => {
    const now = new Date().toISOString()
    const route = state.routes.find((item) => item.id === state.selectedRouteId)
    const entry: AuditEntry = { id: `audit-alt-${now}`, at: now, actor: '当前审阅人', kind: 'segment', text: `生成替代路径 ${route ? `${route.id}-ALT` : ''}（本地草稿，同步时保留）` }
    return {
      ...state,
      version: state.version + 1,
      routes: state.routes.map((item) => item.id === state.selectedRouteId ? { ...item, id: `${item.id}-ALT`, score: Math.max(72, item.score - 2) } : item),
      audit: [...state.audit, entry],
    }
  }),
  on(RouteActions.lockBaseline, (state) => {
    const now = new Date().toISOString()
    // 锁定前清扫：依据旧版本区段接受的意见先失效，不进入只读基线
    let comments = state.comments
    const sweepEntries: AuditEntry[] = []
    for (const comment of state.comments) {
      if (comment.status !== '已接受') continue
      const segment = findSegment(state.routes, comment.segmentId)
      if (segment && segment.version !== comment.segmentVersion) {
        const invalidated = invalidateSegmentComments(comments, comment.segmentId, segment.version, now)
        comments = invalidated.comments
        sweepEntries.push(...invalidated.entries)
      }
    }
    const baseline: Baseline = {
      id: `BL-v${state.version}`,
      version: state.version,
      lockedAt: now,
      status: '已锁定',
      segmentDigest: digestRoutes(state.routes),
    }
    const lockEntry: AuditEntry = { id: `audit-baseline-lock-v${state.version}`, at: now, actor: '当前审阅人', kind: 'baseline', text: `确认并锁定基线 ${baseline.id}：${state.routes.length} 条运输单、${comments.length} 条意见进入只读保存` }
    const lockChange: FieldChange = { id: `baseline:${baseline.id}:lock-${now}`, fieldKey: `baseline:${baseline.id}:lock`, value: baseline.id, source: 'local', actor: '当前审阅人', changedAt: now }
    return {
      ...state,
      comments,
      baseline,
      pendingChanges: [...state.pendingChanges, lockChange],
      audit: [...state.audit, ...sweepEntries, lockEntry],
    }
  }),
  on(RouteActions.networkStatusChanged, (state, { online }) => ({ ...state, online })),
  on(RouteActions.syncRequested, (state) => ({ ...state, syncing: true, syncError: '' })),
  on(RouteActions.syncNoop, (state) => ({ ...state, syncing: false })),
  // 合并失败：本地草稿与冲突项全部保留，仅记录错误，等待重试
  on(RouteActions.syncFailure, (state, { error }) => ({ ...state, syncing: false, syncError: error })),
  on(RouteActions.syncSuccess, (state, { routes, comments, conflicts, audit, version, baseline, lastSyncAt, appliedChangeIds }) => {
    // 仅清除本次已推送的变更；同步期间新产生的本地修改重放到合并结果上，草稿不丢
    const surviving = state.pendingChanges.filter((change) => !appliedChangeIds.includes(change.id))
    let data: SnapshotData = { routes, comments }
    for (const change of surviving) data = applyFieldChange(data, change)
    return {
      ...state,
      routes: data.routes,
      comments: data.comments,
      conflicts,
      audit: unionById(state.audit, audit),
      version,
      baseVersion: version,
      baseSnapshot: { routes, comments },
      pendingChanges: surviving,
      baseline,
      syncing: false,
      syncError: '',
      lastSyncAt,
    }
  }),
  on(RouteActions.resolveConflict, (state, { id, choice }) => {
    const conflict = state.conflicts.find((item) => item.id === id)
    if (!conflict) return state
    const now = new Date().toISOString()
    const value = choice === 'local' ? conflict.localValue : conflict.remoteValue
    const data = applyFieldChange({ routes: state.routes, comments: state.comments }, { fieldKey: conflict.fieldKey, value })
    const change: FieldChange = { id: `resolve-${conflict.fieldKey}-${now}`, fieldKey: conflict.fieldKey, value, source: 'local', actor: '当前审阅人', changedAt: now }
    const entry: AuditEntry = { id: `audit-resolve-conflict-${conflict.id}-${now}`, at: now, actor: '当前审阅人', kind: 'conflict', text: `裁决冲突：${conflict.label} 采用${choice === 'local' ? '本地' : '远端'}值「${formatFieldValue(value)}」` }
    return {
      ...state,
      routes: data.routes,
      comments: data.comments,
      conflicts: state.conflicts.filter((item) => item.id !== id),
      pendingChanges: [...state.pendingChanges, change],
      audit: [...state.audit, entry],
    }
  }),
)
