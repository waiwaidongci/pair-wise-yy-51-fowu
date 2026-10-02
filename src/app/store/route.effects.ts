import { inject, Injectable } from '@angular/core'
import { Actions, createEffect, ofType } from '@ngrx/effects'
import { Store } from '@ngrx/store'
import { catchError, concatMap, map, of, switchMap, withLatestFrom } from 'rxjs'
import { RouteApiService } from '../services/route-api.service'
import { now } from '../services/sync-merge'
import type { Draft, ReviewComment, RiskSegment, RoutePackage } from '../types'
import * as RouteActions from './route.actions'
import * as SyncActions from './sync.actions'
import type { RouteState } from './route.reducer'
import type { SyncState } from './sync.reducer'

let draftSeq = 0
function nextDraftId(): string {
  return `DRAFT-${Date.now()}-${++draftSeq}`
}

@Injectable()
export class RouteEffects {
  private readonly actions$ = inject(Actions)
  private readonly api = inject(RouteApiService)
  private readonly store = inject(Store<{ routes: RouteState; sync: SyncState }>)

  loadRoutes$ = createEffect(() => this.actions$.pipe(
    ofType(RouteActions.loadRoutes),
    switchMap(() => this.api.getRoutePackages().pipe(
      map((routes) => RouteActions.loadRoutesSuccess({ routes })),
      catchError((error: unknown) => of(RouteActions.loadRoutesFailure({ error: error instanceof Error ? error.message : '无法读取路径数据' }))),
    )),
  ))

  // 修改区段等级：离线进草稿队列，在线立即合并
  updateSegmentLevel$ = createEffect(() => this.actions$.pipe(
    ofType(RouteActions.updateSegmentLevel),
    withLatestFrom(this.store.select('routes'), this.store.select('sync')),
    concatMap(([{ id, level }, routes, sync]) => {
      const segment = routes.routes.flatMap((r: RoutePackage) => r.segments).find((s: RiskSegment) => s.id === id)
      const draft: Draft = {
        id: nextDraftId(), kind: 'segment-level', entityId: id, segmentId: id,
        changes: { level }, base: { level: segment?.level }, baseV: segment?._v ?? 0,
        at: now(), status: 'pending',
      }
      return [
        SyncActions.createDraft({ draft }),
        RouteActions.applySegmentLevel({ id, level }),
        ...(sync.online ? [SyncActions.syncNow()] : []),
      ]
    }),
  ))

  // 发表意见
  addComment$ = createEffect(() => this.actions$.pipe(
    ofType(RouteActions.addComment),
    withLatestFrom(this.store.select('sync')),
    concatMap(([{ comment }, sync]) => {
      const draft: Draft = {
        id: nextDraftId(), kind: 'comment-add', entityId: comment.id, segmentId: comment.segmentId,
        changes: { ...comment }, base: {}, baseV: 0, at: now(), status: 'pending',
      }
      return [
        SyncActions.createDraft({ draft }),
        RouteActions.applyCommentAdd({ comment }),
        ...(sync.online ? [SyncActions.syncNow()] : []),
      ]
    }),
  ))

  // 处理意见（接受/退回）
  resolveComment$ = createEffect(() => this.actions$.pipe(
    ofType(RouteActions.resolveComment),
    withLatestFrom(this.store.select('routes'), this.store.select('sync')),
    concatMap(([{ id, status }, routes, sync]) => {
      const comment = routes.comments.find((c: ReviewComment) => c.id === id)
      const segment = routes.routes.flatMap((r: RoutePackage) => r.segments).find((s: RiskSegment) => s.id === comment?.segmentId)
      const draft: Draft = {
        id: nextDraftId(), kind: 'comment-resolve', entityId: id, segmentId: comment?.segmentId,
        changes: { status }, base: { status: comment?.status }, baseV: comment?._v ?? 0,
        at: now(), status: 'pending', resolvedSegmentV: segment?._v ?? 0,
      }
      return [
        SyncActions.createDraft({ draft }),
        RouteActions.applyCommentResolve({ id, status }),
        ...(sync.online ? [SyncActions.syncNow()] : []),
      ]
    }),
  ))

  // 生成替代路径
  createAlternative$ = createEffect(() => this.actions$.pipe(
    ofType(RouteActions.createAlternative),
    withLatestFrom(this.store.select('routes'), this.store.select('sync')),
    concatMap(([_, routes, sync]) => {
      const route = routes.routes.find((r: RoutePackage) => r.id === routes.selectedRouteId)
      const changes = { id: `${route?.id}-ALT`, score: Math.max(72, (route?.score ?? 74) - 2) }
      const draft: Draft = {
        id: nextDraftId(), kind: 'route', entityId: route?.id ?? '',
        changes, base: { id: route?.id, score: route?.score }, baseV: route?._v ?? 0,
        at: now(), status: 'pending',
      }
      return [
        SyncActions.createDraft({ draft }),
        RouteActions.applyCreateAlternative(),
        ...(sync.online ? [SyncActions.syncNow()] : []),
      ]
    }),
  ))

  // 锁定基线
  lockBaseline$ = createEffect(() => this.actions$.pipe(
    ofType(RouteActions.lockBaseline),
    withLatestFrom(this.store.select('sync')),
    concatMap(([_, sync]) => {
      const draft: Draft = {
        id: nextDraftId(), kind: 'baseline', entityId: 'global',
        changes: {}, base: {}, baseV: 0, at: now(), status: 'pending',
      }
      return [
        SyncActions.createDraft({ draft }),
        RouteActions.applyBaselineLock(),
        ...(sync.online ? [SyncActions.syncNow()] : []),
      ]
    }),
  ))
}
