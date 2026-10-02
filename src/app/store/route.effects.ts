import { inject, Injectable } from '@angular/core'
import { Actions, createEffect, ofType } from '@ngrx/effects'
import { Action, Store } from '@ngrx/store'
import { catchError, debounceTime, distinctUntilChanged, exhaustMap, filter, fromEvent, map, merge, Observable, of, switchMap, tap, withLatestFrom } from 'rxjs'
import { RouteApiService, VersionMismatchError } from '../services/route-api.service'
import { digestRoutes, mergeSnapshots, unionById } from './merge'
import { saveDraft } from './draft-storage'
import type { RouteState } from './route.reducer'
import type { AuditEntry, Baseline } from '../types'
import * as RouteActions from './route.actions'

@Injectable()
export class RouteEffects {
  private readonly actions$ = inject(Actions)
  private readonly api = inject(RouteApiService)
  private readonly store = inject(Store<{ routes: RouteState }>)

  loadRoutes$ = createEffect(() => this.actions$.pipe(
    ofType(RouteActions.loadRoutes),
    switchMap(() => this.api.fetchServerSnapshot().pipe(
      map((snapshot) => RouteActions.loadRoutesSuccess({ snapshot })),
      catchError((error: unknown) => of(RouteActions.loadRoutesFailure({ error: error instanceof Error ? error.message : '无法读取路径数据' }))),
    )),
  ))

  /** 在线状态监听：断网后仍可继续编辑，恢复后自动合并 */
  networkStatus$ = createEffect(() => merge(
    of(typeof navigator === 'undefined' ? true : navigator.onLine),
    fromEvent(window, 'online').pipe(map(() => true)),
    fromEvent(window, 'offline').pipe(map(() => false)),
  ).pipe(
    distinctUntilChanged(),
    map((online) => RouteActions.networkStatusChanged({ online })),
  ))

  /** 进入离线时模拟其他复核人的远端修改（演示并发合并场景） */
  simulateRemote$ = createEffect(() => this.actions$.pipe(
    ofType(RouteActions.networkStatusChanged),
    filter(({ online }) => !online),
    tap(() => this.api.simulateRemoteActivity()),
  ), { dispatch: false })

  /** 网络恢复、或载入后发现本地草稿 → 触发合并同步（无变更时为空转，不产生新版本） */
  autoSync$ = createEffect(() => this.actions$.pipe(
    ofType(RouteActions.networkStatusChanged, RouteActions.loadRoutesSuccess),
    withLatestFrom(this.store.select('routes')),
    filter(([action, state]) => {
      if (state.syncing) return false
      if (action.type === RouteActions.networkStatusChanged.type) {
        // 已有同步基线后，恢复在线即拉取远端变更并合并本地草稿
        return (action as ReturnType<typeof RouteActions.networkStatusChanged>).online
          && (state.pendingChanges.length > 0 || state.baseSnapshot !== null)
      }
      return state.online && state.pendingChanges.length > 0
    }),
    map(() => RouteActions.syncRequested()),
  ))

  sync$ = createEffect(() => this.actions$.pipe(
    ofType(RouteActions.syncRequested),
    withLatestFrom(this.store.select('routes')),
    exhaustMap(([, state]) => {
      if (!state.online) {
        return of(RouteActions.syncFailure({ error: '当前离线，无法合并：本地草稿与冲突项已保留，网络恢复后可重试。' }))
      }
      return this.attemptSync(state, 3)
    }),
  ))

  /** 任何状态变化后持久化本地草稿（未同步变更、冲突项、审计、基线） */
  persistDraft$ = createEffect(() => this.actions$.pipe(
    debounceTime(250),
    withLatestFrom(this.store.select('routes')),
    tap(([, state]) => saveDraft(state)),
  ), { dispatch: false })

  /**
   * 拉取远端快照 → 三路合并（按版本对齐基线、按字段来源与修改时间裁决）→ 推送合并结果。
   * 版本冲突（他人抢先写入）时重新拉取合并重试；重试使用相同的变更/审计 id，不产生重复审计。
   */
  private attemptSync(state: RouteState, retriesLeft: number): Observable<Action> {
    return this.api.fetchServerSnapshot().pipe(
      switchMap((remote) => {
        if (state.pendingChanges.length === 0 && state.baseSnapshot && remote.version === state.baseVersion) {
          return of(RouteActions.syncNoop())
        }
        const base = state.baseSnapshot ?? { routes: remote.routes, comments: remote.comments }
        const remoteChanges = remote.journal.filter((change) => (change.version ?? 0) > state.baseVersion)
        const merged = mergeSnapshots({
          base,
          local: { routes: state.routes, comments: state.comments },
          remote: { routes: remote.routes, comments: remote.comments },
          localChanges: state.pendingChanges,
          remoteChanges,
        })
        const now = new Date().toISOString()
        const nextVersion = remote.version + 1

        // 合并后基线关联区段发生变化 → 基线失效
        let baseline: Baseline | null = state.baseline ?? remote.baseline
        const extraAudit: AuditEntry[] = []
        if (baseline?.status === '已锁定') {
          const digest = digestRoutes(merged.routes)
          const stale = Object.keys(baseline.segmentDigest).some((segmentId) => digest[segmentId] !== baseline?.segmentDigest[segmentId])
          if (stale) {
            baseline = { ...baseline, status: '已失效' }
            extraAudit.push({
              id: `audit-baseline-stale-v${nextVersion}`,
              at: now,
              actor: '系统',
              kind: 'baseline',
              text: `基线 ${baseline.id} 关联区段在合并中发生变化，基线失效，需重新确认并锁定`,
            })
          }
        }

        const syncEntry: AuditEntry = {
          id: `audit-sync-v${nextVersion}`,
          at: now,
          actor: '系统',
          kind: 'sync',
          text: `同步完成：合并本地 ${state.pendingChanges.length} 项、远端 ${remoteChanges.length} 项变更，${merged.conflicts.length} 项冲突待裁决，${merged.invalidatedCommentIds.length} 条意见失效`,
        }
        const audit = unionById([...state.audit, ...merged.audit, ...extraAudit], [syncEntry])

        return this.api.pushMerged({
          expectedVersion: remote.version,
          routes: merged.routes,
          comments: merged.comments,
          baseline,
          audit,
          changes: state.pendingChanges,
        }).pipe(
          map(({ version }) => RouteActions.syncSuccess({
            routes: merged.routes,
            comments: merged.comments,
            conflicts: merged.conflicts,
            audit,
            version,
            baseline,
            lastSyncAt: now,
            appliedChangeIds: state.pendingChanges.map((change) => change.id),
          })),
          catchError((error: unknown) => {
            if (error instanceof VersionMismatchError && retriesLeft > 1) {
              return this.attemptSync(state, retriesLeft - 1)
            }
            return of(RouteActions.syncFailure({ error: error instanceof Error ? `${error.message}：本地草稿与冲突项已保留，可重试。` : '合并失败：本地草稿与冲突项已保留，可重试。' }))
          }),
        )
      }),
      catchError((error: unknown) => of(RouteActions.syncFailure({ error: error instanceof Error ? `${error.message}：本地草稿与冲突项已保留，可重试。` : '合并失败：本地草稿与冲突项已保留，可重试。' }))),
    )
  }
}
