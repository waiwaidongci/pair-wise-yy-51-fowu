import type { AuditEntry, ReviewComment } from './types'

/** 初始数据版本，与服务端种子版本一致 */
export const SEED_VERSION = 6

export const seedComments: ReviewComment[] = [
  { id: 'RV-31', segmentId: 'S-203', role: '安全', author: '韩洁', content: '水源地保护段限速 45 km/h，并要求随车配置吸附围油栏。', status: '待确认', segmentVersion: 1, updatedAt: '2026-10-02T16:42:00+08:00' },
  { id: 'RV-32', segmentId: 'S-207', role: '应急', author: '罗晋', content: '长隧道出口需增加 15 分钟现场监护窗口，接受后方可放行。', status: '已接受', segmentVersion: 1, updatedAt: '2026-10-02T16:18:00+08:00' },
]

export const seedAudit: AuditEntry[] = [
  { id: 'audit-seed-1', at: '2026-10-02T16:42:00+08:00', actor: '韩洁', kind: 'comment', text: '韩洁新增 S-203 限速与吸附物资要求' },
  { id: 'audit-seed-2', at: '2026-10-02T16:18:00+08:00', actor: '罗晋', kind: 'comment', text: '罗晋接受隧道出口监护条件' },
  { id: 'audit-seed-3', at: '2026-10-02T15:50:00+08:00', actor: '系统', kind: 'segment', text: '系统生成替代路径 R-ALT-02' },
]
