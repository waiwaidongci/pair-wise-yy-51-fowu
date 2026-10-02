import { inject, Injectable } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import type { AuditRecord, ConflictItem, Draft, ReviewComment, RoutePackage } from '../types'
import { defaultComments } from '../store/default-data'
import { initMeta, mergeDrafts, resolveConflictChoice, now, type SyncMergeResult } from './sync-merge'

const REMOTE_KEY = 'rail-remote-state'
const LOCAL_ROUTES_KEY = 'rail-local-routes'
const LOCAL_COMMENTS_KEY = 'rail-local-comments'
const DRAFTS_KEY = 'rail-drafts'
const AUDIT_KEY = 'rail-audit'
const FAIL_FLAG_KEY = 'rail-simulate-fail'

interface RemoteState {
  routes: RoutePackage[]
  comments: ReviewComment[]
}

/**
 * 同步服务：保存“远端”状态（演示环境下用 localStorage 模拟服务端），
 * 负责离线草稿的合并、冲突解决与审计幂等。
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly http = inject(HttpClient)
  private remote: RemoteState | null = null

  /** 读取远端状态（首次从 route-data.json 播种） */
  async getRemote(): Promise<RemoteState> {
    if (this.remote) return this.remote
    const stored = localStorage.getItem(REMOTE_KEY)
    if (stored) {
      this.remote = JSON.parse(stored) as RemoteState
      return this.remote
    }
    const items = await firstValueFrom(this.http.get<{ items: RoutePackage[] }>('route-data.json'))
    const at = now()
    const routes = items.items.map((r) => ({
      ...initMeta(r, 'remote', at),
      segments: r.segments.map((s) => initMeta(s, 'remote', at)),
    }))
    const comments = defaultComments.map((c) => initMeta(c, 'remote', at))
    this.remote = { routes, comments }
    this.persistRemote()
    return this.remote
  }

  /** 把草稿合并进远端，返回合并结果 */
  async sync(drafts: Draft[], existingAudit: AuditRecord[]): Promise<SyncMergeResult> {
    const remote = await this.getRemote()
    // 模拟网络故障：设置标志后下一次同步失败，重试应保留草稿且不重复写审计
    if (localStorage.getItem(FAIL_FLAG_KEY) === '1') {
      localStorage.removeItem(FAIL_FLAG_KEY)
      throw new Error('网络中断，合并失败')
    }
    const result = mergeDrafts(remote.routes, remote.comments, drafts, existingAudit)
    this.remote = { routes: result.routes, comments: result.comments }
    this.persistRemote()
    return result
  }

  /** 解决字段冲突 */
  async resolveConflict(
    draft: Draft,
    choice: 'local' | 'remote',
  ): Promise<{ routes: RoutePackage[]; comments: ReviewComment[]; audit: AuditRecord[] }> {
    const remote = await this.getRemote()
    const at = now()
    const result = resolveConflictChoice(remote.routes, remote.comments, draft, choice, at)
    this.remote = { routes: result.routes, comments: result.comments }
    this.persistRemote()
    return result
  }

  /** 模拟“前面的人”在远端改了区段（用于演示冲突/失效） */
  async simulateRemoteEdit(): Promise<{ routes: RoutePackage[]; comments: ReviewComment[] }> {
    const remote = await this.getRemote()
    const at = now()
    const routes = remote.routes.map((r) => ({ ...r, segments: r.segments.map((s) => ({ ...s })) }))
    // 改 S-203 的风险等级（与本地可能的修改形成同字段冲突）
    const target = routes.flatMap((r) => r.segments).find((s) => s.id === 'S-203')
    if (target) {
      const next = target.level === '高' ? '中' : '高'
      const idx = routes.find((r) => r.segments.some((s) => s.id === 'S-203'))!.segments.findIndex((s) => s.id === 'S-203')
      const routeIdx = routes.findIndex((r) => r.segments.some((s) => s.id === 'S-203'))
      routes[routeIdx].segments[idx] = {
        ...target,
        level: next as '高' | '中' | '低',
        status: next === '高' ? '需绕行' : '待复核',
        _v: (target._v ?? 0) + 1,
        _at: at,
        _by: 'remote' as const,
        _f: { ...(target._f || {}), level: { at, by: 'remote' }, status: { at, by: 'remote' } },
      }
    }
    this.remote = { routes, comments: remote.comments }
    this.persistRemote()
    return { routes, comments: this.remote.comments }
  }

  setSimulateFail(): void {
    localStorage.setItem(FAIL_FLAG_KEY, '1')
  }

  // ---- 本地状态持久化（断网续作） ----
  saveLocal(routes: RoutePackage[], comments: ReviewComment[]): void {
    localStorage.setItem(LOCAL_ROUTES_KEY, JSON.stringify(routes))
    localStorage.setItem(LOCAL_COMMENTS_KEY, JSON.stringify(comments))
  }
  loadLocal(): { routes: RoutePackage[]; comments: ReviewComment[] } | null {
    const r = localStorage.getItem(LOCAL_ROUTES_KEY)
    const c = localStorage.getItem(LOCAL_COMMENTS_KEY)
    if (!r || !c) return null
    try {
      return { routes: JSON.parse(r), comments: JSON.parse(c) }
    } catch {
      return null
    }
  }
  saveDrafts(drafts: Draft[]): void {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  }
  loadDrafts(): Draft[] {
    const raw = localStorage.getItem(DRAFTS_KEY)
    if (!raw) return []
    try {
      return JSON.parse(raw) as Draft[]
    } catch {
      return []
    }
  }
  saveAudit(audit: AuditRecord[]): void {
    localStorage.setItem(AUDIT_KEY, JSON.stringify(audit))
  }
  loadAudit(): AuditRecord[] {
    const raw = localStorage.getItem(AUDIT_KEY)
    if (!raw) return []
    try {
      return JSON.parse(raw) as AuditRecord[]
    } catch {
      return []
    }
  }

  private persistRemote(): void {
    if (this.remote) localStorage.setItem(REMOTE_KEY, JSON.stringify(this.remote))
  }
}
