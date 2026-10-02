import { mergeDrafts, initMeta, now } from './sync-merge'
import type { Draft, ReviewComment, RoutePackage } from '../types'

declare const process: { exit: (code: number) => void }

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.error(`  ✗ ${msg}`) }
}

function makeRoutes(): RoutePackage[] {
  const at = now()
  return [{
    id: 'R1', cargo: '甲醇', hazardClass: '3', trainCode: 'X1', origin: 'A', destination: 'B',
    tonnage: 100, wagonCount: 2, permit: 'P1', permission: '有效' as const, score: 78, updatedAt: at,
    segments: [
      { id: 'S1', name: 'seg1', from: 'A', to: 'B', km: '10', speed: '60', risks: [], level: '高' as const, status: '需绕行' as const, coordinates: [] as [number, number][] },
      { id: 'S2', name: 'seg2', from: 'B', to: 'C', km: '20', speed: '80', risks: [], level: '低' as const, status: '已确认' as const, coordinates: [] as [number, number][] },
    ],
  }].map((r) => ({
    ...initMeta(r, 'remote' as const, at),
    segments: r.segments.map((s) => initMeta(s, 'remote' as const, at)),
  }))
}

function makeComments(): ReviewComment[] {
  const at = now()
  return [
    { id: 'C1', segmentId: 'S1', role: '安全', author: '甲', content: 'c1', status: '待确认' as const },
    { id: 'C2', segmentId: 'S1', role: '应急', author: '乙', content: 'c2', status: '已接受' as const },
  ].map((c) => initMeta(c, 'remote' as const, at))
}

function makeDraft(over: Partial<Draft>): Draft {
  return {
    id: `D-${Math.random()}`, kind: 'segment-level', entityId: 'S1',
    changes: { level: '中' }, base: { level: '高' }, baseV: 1,
    at: now(), status: 'pending', ...over,
  }
}

console.log('场景1：仅本地改区段等级，远端未改 → 无冲突，本地生效')
{
  const routes = makeRoutes()
  const comments = makeComments()
  const draft = makeDraft({})
  const result = mergeDrafts(routes, comments, [draft], [])
  assert(result.conflicts.length === 0, '无冲突')
  assert(result.applied.length === 1, '草稿已应用')
  const seg = result.routes[0].segments.find((s) => s.id === 'S1')
  assert(seg?.level === '中', '区段等级已更新为中')
  assert(result.audit.some((a) => a.draftId === draft.id), '审计记录已写入')
}

console.log('场景2：两边改同一字段且值不同 → 冲突')
{
  const routes = makeRoutes()
  const comments = makeComments()
  // 远端先把 S1 等级改成低
  const at = now()
  routes[0].segments[0] = { ...routes[0].segments[0], level: '低', status: '待复核', _v: 2, _f: { level: { at, by: 'remote' } } }
  const draft = makeDraft({ at: new Date(Date.now() - 1000).toISOString() })
  const result = mergeDrafts(routes, comments, [draft], [])
  assert(result.conflicts.length === 1, '检测到 1 个冲突')
  assert(result.conflicts[0].field === 'level', '冲突字段为 level')
  assert(result.conflicts[0].localValue === '中', '本地值为中')
  assert(result.conflicts[0].remoteValue === '低', '远端值为低')
}

console.log('场景3：两边改同一字段但值相同 → 无冲突')
{
  const routes = makeRoutes()
  const comments = makeComments()
  const at = now()
  routes[0].segments[0] = { ...routes[0].segments[0], level: '中', _v: 2, _f: { level: { at, by: 'remote' } } }
  const draft = makeDraft({})
  const result = mergeDrafts(routes, comments, [draft], [])
  assert(result.conflicts.length === 0, '无冲突（值一致）')
  assert(result.applied.length === 1, '草稿已应用')
}

console.log('场景4：远端改了区段，已接受意见失效 → 退回待确认')
{
  const routes = makeRoutes()
  const comments = makeComments()
  // 远端改 S1（C2 已接受，依据旧版本）
  const at = now()
  routes[0].segments[0] = { ...routes[0].segments[0], level: '低', _v: 2, _f: { level: { at, by: 'remote' } } }
  // C2 已接受，resolvedSegmentV=1（旧版本）
  comments[1] = { ...comments[1], resolvedSegmentV: 1 }
  const result = mergeDrafts(routes, comments, [], [])
  assert(result.invalidated.includes('C2'), 'C2 失效')
  assert(result.comments.find((c) => c.id === 'C2')?.status === '待确认', 'C2 退回待确认')
  assert(result.comments.find((c) => c.id === 'C2')?.invalidated === true, 'C2 标记失效')
}

console.log('场景5：审计幂等 — 重试不重复写')
{
  const routes = makeRoutes()
  const comments = makeComments()
  // C2 已接受且依据当前区段版本，避免失效审计干扰
  comments[1] = { ...comments[1], resolvedSegmentV: 1 }
  const draft = makeDraft({ auditRecorded: true, status: 'applied' })
  const result = mergeDrafts(routes, comments, [draft], [])
  assert(result.audit.length === 0, '已应用草稿不重复写审计')
}

console.log('场景6：失败后重试，草稿保留')
{
  const routes = makeRoutes()
  const comments = makeComments()
  const draft = makeDraft({ status: 'failed', error: '网络中断' })
  const result = mergeDrafts(routes, comments, [draft], [])
  assert(result.applied.length === 1, '失败草稿重试后应用')
  assert(draft.status === 'applied', '草稿状态更新为 applied')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
