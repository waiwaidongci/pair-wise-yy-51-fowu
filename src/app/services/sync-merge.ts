import type {
  AuditRecord,
  ConflictItem,
  Draft,
  FieldMeta,
  FieldSource,
  ReviewComment,
  RiskSegment,
  RoutePackage,
} from '../types'

export const now = (): string => new Date().toISOString()

/** 字段中文名，用于冲突展示 */
export const FIELD_LABELS: Record<string, string> = {
  level: '风险等级',
  status: '区段状态',
  name: '名称',
  speed: '限速',
  km: '里程',
  content: '意见内容',
  permission: '许可状态',
  score: '风险分',
}

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] || field
}

/** 为实体初始化字段级元数据（远端种子用） */
export function initMeta<T extends object>(entity: T, source: FieldSource, at: string): T & { _v: number; _at: string; _by: FieldSource; _f: Record<string, FieldMeta> } {
  const keys = Object.keys(entity).filter((k) => !k.startsWith('_'))
  const _f: Record<string, FieldMeta> = {}
  for (const k of keys) _f[k] = { at, by: source }
  return { ...entity, _v: 1, _at: at, _by: source, _f }
}

/** 实体修改：bump 版本并更新字段元数据 */
export function touchEntity<T extends { _v?: number; _at?: string; _by?: FieldSource; _f?: Record<string, FieldMeta> }>(
  entity: T,
  changes: Record<string, unknown>,
  source: FieldSource,
  at: string,
): T {
  const _f = { ...(entity._f || {}) }
  for (const k of Object.keys(changes)) _f[k] = { at, by: source }
  return { ...entity, ...changes, _v: (entity._v || 0) + 1, _at: at, _by: source, _f }
}

function findSegment(routes: RoutePackage[], segmentId: string): RiskSegment | undefined {
  for (const r of routes) {
    const s = r.segments.find((seg) => seg.id === segmentId)
    if (s) return s
  }
  return undefined
}

/**
 * 将一条草稿合并进远端实体。
 * 规则（按版本、字段来源、修改时间）：
 *  - 远端在草稿之后未改该字段 → 本地修改生效（无冲突）
 *  - 远端也改了同一字段且值不一致 → 冲突，待人工选择
 *  - 两边改后值一致 → 直接采用，不算冲突
 */
export function mergeDraftIntoEntity(
  entity: RoutePackage | RiskSegment | ReviewComment,
  draft: Draft,
  at: string,
): { entity: RoutePackage | RiskSegment | ReviewComment; conflicts: ConflictItem[] } {
  const conflicts: ConflictItem[] = []
  let result: RoutePackage | RiskSegment | ReviewComment = { ...entity }

  for (const [field, localValue] of Object.entries(draft.changes)) {
    const baseValue = draft.base[field]
    const remoteValue = (entity as unknown as Record<string, unknown>)[field]
    const remoteMeta = entity._f?.[field]
    // 远端在草稿创建之后是否也动过该字段
    const remoteChanged = remoteMeta ? remoteMeta.at > draft.at : remoteValue !== baseValue

    if (remoteChanged && remoteValue !== baseValue) {
      if (remoteValue === localValue) {
        // 两边改后一致，无冲突
        result = { ...result, [field]: localValue }
      } else {
        conflicts.push({
          draftId: draft.id,
          kind: draft.kind,
          entityId: draft.entityId,
          segmentId: draft.segmentId,
          field,
          label: fieldLabel(field),
          localValue,
          remoteValue,
          at,
        })
      }
    } else {
      // 远端未动，本地修改生效
      result = { ...result, [field]: localValue }
    }
  }

  return { entity: result, conflicts }
}

export interface SyncMergeResult {
  routes: RoutePackage[]
  comments: ReviewComment[]
  applied: Draft[]
  conflicts: ConflictItem[]
  invalidated: string[]
  audit: AuditRecord[]
  remoteVersion: number
  at: string
}

/**
 * 把一批草稿合并进远端状态。
 * - 仅处理 pending / failed（重试）草稿；applied 跳过（审计幂等）
 * - 区段/意见草稿逐条合并，冲突不阻断其余草稿
 * - 区段版本更新后，已接受/退回的意见失效，需重新确认
 */
