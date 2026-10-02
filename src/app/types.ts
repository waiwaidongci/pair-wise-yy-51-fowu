export type RiskLevel = '高' | '中' | '低'
export type FieldSource = 'local' | 'remote'
export type CommentStatus = '待确认' | '已接受' | '已退回'
export type SegmentStatus = '待复核' | '已确认' | '需绕行'

/** 字段级元数据：记录每个字段最后由谁、在什么时间修改 */
export interface FieldMeta {
  at: string
  by: FieldSource
}

export interface RiskSegment {
  id: string
  name: string
  from: string
  to: string
  km: string
  speed: string
  risks: string[]
  level: RiskLevel
  status: SegmentStatus
  coordinates: [number, number][]
  _v?: number
  _at?: string
  _by?: FieldSource
  _f?: Record<string, FieldMeta>
}

export interface RoutePackage {
  id: string
  cargo: string
  hazardClass: string
  trainCode: string
  origin: string
  destination: string
  tonnage: number
  wagonCount: number
  permit: string
  permission: '有效' | '缺失' | '待补充'
  score: number
  updatedAt: string
  segments: RiskSegment[]
  _v?: number
  _at?: string
  _by?: FieldSource
  _f?: Record<string, FieldMeta>
}

export interface ReviewComment {
  id: string
  segmentId: string
  role: string
  author: string
  content: string
  status: CommentStatus
  _v?: number
  _at?: string
  _by?: FieldSource
  _f?: Record<string, FieldMeta>
  /** 区段变更后旧意见失效，需重新确认 */
  invalidated?: boolean
  invalidatedAt?: string
  /** 接受/退回时所依据的区段版本；区段版本更新后意见失效 */
  resolvedSegmentV?: number
}

/** 离线草稿类型 */
export type DraftKind = 'segment-level' | 'segment-status' | 'comment-add' | 'comment-resolve' | 'route' | 'baseline'
export type DraftStatus = 'pending' | 'applied' | 'conflict' | 'failed'

/** 离线草稿：断网时本地保存，联网后按版本/字段来源/时间合并 */
export interface Draft {
  id: string
  kind: DraftKind
  entityId: string
  segmentId?: string
  changes: Record<string, unknown>
  /** 草稿基于的字段快照，用于判断远端是否也改了同一字段 */
  base: Record<string, unknown>
  baseV: number
  at: string
  status: DraftStatus
  conflictFields?: string[]
  error?: string
  /** 意见处理时所依据的区段版本（用于失效判断） */
  resolvedSegmentV?: number
  /** 审计幂等键：同一草稿只写一次审计记录 */
  auditRecorded?: boolean
}

/** 字段冲突：同一字段两边都改且值不一致 */
export interface ConflictItem {
  draftId: string
  kind: DraftKind
  entityId: string
  segmentId?: string
  field: string
  label: string
  localValue: unknown
  remoteValue: unknown
  at: string
}

/** 审计记录：草稿驱动的事件以 draftId 幂等，重试不重复写 */
export interface AuditRecord {
  id: string
  draftId?: string
  at: string
  event: string
  kind: 'segment' | 'comment' | 'sync' | 'baseline'
  segmentId?: string
  commentId?: string
}
