import type {
  AuditEntry,
  ConflictItem,
  FieldChange,
  ReviewComment,
  RiskSegment,
  RoutePackage,
  SnapshotData,
} from '../types'

export interface MergeInput {
  /** 上次同步成功时的共同祖先（按版本对齐） */
  base: SnapshotData
  local: SnapshotData
  remote: SnapshotData
  /** 本地未同步的字段级变更（提供修改时间） */
  localChanges: FieldChange[]
  /** 远端自 baseVersion 以来的字段级变更日志 */
  remoteChanges: FieldChange[]
}

export interface MergeResult {
  routes: RoutePackage[]
  comments: ReviewComment[]
  conflicts: ConflictItem[]
  invalidatedCommentIds: string[]
  modifiedSegmentIds: string[]
  audit: AuditEntry[]
}

const SEGMENT_FIELDS = ['level', 'status', 'speed', 'km', 'name', 'risks'] as const
type SegmentField = (typeof SEGMENT_FIELDS)[number]

const SEGMENT_FIELD_LABELS: Record<string, string> = {
  level: '风险等级', status: '区段状态', speed: '限速', km: '里程', name: '名称', risks: '风险点',
}
const COMMENT_FIELD_LABELS: Record<string, string> = {
  status: '状态', content: '内容', create: '新增意见',
}

export function fieldLabel(fieldKey: string): string {
  const [kind, id, field] = fieldKey.split(':')
  if (kind === 'segment') return `区段 ${id} · ${SEGMENT_FIELD_LABELS[field] ?? field}`
  if (kind === 'comment') return `意见 ${id} · ${COMMENT_FIELD_LABELS[field] ?? field}`
  if (kind === 'baseline') return `基线 ${id} · 锁定`
  return fieldKey
}

export function formatFieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.join('、')
  if (value && typeof value === 'object' && 'content' in value) {
    return `《${String((value as ReviewComment).content).slice(0, 24)}》`
  }
  return String(value)
}

/** 区段关键字段摘要，用于基线失效比对 */
export function digestRoutes(routes: RoutePackage[]): Record<string, string> {
  const digest: Record<string, string> = {}
  for (const route of routes) {
    for (const segment of route.segments) {
      digest[segment.id] = JSON.stringify({ level: segment.level, status: segment.status, speed: segment.speed })
    }
  }
  return digest
}

export function unionById<T extends { id: string }>(first: T[], second: T[]): T[] {
  const seen = new Set(first.map((item) => item.id))
  return [...first, ...second.filter((item) => !seen.has(item.id))]
}

function segmentField(segment: RiskSegment | undefined, field: SegmentField): unknown {
  if (!segment) return undefined
  return field === 'risks' ? JSON.stringify(segment.risks) : segment[field]
}

function latestChangeAt(changes: FieldChange[], fieldKey: string): string | undefined {
  let latest: string | undefined
  for (const change of changes) {
    if (change.fieldKey === fieldKey && (!latest || change.changedAt > latest)) latest = change.changedAt
  }
  return latest
}

function indexSegments(routes: RoutePackage[]): Map<string, RiskSegment> {
  const map = new Map<string, RiskSegment>()
  for (const route of routes) for (const segment of route.segments) map.set(segment.id, segment)
  return map
}

function orderedUnion(first: string[], second: string[]): string[] {
  const seen = new Set(first)
  return [...first, ...second.filter((id) => !seen.has(id))]
}

/** 把单条字段级变更应用到快照上（用于同步成功后重放同步期间新产生的本地草稿） */
export function applyFieldChange(data: SnapshotData, change: Pick<FieldChange, 'fieldKey' | 'value'>): SnapshotData {
  const [kind, id, field] = change.fieldKey.split(':')
  if (kind === 'segment') {
    const value = field === 'risks' && typeof change.value === 'string' ? JSON.parse(change.value) : change.value
    return {
      ...data,
      routes: data.routes.map((route) => ({
        ...route,
        segments: route.segments.map((segment) => (segment.id === id ? { ...segment, [field]: value } : segment)),
      })),
    }
  }
  if (kind === 'comment') {
    if (field === 'create') {
      const comment = change.value as ReviewComment
      return data.comments.some((item) => item.id === comment.id) ? data : { ...data, comments: [comment, ...data.comments] }
    }
    return {
      ...data,
      comments: data.comments.map((comment) => (comment.id === id ? { ...comment, [field]: change.value } : comment)),
    }
  }
  return data
}

/**
 * 三路字段级合并：
 * - 以 base（共同祖先版本）判定每个字段的修改来源（本地 / 远端 / 双方都改）；
 * - 仅一侧修改 → 采用该侧；双方都改且值不同 → 列冲突，暂按修改时间较新的一侧合并；
 * - 任一侧修改过区段 → 该区段下非待确认的意见强制失效，需重新确认（业务规则覆盖，不计冲突）。
 */
