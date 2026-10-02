import { inject, Injectable } from '@angular/core'
import { Actions, createEffect, ofType } from '@ngrx/effects'
import { Store } from '@ngrx/store'
import { debounceTime, defer, filter, from, map, merge, of, startWith, switchMap, tap, withLatestFrom, catchError } from 'rxjs'
import { fromEvent } from 'rxjs'
import { SyncService } from '../services/sync.service'
import { now } from '../services/sync-merge'
import type { Draft } from '../types'
import * as RouteActions from './route.actions'
import * as SyncActions from './sync.actions'
import type { RouteState } from './route.reducer'
import type { SyncState } from './sync.reducer'

@Injectable()
export class SyncEffects {
  private readonly actions$ = inject(Actions)
  private readonly syncService = inject(SyncService)
  private readonly store = inject(Store<{ routes: RouteState; sync: SyncState }>)

  // 启动时恢复本地草稿，或从远端加载（保证本地与远端元数据一致）
  init$ = createEffect(() => defer(() => {
    const local = this.syncService.loadLocal()
    const drafts = this.syncService.loadDrafts()
    const audit = this.syncService.loadAudit()
    if (local && local.routes.length > 0) {
      return of(
        SyncActions.initFromLocal({ routes: local.routes, comments: local.comments, drafts, audit }),
        ...(typeof navigator !== 'undefined' && navigator.onLine ? [SyncActions.syncNow()] : []),
      )
    }
    return from(this.syncService.getRemote()).pipe(
      switchMap((remote) => of(
        SyncActions.initFromLocal({ routes: remote.routes, comments: remote.comments, drafts, audit }),
        ...(typeof navigator !== 'undefined' && navigator.onLine ? [SyncActions.syncNow()] : []),
      )),
    )
  }))

  // 监听在线/离线状态
  onlineStatus$ = createEffect(() => merge(
    fromEvent(window, 'online').pipe(map(() => true)),
    fromEvent(window, 'offline').pipe(map(() => false)),
  ).pipe(map((online) => SyncActions.setOnline({ online }))))

  // 恢复在线后自动同步
  autoSyncOnOnline$ = createEffect(() => this.actions$.pipe(
    ofType(SyncActions.setOnline),
    filter(({ online }) => online),
    map(() => SyncActions.syncNow()),
  ))

  // 同步：合并草稿进远端
  syncNow$ = createEffect(() => this.actions$.pipe(
    ofType(SyncActions.syncNow),
    withLatestFrom(this.store.select('sync')),
    filter(([, sync]) => sync.online && !sync.syncing),
    switchMap(([, sync]) => from(this.syncService.sync(sync.drafts, sync.audit)).pipe(
      map((result) => SyncActions.syncSuccess({ ...result })),
      catchError((error: unknown) => of(SyncActions.syncFailure({ error: error instanceof Error ? error.message : '合并失败', at: now() }))),
      startWith(SyncActions.syncStart()),
    )),
  ))

  // 失败后重试：草稿与冲突项保留，审计幂等不重复
  retryDraft$ = createEffect(() => this.actions$.pipe(
    ofType(SyncActions.retryDraft),
    map(() => SyncActions.syncNow()),
  ))

  // 解决字段冲突
  resolveConflict$ = createEffect(() => this.actions$.pipe(
    ofType(SyncActions.resolveConflict),
    withLatestFrom(this.store.select('sync')),
    switchMap(([{ draftId, field, choice }, sync]) => {
      const draft = sync.drafts.find((d: Draft) => d.id === draftId)
      if (!draft) return of()
      return from(this.syncService.resolveConflict(draft, choice)).pipe(
        map((result) => SyncActions.conflictResolved({ draftId, field, ...result })),
        catchError((error: unknown) => of(SyncActions.syncFailure({ error: error instanceof Error ? error.message : '冲突解决失败', at: now() }))),
      )
    }),
  ))

  // 模拟远端他人修改区段
  simulateRemoteEdit$ = createEffect(() => this.actions$.pipe(
    ofType(SyncActions.simulateRemoteEdit),
    switchMap(() => from(this.syncService.simulateRemoteEdit()).pipe(
      map((result) => SyncActions.remoteEditApplied({ ...result })),
    )),
  ))

  // 模拟同步失败（仅在用户主动请求时设置标志，避免真实失败污染下次重试）
  simulateSyncFail$ = createEffect(() => this.actions$.pipe(
    ofType(SyncActions.requestSimulateFail),
    tap(() => this.syncService.setSimulateFail()),
  ), { dispatch: false })

  // 持久化本地状态（断网续作）
  persist$ = createEffect(() => this.actions$.pipe(
    withLatestFrom(this.store.select('routes'), this.store.select('sync')),
    debounceTime(400),
    tap(([_, routes, sync]) => {
      if (routes.routes.length === 0) return
      this.syncService.saveLocal(routes.routes, routes.comments)
      this.syncService.saveDrafts(sync.drafts)
      this.syncService.saveAudit(sync.audit)
    }),
  ), { dispatch: false })
}
