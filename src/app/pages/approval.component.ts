import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { Store } from '@ngrx/store'
import { MatButtonModule } from '@angular/material/button'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatTabsModule } from '@angular/material/tabs'
import { MatChipsModule } from '@angular/material/chips'
import { RouteState } from '../store/route.reducer'
import { SyncState } from '../store/sync.reducer'
import * as RouteActions from '../store/route.actions'
import * as SyncActions from '../store/sync.actions'
import type { CommentStatus, ConflictItem, Draft, RoutePackage } from '../types'

@Component({
  selector: 'app-approval',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatTabsModule, MatChipsModule],
  template: `
    <main class="page">
      <div class="page-head"><div><p class="eyebrow">安全 · 运营 · 应急会签</p><h1>逐区段审批与退回</h1><p>每条意见锚定运输区段，原记录不可覆盖，所有确认写入审计时间线。</p></div><button mat-flat-button color="primary" (click)="lockBaseline()">确认并锁定基线</button></div>

      <div class="sync-bar">
        @if (sync$ | async; as sync) {
          <mat-chip [class.online]="sync.online" [class.offline]="!sync.online">{{ sync.online ? '在线' : '离线' }}</mat-chip>
          @if (sync.lastSyncedAt) { <span class="sync-time">上次同步 {{ sync.lastSyncedAt }}</span> }
          <span class="sync-count">{{ sync.drafts.length }} 项草稿 · {{ sync.conflicts.length }} 项冲突</span>
          <span class="spacer"></span>
          <button mat-stroked-button (click)="syncNow()" [disabled]="!sync.online || sync.syncing">立即同步</button>
          <button mat-stroked-button (click)="simulateFail()">模拟同步失败</button>
        }
      </div>
      @if (sync$ | async; as sync) {
        @if (!sync.online) { <div class="offline-banner">离线模式：修改将保存在本地，恢复网络后按版本、字段来源与修改时间自动合并。</div> }
        @if (sync.error) { <div class="error-banner">同步失败：{{ sync.error }}。<a (click)="retryAll()">点击重试</a>（草稿与冲突项保留，审计不重复写入）</div> }
      }

      <mat-tab-group>
        <mat-tab label="待处理意见"><section class="card comment-list">
          @for (comment of (state$ | async)?.comments || []; track comment.id) {
            <div class="comment" [class.invalidated]="comment.invalidated">
              <div class="comment-head"><div><b>{{comment.role}} · {{comment.author}}</b><small>{{comment.segmentId}} · {{comment.id}}</small></div><span>{{comment.status}}</span></div>
              @if (comment.invalidated) { <div class="invalidated-badge">区段已变更，原意见失效，请重新确认</div> }
              <p>{{comment.content}}</p>
              <div class="actions"><button mat-stroked-button color="warn" (click)="resolve(comment.id,'已退回')">退回补件</button><button mat-flat-button color="primary" (click)="resolve(comment.id,'已接受')">接受条件</button></div>
            </div>
          }
        </section></mat-tab>
        <mat-tab label="发表区段意见"><section class="card form-card">
          <div class="two"><mat-form-field><mat-label>专业角色</mat-label><mat-select [(ngModel)]="role"><mat-option>安全</mat-option><mat-option>运营</mat-option><mat-option>应急</mat-option></mat-select></mat-form-field><mat-form-field><mat-label>区段</mat-label><mat-select [(ngModel)]="segmentId"><mat-option *ngFor="let segment of segments" [value]="segment.id">{{segment.id}} · {{segment.name}}</mat-option></mat-select></mat-form-field></div>
          <mat-form-field class="wide"><mat-label>审批条件与依据</mat-label><textarea matInput rows="5" [(ngModel)]="content" placeholder="明确区段、约束、时限与验收证据"></textarea></mat-form-field>
          <button mat-flat-button color="primary" [disabled]="!content.trim()" (click)="addComment()">提交意见</button>
        </section></mat-tab>
        <mat-tab label="草稿与冲突">
          @if (sync$ | async; as sync) {
            @if (sync.conflicts.length > 0) {
              <section class="card conflict-card">
                <h2>字段冲突（同一字段两边都改）</h2>
                @for (conflict of sync.conflicts; track conflict.draftId + conflict.field) {
                  <div class="conflict">
                    <div class="conflict-head"><b>{{ conflict.label }}</b><small>{{ conflict.entityId }} · {{ conflict.draftId }}</small></div>
                    <div class="conflict-values">
                      <span class="local">本地：{{ stringify(conflict.localValue) }}</span>
                      <span class="remote">远端：{{ stringify(conflict.remoteValue) }}</span>
                    </div>
                    <div class="actions"><button mat-stroked-button (click)="resolveConflict(conflict,'remote')">采用远端</button><button mat-flat-button color="primary" (click)="resolveConflict(conflict,'local')">保留本地</button></div>
                  </div>
                }
              </section>
            }
            <section class="card draft-card">
              <h2>本地草稿</h2>
              @if (sync.drafts.length === 0) { <p class="empty">暂无草稿</p> }
              @for (draft of sync.drafts; track draft.id) {
                <div class="draft" [class]="draft.status">
                  <div class="draft-head"><b>{{ draftKindLabel(draft.kind) }}</b><small>{{ draft.entityId }} · {{ draft.id }}</small></div>
                  <small class="draft-meta">{{ draft.at }} · {{ draftStatusLabel(draft.status) }}</small>
                  @if (draft.error) { <div class="draft-error">{{ draft.error }}</div> }
                  @if (draft.status === 'failed') { <button mat-stroked-button (click)="retry(draft.id)">重试</button> }
                </div>
              }
            </section>
          }
        </mat-tab>
        <mat-tab label="审计时间线"><section class="card timeline">
          @if (sync$ | async; as sync) {
            @for (record of sync.audit; track record.id) {
              <div><i></i><b>{{ record.event }}</b><p>{{ record.at }}</p></div>
            }
            @if (sync.audit.length === 0) { <p class="empty">暂无审计记录</p> }
          }
        </section></mat-tab>
      </mat-tab-group>
    </main>
  `,
  styles: [`
    h2{margin:0 0 12px;font-size:18px}.comment-list{padding:0}.comment{padding:18px;border-bottom:1px solid #e7ebf1}.comment.invalidated{background:#fffbeb}.comment-head{display:flex;justify-content:space-between}.comment-head small{display:block;color:#7a8798;margin-top:4px}.comment p{color:#475569}.actions{display:flex;gap:10px}.actions button{margin:8px 8px 0 0}.form-card{max-width:780px}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.two mat-form-field,.wide{width:100%}.timeline{padding:8px 18px}.timeline>div{position:relative;padding:14px 10px 14px 28px;border-left:2px solid #cbd5e1}.timeline i{position:absolute;width:9px;height:9px;border-radius:50%;background:#2563eb;left:-5.5px;top:20px}.timeline p{color:#7a8798;margin:5px 0 0}
    .sync-bar{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}.sync-bar mat-chip.online{background:#14532d;color:#bbf7d0}.sync-bar mat-chip.offline{background:#7c2d12;color:#fed7aa}.sync-time,.sync-count{color:#667085;font-size:13px}.spacer{flex:1}
    .offline-banner{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:10px 14px;border-radius:6px;margin-bottom:14px;font-size:14px}.error-banner{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 14px;border-radius:6px;margin-bottom:14px;font-size:14px}.error-banner a{color:#2563eb;cursor:pointer;text-decoration:underline}
    .invalidated-badge{background:#fef3c7;color:#92400e;padding:6px 10px;border-radius:4px;font-size:13px;margin:6px 0}
    .conflict-card{margin-bottom:14px}.conflict{padding:14px;border:1px solid #fecaca;border-radius:6px;margin-bottom:10px;background:#fef2f2}.conflict-head{display:flex;justify-content:space-between}.conflict-head small{color:#7a8798}.conflict-values{display:flex;gap:16px;margin:8px 0;font-size:14px}.conflict-values .local{color:#1d4ed8}.conflict-values .remote{color:#b91c1c}
    .draft-card .draft{padding:12px;border:1px solid #e1e7ef;border-radius:6px;margin-bottom:8px}.draft.pending{border-left:3px solid #2563eb}.draft.conflict{border-left:3px solid #dc2626}.draft.failed{border-left:3px solid #d97706}.draft.applied{border-left:3px solid #16a34a}.draft-head{display:flex;justify-content:space-between}.draft-meta{color:#7a8798;font-size:12px}.draft-error{color:#b91c1c;font-size:13px;margin-top:4px}.empty{color:#94a3b8}
    @media(max-width:620px){.two{grid-template-columns:1fr}}
  `],
})
export class ApprovalComponent {
  private readonly store = inject(Store<{ routes: RouteState; sync: SyncState }>)
  readonly state$ = this.store.select('routes')
  readonly sync$ = this.store.select('sync')
  role = '安全'
  segmentId = 'S-203'
  content = ''
  segments: RouteState['routes'][number]['segments'] = []
  constructor() { this.state$.subscribe((state) => { this.segments = state.routes.flatMap((route: RoutePackage) => route.segments) }) }
  addComment() { this.store.dispatch(RouteActions.addComment({ comment: { id: `RV-${Date.now().toString().slice(-4)}`, segmentId: this.segmentId, role: this.role, author: '当前审阅人', content: this.content, status: '待确认' } })); this.content = '' }
  resolve(id: string, status: CommentStatus) { this.store.dispatch(RouteActions.resolveComment({ id, status })) }
  lockBaseline() { this.store.dispatch(RouteActions.lockBaseline()) }
  syncNow() { this.store.dispatch(SyncActions.syncNow()) }
  simulateFail() { this.store.dispatch(SyncActions.requestSimulateFail()) }
  retry(draftId: string) { this.store.dispatch(SyncActions.retryDraft({ draftId })) }
  retryAll() { this.store.dispatch(SyncActions.syncNow()) }
  resolveConflict(conflict: ConflictItem, choice: 'local' | 'remote') { this.store.dispatch(SyncActions.resolveConflict({ draftId: conflict.draftId, field: conflict.field, choice })) }
  stringify(v: unknown): string { return typeof v === 'object' ? JSON.stringify(v) : String(v) }
  draftKindLabel(kind: Draft['kind']): string {
    return { 'segment-level': '区段等级', 'segment-status': '区段状态', 'comment-add': '新增意见', 'comment-resolve': '意见处理', route: '运输单', baseline: '基线锁定' }[kind]
  }
  draftStatusLabel(status: Draft['status']): string {
    return { pending: '待同步', applied: '已应用', conflict: '冲突', failed: '失败' }[status]
  }
}