export function mergeSnapshots(input: MergeInput): MergeResult {
  const { base, local, remote, localChanges, remoteChanges } = input
  const conflicts: ConflictItem[] = []
  const audit: AuditEntry[] = []
  const invalidatedCommentIds: string[] = []
  const now = new Date().toISOString()

  const baseSegments = indexSegments(base.routes)
  const localSegments = indexSegments(local.routes)
  const remoteSegments = indexSegments(remote.routes)

  // 1. 任一侧相对基线修改过的区段集合
  const modifiedSegmentIds = new Set<string>()
  for (const [segmentId, baseSegment] of baseSegments) {
    const localSegment = localSegments.get(segmentId)
    const remoteSegment = remoteSegments.get(segmentId)
    for (const field of SEGMENT_FIELDS) {
      if (
        segmentField(localSegment, field) !== segmentField(baseSegment, field)
        || segmentField(remoteSegment, field) !== segmentField(baseSegment, field)
      ) {
        modifiedSegmentIds.add(segmentId)
        break
      }
    }
  }

  // 2. 远端变更写入审计（id 来自远端日志，重试合并时保持稳定，按 id 去重）
  for (const change of remoteChanges) {
    audit.push({
      id: `audit-remote-${change.id}`,
      at: change.changedAt,
      actor: `${change.actor}（远端）`,
      kind: 'remote',
      text: `远端变更：${fieldLabel(change.fieldKey)} 更新为「${formatFieldValue(change.value)}」`,
    })
  }

  // 3. 合并运输单与区段
  const routes: RoutePackage[] = []
  const mergedSegmentVersions = new Map<string, number>()
  const routeIds = orderedUnion(local.routes.map((route) => route.id), remote.routes.map((route) => route.id))
  for (const routeId of routeIds) {
    const localRoute = local.routes.find((route) => route.id === routeId)
    const remoteRoute = remote.routes.find((route) => route.id === routeId)
    const baseRoute = base.routes.find((route) => route.id === routeId)
    if (localRoute && !baseRoute) { routes.push(localRoute); continue } // 本地草稿（如替代方案），不参与合并
    if (!localRoute && remoteRoute) { routes.push(remoteRoute); continue } // 远端新增
    if (!remoteRoute && localRoute) { routes.push(localRoute); continue }
    if (!localRoute || !remoteRoute) continue

    const baseSegmentList = baseRoute?.segments ?? []
    const segments: RiskSegment[] = []
    const segmentIds = orderedUnion(localRoute.segments.map((segment) => segment.id), remoteRoute.segments.map((segment) => segment.id))
    for (const segmentId of segmentIds) {
      const localSegment = localRoute.segments.find((segment) => segment.id === segmentId)
      const remoteSegment = remoteRoute.segments.find((segment) => segment.id === segmentId)
      const baseSegment = baseSegmentList.find((segment) => segment.id === segmentId)
      if (localSegment && !baseSegment) { segments.push(localSegment); continue }
      if (!localSegment && remoteSegment) { segments.push(remoteSegment); continue }
      if (!remoteSegment && localSegment) { segments.push(localSegment); continue }
      if (!localSegment || !remoteSegment) continue

      const mergedSegment: RiskSegment = {
        ...localSegment,
        version: Math.max(localSegment.version, remoteSegment.version, baseSegment?.version ?? 1),
      }
      for (const field of SEGMENT_FIELDS) {
        const fieldKey = `segment:${segmentId}:${field}`
        const baseValue = segmentField(baseSegment, field)
        const localValue = segmentField(localSegment, field)
        const remoteValue = segmentField(remoteSegment, field)
        const localChanged = localValue !== baseValue
        const remoteChanged = remoteValue !== baseValue
        let value: unknown
        if (localChanged && remoteChanged && localValue !== remoteValue) {
          // 同一字段两边都改且不一致 → 冲突，暂按修改时间较新者合并
          const localAt = latestChangeAt(localChanges, fieldKey) ?? ''
          const remoteAt = latestChangeAt(remoteChanges, fieldKey) ?? ''
          const provisional: 'local' | 'remote' = localAt >= remoteAt ? 'local' : 'remote'
          value = provisional === 'local' ? localValue : remoteValue
          conflicts.push({
            id: `conflict-${fieldKey}`,
            fieldKey,
            label: fieldLabel(fieldKey),
            localValue: localSegment[field],
            remoteValue: remoteSegment[field],
            localChangedAt: localAt,
            remoteChangedAt: remoteAt,
            provisional,
          })
          audit.push({
            id: `audit-conflict-${fieldKey}`,
            at: now,
            actor: '系统',
            kind: 'conflict',
            text: `字段冲突：${fieldLabel(fieldKey)} 本地与远端不一致，暂按${provisional === 'local' ? '本地' : '远端'}（修改时间较新）合并，待人工裁决`,
          })
        } else {
          value = remoteChanged ? remoteValue : localValue
        }
        mergedSegment[field] = (field === 'risks' ? JSON.parse(String(value)) : value) as never
      }
      mergedSegmentVersions.set(segmentId, mergedSegment.version)
      segments.push(mergedSegment)
    }
    routes.push({ ...remoteRoute, segments })
  }

  // 4. 合并审批意见；区段被任一侧修改过时，相关意见失效需重新确认（覆盖规则，不列冲突）
  const comments: ReviewComment[] = []
  const seen = new Set<string>()
  for (const localComment of local.comments) {
    const baseComment = base.comments.find((comment) => comment.id === localComment.id)
    const remoteComment = remote.comments.find((comment) => comment.id === localComment.id)
    if (!baseComment || !remoteComment) {
      comments.push(localComment)
      seen.add(localComment.id)
      continue
    }
    const segmentModified = modifiedSegmentIds.has(localComment.segmentId)
    const merged: ReviewComment = { ...localComment }

    // 状态字段
    const statusKey = `comment:${localComment.id}:status`
    const localStatusChanged = localComment.status !== baseComment.status
    const remoteStatusChanged = remoteComment.status !== baseComment.status
    if (localStatusChanged && remoteStatusChanged && localComment.status !== remoteComment.status && !segmentModified) {
      const localAt = latestChangeAt(localChanges, statusKey) ?? ''
      const remoteAt = latestChangeAt(remoteChanges, statusKey) ?? ''
      const provisional: 'local' | 'remote' = localAt >= remoteAt ? 'local' : 'remote'
      merged.status = provisional === 'local' ? localComment.status : remoteComment.status
      conflicts.push({
        id: `conflict-${statusKey}`,
        fieldKey: statusKey,
        label: fieldLabel(statusKey),
        localValue: localComment.status,
        remoteValue: remoteComment.status,
        localChangedAt: localAt,
        remoteChangedAt: remoteAt,
        provisional,
      })
      audit.push({
        id: `audit-conflict-${statusKey}`,
        at: now,
        actor: '系统',
        kind: 'conflict',
        text: `字段冲突：${fieldLabel(statusKey)} 本地与远端不一致，暂按${provisional === 'local' ? '本地' : '远端'}（修改时间较新）合并，待人工裁决`,
      })
    } else {
      merged.status = remoteStatusChanged ? remoteComment.status : localComment.status
    }

    // 内容字段
    const contentKey = `comment:${localComment.id}:content`
    const localContentChanged = localComment.content !== baseComment.content
    const remoteContentChanged = remoteComment.content !== baseComment.content
    if (localContentChanged && remoteContentChanged && localComment.content !== remoteComment.content) {
      const localAt = latestChangeAt(localChanges, contentKey) ?? ''
      const remoteAt = latestChangeAt(remoteChanges, contentKey) ?? ''
      const provisional: 'local' | 'remote' = localAt >= remoteAt ? 'local' : 'remote'
      merged.content = provisional === 'local' ? localComment.content : remoteComment.content
      conflicts.push({
        id: `conflict-${contentKey}`,
        fieldKey: contentKey,
        label: fieldLabel(contentKey),
        localValue: localComment.content,
        remoteValue: remoteComment.content,
        localChangedAt: localAt,
        remoteChangedAt: remoteAt,
        provisional,
      })
    } else {
      merged.content = remoteContentChanged ? remoteComment.content : localComment.content
    }

    merged.updatedAt = localComment.updatedAt >= remoteComment.updatedAt ? localComment.updatedAt : remoteComment.updatedAt
    merged.segmentVersion = merged.status === remoteComment.status && remoteStatusChanged && !localStatusChanged
      ? remoteComment.segmentVersion
      : localComment.segmentVersion

    // 区段变更覆盖规则：相关意见失效，重新确认
    if (segmentModified && merged.status !== '待确认') {
      merged.status = '待确认'
      merged.invalidatedReason = `区段 ${localComment.segmentId} 已变更，需重新确认`
      invalidatedCommentIds.push(localComment.id)
      const segmentVersion = mergedSegmentVersions.get(localComment.segmentId) ?? localComment.segmentVersion
      audit.push({
        id: `audit-inv-${localComment.id}-${localComment.segmentId}-v${segmentVersion}`,
        at: now,
        actor: '系统',
        kind: 'invalidation',
        text: `区段 ${localComment.segmentId} 已变更（v${segmentVersion}），意见 ${localComment.id}（${localComment.role}·${localComment.author}）失效，需重新确认`,
      })
    } else if (merged.status === '待确认') {
      merged.invalidatedReason = localComment.invalidatedReason ?? remoteComment.invalidatedReason
    } else {
      merged.invalidatedReason = undefined
    }

    comments.push(merged)
    seen.add(localComment.id)
  }
  for (const remoteComment of remote.comments) {
    if (!seen.has(remoteComment.id)) comments.push(remoteComment) // 远端新增意见
  }

  return {
    routes,
    comments,
    conflicts,
    invalidatedCommentIds,
    modifiedSegmentIds: [...modifiedSegmentIds],
    audit,
  }
}
