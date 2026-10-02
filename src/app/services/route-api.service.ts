import { inject, Injectable } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { delay, map, of, throwError } from 'rxjs'
import type { AuditEntry, Baseline, FieldChange, ReviewComment, RoutePackage, ServerSnapshot } from '../types'
import { SEED_VERSION, seedAudit, seedComments } from '../seed'
import { unionById } from '../store/merge'

const SERVER_KEY = 'rail-approval-server-v1'

interface ServerStore extends ServerSnapshot {
  /** 本次离线期间是否已模拟过同事变更，避免重复注入 */
  simulated: boolean
}

export class VersionMismatchError extends Error {
  override readonly name = 'VersionMismatch'
  constructor(expected: number, actual: number) {
    super(`服务端版本已变化（期望 v${expected}，实际 v${actual}），需要重新合并`)
  }
}

export interface PushPayload {
  expectedVersion: number
  routes: RoutePackage[]
  comments: ReviewComment[]
  baseline: Baseline | null
  audit: AuditEntry[]
  changes: FieldChange[]
}

/**
 * 模拟审批服务端：快照与变更日志持久化在 localStorage。
 * 真实部署时对应「获取快照 / 提交合并结果」两个接口，合并规则不变。
 */
@Injectable({ providedIn: 'root' })
export class RouteApiService {
  private readonly http = inject(HttpClient)

  getRoutePackages() {
    return this.http.get<{ items: RoutePackage[] }>('route-data.json').pipe(map((response) => response.items))
  }

  fetchServerSnapshot() {
    const existing = this.readServer()
    if (existing) return of(this.toSnapshot(existing)).pipe(delay(200))
    return this.getRoutePackages().pipe(
      map((routes) => {
        const seeded: ServerStore = {
          version: SEED_VERSION,
          routes: routes.map((route) => ({
            ...route,
            segments: route.segments.map((segment) => ({ ...segment, version: segment.version ?? 1 })),
          })),
          comments: seedComments.map((comment) => ({ ...comment })),
          audit: seedAudit.map((entry) => ({ ...entry })),
          baseline: null,
          journal: [],
          simulated: false,
        }
        this.writeServer(seeded)
        return this.toSnapshot(seeded)
      }),
      delay(200),
    )
  }

  /**
   * 模拟断网期间其他复核人的修改（演示并发场景）：
   * 同事重新评估了 S-207 区段并接受了 RV-31，幂等，重复进入离线不会叠加。
   */
  simulateRemoteActivity(): void {
    const server = this.readServer()
    if (!server || server.simulated) return
    const segment = server.routes.flatMap((route) => route.segments).find((item) => item.id === 'S-207')
    const comment = server.comments.find((item) => item.id === 'RV-31')
    if (!segment || !comment) return
    if (segment.level === '中' && comment.status === '已接受') return // 已应用过同样的变更

    const now = new Date().toISOString()
    const version = server.version + 1
    const changes: FieldChange[] = [
      { id: `remote-s207-level-${now}`, fieldKey: 'segment:S-207:level', value: '中', source: 'remote', actor: '罗晋', changedAt: now, version },
      { id: `remote-s207-status-${now}`, fieldKey: 'segment:S-207:status', value: '待复核', source: 'remote', actor: '罗晋', changedAt: now, version },
      { id: `remote-rv31-status-${now}`, fieldKey: 'comment:RV-31:status', value: '已接受', source: 'remote', actor: '罗晋', changedAt: now, version },
    ]
    segment.level = '中'
    segment.status = '待复核'
    segment.version += 1
    comment.status = '已接受'
    comment.updatedAt = now
    server.version = version
    server.journal = [...server.journal, ...changes]
    server.simulated = true
    this.writeServer(server)
  }

  /**
   * 提交合并结果：版本校验失败抛 VersionMismatchError（调用方重新拉取合并后重试）。
   * 审计与变更日志按 id 去重，重试不会产生重复审计记录。
   */
  pushMerged(payload: PushPayload) {
    try {
      const server = this.readServer()
      if (!server) throw new Error('服务端数据未初始化')
      if (server.version !== payload.expectedVersion) {
        throw new VersionMismatchError(payload.expectedVersion, server.version)
      }
      const version = server.version + 1
      const next: ServerStore = {
        version,
        routes: payload.routes,
        comments: payload.comments,
        baseline: payload.baseline,
        audit: unionById(server.audit, payload.audit),
        journal: [...server.journal, ...payload.changes.map((change) => ({ ...change, version }))],
        simulated: false,
      }
      this.writeServer(next)
      return of({ version }).pipe(delay(250))
    } catch (error) {
      return throwError(() => error)
    }
  }

  private toSnapshot(store: ServerStore): ServerSnapshot {
    const { simulated: _simulated, ...snapshot } = store
    return structuredClone(snapshot)
  }

  private readServer(): ServerStore | null {
    try {
      const raw = localStorage.getItem(SERVER_KEY)
      return raw ? (JSON.parse(raw) as ServerStore) : null
    } catch {
      return null
    }
  }

  private writeServer(server: ServerStore): void {
    try {
      localStorage.setItem(SERVER_KEY, JSON.stringify(server))
    } catch {
      // 存储不可用时静默降级
    }
  }
}