export function mergeDrafts(
  remoteRoutes: RoutePackage[],
  remoteComments: ReviewComment[],
  drafts: Draft[],
  existingAudit: AuditRecord[],
  opts: { force?: boolean } = {},
): SyncMergeResult {
  const at = now()
  let routes = remoteRoutes.map((r) => ({ ...r, segments: r.segments.map((s) => ({ ...s })) }))
  let comments = remoteComments.map((c) => ({ ...c }))
  const applied: Draft[] = []
  const conflicts: ConflictItem[] = []
  const invalidated: string[] = []
  const audit: AuditRecord[] = [...existingAudit]
  let auditSeq = existingAudit.length

  const pushAudit = (rec: Omit<AuditRecord, 'id' | 'at'>) => {
    audit.push({ ...rec, id: `AUD-${String(++auditSeq).padStart(3, '0')}`, at })
  }

  for (const draft of drafts) {
    if (draft.status === 'applied') continue

    if (draft.kind === 'comment-add') {
      const exists = comments.some((c) => c.id === draft.entityId)
      if (!exists) {
        const comment = touchEntity(draft.changes as unknown as ReviewComment, {}, 'remote', at)
        comments = [comment, ...comments]
      }
      applied.push(draft)
      if (!draft.auditRecorded) {
        pushAudit({ draftId: draft.id, kind: 'comment', commentId: draft.entityId, segmentId: draft.segmentId, event: `新增意见 ${draft.entityId}` })
        draft.auditRecorded = true
      }
      continue
    }

    if (draft.kind === 'baseline') {
      applied.push(draft)
      if (!draft.auditRecorded) {
        pushAudit({ draftId: draft.id, kind: 'baseline', event: '基线已锁定：审批意见、路径版本与原始附件只读保存' })
        draft.auditRecorded = true
      }
      continue
    }

    // 定位目标实体
    let target: RoutePackage | RiskSegment | ReviewComment | undefined
    if (draft.kind === 'segment-level' || draft.kind === 'segment-status') {
      target = findSegment(routes, draft.entityId)
    } else if (draft.kind === 'comment-resolve') {
      target = comments.find((c) => c.id === draft.entityId)
    } else if (draft.kind === 'route') {
      target = routes.find((r) => r.id === draft.entityId)
    }

    if (!target) {
      // 实体在远端不存在（可能已被删除），标记失败，保留草稿待重试
      draft.status = 'failed'
      draft.error = '目标实体在远端不存在'
      continue
    }

    const { entity: merged, conflicts: fieldConflicts } = mergeDraftIntoEntity(target, draft, at)

    if (fieldConflicts.length > 0 && !opts.force) {
      conflicts.push(...fieldConflicts)
      draft.status = 'conflict'
      draft.conflictFields = fieldConflicts.map((c) => c.field)
      // 冲突字段不写入远端；非冲突字段已在 mergeDraftIntoEntity 中应用
      // 这里 merged 只包含无冲突字段，需要回写到对应实体
      writeBack(routes, comments, draft, merged)
      continue
    }

    // 全部字段生效（或强制覆盖）
    writeBack(routes, comments, draft, merged)
    // 意见处理时记录所依据的区段版本，供失效判断
    if (draft.kind === 'comment-resolve' && draft.resolvedSegmentV !== undefined) {
      const idx = comments.findIndex((c) => c.id === draft.entityId)
      if (idx >= 0) comments[idx] = { ...comments[idx], resolvedSegmentV: draft.resolvedSegmentV }
    }
    draft.status = 'applied'
    draft.conflictFields = undefined
    draft.error = undefined
    applied.push(draft)

    if (!draft.auditRecorded) {
      if (draft.kind === 'segment-level') {
        pushAudit({ draftId: draft.id, kind: 'segment', segmentId: draft.entityId, event: `区段 ${draft.entityId} 风险等级调整为 ${String(draft.changes['level'])}` })
      } else if (draft.kind === 'segment-status') {
        pushAudit({ draftId: draft.id, kind: 'segment', segmentId: draft.entityId, event: `区段 ${draft.entityId} 状态调整为 ${String(draft.changes['status'])}` })
      } else if (draft.kind === 'comment-resolve') {
        pushAudit({ draftId: draft.id, kind: 'comment', commentId: draft.entityId, segmentId: draft.segmentId, event: `意见 ${draft.entityId} 处理为 ${String(draft.changes['status'])}` })
      } else if (draft.kind === 'route') {
        pushAudit({ draftId: draft.id, kind: 'sync', event: `运输单 ${draft.entityId} 已更新` })
      }
      draft.auditRecorded = true
    }
  }

  // 区段版本更新后，已接受/退回的意见失效，需重新确认
  for (const comment of comments) {
    if (comment.status !== '已接受' && comment.status !== '已退回') continue
    const segment = findSegment(routes, comment.segmentId)
    if (!segment) continue
    const resolvedV = comment.resolvedSegmentV ?? 0
    if ((segment._v ?? 0) > resolvedV) {
      comment.status = '待确认'
      comment.invalidated = true
      comment.invalidatedAt = at
      invalidated.push(comment.id)
      pushAudit({ kind: 'comment', commentId: comment.id, segmentId: comment.segmentId, event: `区段 ${comment.segmentId} 已变更，意见 ${comment.id} 失效，需重新确认` })
    }
  }

  const remoteVersion = routes.reduce((m, r) => Math.max(m, r._v ?? 0, ...r.segments.map((s) => s._v ?? 0)), 0)

  return { routes, comments, applied, conflicts, invalidated, audit, remoteVersion, at }
}

