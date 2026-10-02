export type RiskLevel = '高' | '中' | '低'

export interface RiskSegment {
  id: string
  name: string
  from: string
  to: string
  km: string
  speed: string
  risks: string[]
  level: RiskLevel
  status: '待复核' | '已确认' | '需绕行'
  coordinates: [number, number][]
  /** 区段版本，任何字段被修改都会 +1，意见按此版本锚定 */
  version: number
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
}

export interface ReviewComment {
  id: string
  segmentId: string
  role: string
  author: string
  content: string
  status: '待确认' | '已接受' | '已退回'
  /** 当前处理意见所依据的区段版本，区段版本前进后该意见即失效 */
  segmentVersion: number
  updatedAt: string
  /** 因区段变更被置为待确认时的提示，重新确认后清除 */
  invalidatedReason?: string
}

/** 字段级变更记录：离线草稿与合并的最小单元 */
export interface FieldChange {
  id: string
  /** segment:<区段id>:<字段> 或 comment:<意见id>:<字段> */
  fieldKey: string
  value: unknown
  source: 'local' | 'remote'
  actor: string
  changedAt: string
  /** 远端日志中该变更对应的服务端版本 */
  version?: number
}

export interface ConflictItem {
  id: string
  fieldKey: string
  label: string
  localValue: unknown
  remoteValue: unknown
  localChangedAt: string
  remoteChangedAt: string
  /** 合并时按修改时间暂采用的一侧，人工裁决后覆盖 */
  provisional: 'local' | 'remote'
}

export interface AuditEntry {
  /** 幂等键：同一逻辑事件重试合并时 id 不变，服务端与本地均按 id 去重 */
  id: string
  at: string
  actor: string
  kind: 'segment' | 'comment' | 'remote' | 'sync' | 'conflict' | 'invalidation' | 'baseline'
  text: string
}

export interface Baseline {
  id: string
  version: number
  lockedAt: string
  status: '已锁定' | '已失效'
  /** 锁定时各区段关键字段摘要，区段变更后比对不一致即失效 */
  segmentDigest: Record<string, string>
}

/** 模拟服务端快照（真实部署时对应后端响应） */
export interface ServerSnapshot {
  version: number
  routes: RoutePackage[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  baseline: Baseline | null
  journal: FieldChange[]
}

export interface SnapshotData {
  routes: RoutePackage[]
  comments: ReviewComment[]
}