function writeBack(
  routes: RoutePackage[],
  comments: ReviewComment[],
  draft: Draft,
  merged: RoutePackage | RiskSegment | ReviewComment,
): void {
  if (draft.kind === 'segment-level' || draft.kind === 'segment-status') {
    for (const r of routes) {
      const idx = r.segments.findIndex((s) => s.id === draft.entityId)
      if (idx >= 0) { r.segments[idx] = merged as RiskSegment; return }
    }
  }
  if (draft.kind === 'comment-resolve') {
    const idx = comments.findIndex((c) => c.id === draft.entityId)
    if (idx >= 0) comments[idx] = merged as ReviewComment
    return
  }
  if (draft.kind === 'route') {
    const idx = routes.findIndex((r) => r.id === draft.entityId)
    if (idx >= 0) routes[idx] = merged as RoutePackage
  }
}

/** 解决冲突：choice=local 强制覆盖远端；choice=remote 丢弃本地 */
export function resolveConflictChoice(
  remoteRoutes: RoutePackage[],
  remoteComments: ReviewComment[],
  draft: Draft,
  choice: 'local' | 'remote',
  at: string,
): { routes: RoutePackage[]; comments: ReviewComment[]; audit: AuditRecord[] } {
  const routes = remoteRoutes.map((r) => ({ ...r, segments: r.segments.map((s) => ({ ...s })) }))
  const comments = remoteComments.map((c) => ({ ...c }))
  const audit: AuditRecord[] = []

  if (choice === 'local') {
    // 强制把本地值写入远端
    if (draft.kind === 'segment-level' || draft.kind === 'segment-status') {
      for (const r of routes) {
        const idx = r.segments.findIndex((s) => s.id === draft.entityId)
        if (idx >= 0) {
          r.segments[idx] = touchEntity(r.segments[idx], draft.changes, 'remote', at)
          break
        }
      }
    } else if (draft.kind === 'comment-resolve') {
      const idx = comments.findIndex((c) => c.id === draft.entityId)
      if (idx >= 0) {
        comments[idx] = touchEntity(comments[idx], draft.changes, 'remote', at)
        if (draft.resolvedSegmentV !== undefined) comments[idx] = { ...comments[idx], resolvedSegmentV: draft.resolvedSegmentV }
      }
    }
    audit.push({ id: `AUD-${Date.now()}`, draftId: draft.id, at, kind: 'sync', event: `冲突已按本地值合并：${draft.entityId}` })
  }
  // choice === 'remote'：远端已是该值，无需写入，丢弃草稿即可

  return { routes, comments, audit }
}
