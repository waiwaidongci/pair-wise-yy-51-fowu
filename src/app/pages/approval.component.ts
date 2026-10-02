import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { Store } from '@ngrx/store'
import { MatButtonModule } from '@angular/material/button'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatTabsModule } from '@angular/material/tabs'
import { RouteState } from '../store/route.reducer'
import * as RouteActions from '../store/route.actions'
import { fieldLabel, formatFieldValue } from '../store/merge'
import type { AuditEntry, RoutePackage } from '../types'

@Component({
  selector: 'app-approval',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatTabsModule],
  template: `
    <main class="page">
      @if (state$ | async; as state) {
      <div class="page-head"><div><p class="eyebrow">安全 · 运营 · 应急会签</p><h1>逐区段审批与退回</h1><p>意见锚定区段版本，任一侧修改区段后相关意见自动失效并重新确认；断网可继续复核，恢复后按版本合并。</p></div>
        <div class="head-actions">
          <span class="chip" [class.chip-offline]="!state.online">{{ state.online ? '在线' : '离线 · 修改存入本地草稿' }}</span>
          @if (state.pendingChanges.length) { <span class="chip chip-pending">未同步 {{state.pendingChanges.length}} 项</span> }
          @if (state.conflicts.length) { <span class="chip chip-warn">冲突 {{state.conflicts.length}} 项</span> }
          <span class="chip" [class.chip-warn]="state.baseline?.status==='已失效'">{{ state.baseline ? state.baseline.id + ' · ' + state.baseline.status : '基线未锁定' }}</span>
          <button mat-stroked-button [disabled]="state.syncing" (click)="sync()">{{ state.syncing ? '同步中…' : (state.syncError ? '重试同步' : '立即同步') }}</button>
          <button mat-flat-button color="primary" (click)="lockBaseline()">确认并锁定基线</button>
        </div>
      </div>
      @if (!state.online) { <div class="banner banner-offline">当前离线：可继续修改区段与审批意见，全部变更保存在本地草稿，网络恢复后按版本自动合并。</div> }
      @if (state.syncError) { <div class="banner banner-error">⚠ {{state.syncError}} <button mat-button color="warn" (click)="sync()">重试</button></div> }
      <mat-tab-group>
        <mat-tab label="待处理意见"><section class="card comment-list">
          @for (comment of state.comments; track comment.id) {
            <div class="comment" [class.comment-stale]="comment.invalidatedReason"><div class="comment-head"><div><b>{{comment.role}} · {{comment.author}}</b><small>{{comment.segmentId}} · {{comment.id}} · 依据区段 v{{comment.segmentVersion}} · {{comment.updatedAt | date:'MM-dd HH:mm'}}</small></div><span class="status" [class.status-stale]="comment.invalidatedReason">{{comment.invalidatedReason ? '需重新确认' : comment.status}}</span></div>
            @if (comment.invalidatedReason) { <p class="stale-badge">⚠ {{comment.invalidatedReason}}</p> }
            <p>{{comment.content}}</p>
            <div class="actions"><button mat-stroked-button color="warn" (click)="resolve(comment.id,'已退回')">退回补件</button><button mat-flat-button color="primary" (click)="resolve(comment.id,'已接受')">接受条件</button></div></div>
          }
        </section></mat-tab>
        <mat-tab label="区段复核"><section class="card">
          <p class="hint">修改区段会立即使该区段下已接受 / 已退回的意见失效并转为待确认；离线时修改同样生效并记入本地草稿。</p>
          @for (route of state.routes; track route.id) {
            <h3 class="route-title">{{route.id}} · {{route.trainCode}} · {{route.cargo}}</h3>
            @for (segment of route.segments; track segment.id) {
              <div class="seg-row">
                <div class="seg-info"><b>{{segment.id}} · {{segment.name}}</b><small>{{segment.from}} → {{segment.to}} · {{segment.km}} km · {{segment.speed}} · 区段 v{{segment.version}}</small></div>
                <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>风险等级</mat-label><mat-select [ngModel]="segment.level" (ngModelChange)="updateSegment(segment.id,'level',$event)"><mat-option value="高">高</mat-option><mat-option value="中">中</mat-option><mat-option value="低">低</mat-option></mat-select></mat-form-field>
                <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>区段状态</mat-label><mat-select [ngModel]="segment.status" (ngModelChange)="updateSegment(segment.id,'status',$event)"><mat-option value="待复核">待复核</mat-option><mat-option value="已确认">已确认</mat-option><mat-option value="需绕行">需绕行</mat-option></mat-select></mat-form-field>
              </div>
            }
          }
        </section></mat-tab>
        <mat-tab label="发表区段意见"><section class="card form-card">
          <div class="two"><mat-form-field><mat-label>专业角色</mat-label><mat-select [(ngModel)]="role"><mat-option>安全</mat-option><mat-option>运营</mat-option><mat-option>应急</mat-option></mat-select></mat-form-field><mat-form-field><mat-label>区段</mat-label><mat-select [(ngModel)]="segmentId"><mat-option *ngFor="let segment of segments" [value]="segment.id">{{segment.id}} · {{segment.name}}</mat-option></mat-select></mat-form-field></div>
          <mat-form-field class="wide"><mat-label>审批条件与依据</mat-label><textarea matInput rows="5" [(ngModel)]="content" placeholder="明确区段、约束、时限与验收证据"></textarea></mat-form-field>
          <button mat-flat-button color="primary" [disabled]="!content.trim()" (click)="addComment()">提交意见</button>
        </section></mat-tab>
        <mat-tab label="同步与冲突"><section class="card sync-card">
          <div class="sync-meta"><span>服务端版本 v{{state.baseVersion}}</span><span>上次同步：{{ state.lastSyncAt ? (state.lastSyncAt | date:'MM-dd HH:mm:ss') : '尚未同步' }}</span><button mat-stroked-button [disabled]="state.syncing" (click)="sync()">{{ state.syncing ? '同步中…' : '立即同步' }}</button></div>
          <h3>待同步草稿（{{state.pendingChanges.length}}）</h3>
          @if (!state.pendingChanges.length) { <p class="hint">暂无未同步的本地修改。</p> }
          @for (change of state.pendingChanges; track change.id) {
            <div class="draft-row"><span>{{label(change.fieldKey)}} → <b>{{fmt(change.value)}}</b></span><small>{{change.actor}} · {{change.changedAt | date:'MM-dd HH:mm:ss'}}</small></div>
          }
          <h3>字段冲突（{{state.conflicts.length}}）</h3>
          @if (!state.conflicts.length) { <p class="hint">无冲突。仅当同一字段本地与远端都修改且不一致时才会列出。</p> }
          @for (conflict of state.conflicts; track conflict.id) {
            <div class="conflict">
              <b>{{conflict.label}}</b>
              <div class="versus">
                <div class="side"><small>本地 · {{conflict.localChangedAt | date:'MM-dd HH:mm:ss'}}</small><b>{{fmt(conflict.localValue)}}</b><button mat-stroked-button (click)="resolveConflict(conflict.id,'local')">保留本地</button></div>
                <div class="side"><small>远端 · {{conflict.remoteChangedAt | date:'MM-dd HH:mm:ss'}}</small><b>{{fmt(conflict.remoteValue)}}</b><button mat-stroked-button color="primary" (click)="resolveConflict(conflict.id,'remote')">采用远端</button></div>
              </div>
              <small class="hint">已暂按{{conflict.provisional==='local'?'本地':'远端'}}（修改时间较新）合并，裁决后随下次同步生效。</small>
            </div>
          }
        </section></mat-tab>
        <mat-tab label="审计时间线"><section class="card timeline">
          @for (entry of sortedAudit(state.audit); track entry.id) {
            <div><i></i><b>{{entry.at | date:'MM-dd HH:mm'}} · {{entry.text}}</b><p>{{entry.actor}} · {{kindLabel(entry)}}</p></div>
          }
        </section></mat-tab>
      </mat-tab-group>
      }
    </main>
  `,
  styles: [`
    h2{margin:0}.head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.chip{border:1px solid #cbd5e1;border-radius:999px;padding:4px 12px;font-size:12px;color:#475569;background:#fff;white-space:nowrap}.chip-offline{background:#fef3c7;border-color:#f59e0b;color:#92400e}.chip-pending{background:#eff6ff;border-color:#2563eb;color:#1d4ed8}.chip-warn{background:#fef2f2;border-color:#dc2626;color:#b91c1c}
    .banner{border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px}.banner-offline{background:#fffbeb;border:1px solid #f59e0b;color:#92400e}.banner-error{background:#fef2f2;border:1px solid #dc2626;color:#b91c1c}
    .comment-list{padding:0}.comment{padding:18px;border-bottom:1px solid #e7ebf1}.comment-stale{background:#fffbeb}.comment-head{display:flex;justify-content:space-between;gap:10px}.comment-head small{display:block;color:#7a8798;margin-top:4px}.comment p{color:#475569}.status{font-size:12px;color:#15803d;white-space:nowrap}.status-stale{color:#b45309;font-weight:700}.stale-badge{display:inline-block;background:#fef3c7;border:1px solid #f59e0b;color:#92400e;border-radius:6px;padding:4px 10px;font-size:12px;margin:6px 0}
    .actions{display:flex;gap:10px}.actions button{margin:8px 8px 0 0}.form-card{max-width:780px}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.two mat-form-field,.wide{width:100%}
    .hint{color:#7a8798;font-size:12px}.route-title{margin:16px 0 6px;font-size:14px}.seg-row{display:grid;grid-template-columns:minmax(0,1fr) 130px 130px;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid #edf0f5}.seg-info b,.seg-info small{display:block}.seg-info small{color:#7a8798;margin-top:3px}
    .sync-card h3{margin:16px 0 8px;font-size:14px}.sync-meta{display:flex;align-items:center;gap:16px;color:#475569;font-size:13px}.sync-meta button{margin-left:auto}.draft-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px dashed #e1e7ef;font-size:13px}.draft-row small{color:#7a8798;white-space:nowrap}
    .conflict{border:1px solid #fca5a5;background:#fff7f7;border-radius:8px;padding:12px;margin:10px 0}.versus{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}.side{border:1px solid #e1e7ef;border-radius:6px;padding:10px;background:#fff;display:flex;flex-direction:column;gap:6px;align-items:flex-start}.side small{color:#7a8798}
    .timeline{padding:8px 18px}.timeline>div{position:relative;padding:14px 10px 14px 28px;border-left:2px solid #cbd5e1}.timeline i{position:absolute;width:9px;height:9px;border-radius:50%;background:#2563eb;left:-5.5px;top:20px}.timeline p{color:#7a8798;margin:5px 0 0}
    @media(max-width:620px){.two,.versus{grid-template-columns:1fr}.seg-row{grid-template-columns:1fr}}
  `],
})
export class ApprovalComponent {
  private readonly store = inject(Store<{ routes: RouteState }>)
  readonly state$ = this.store.select('routes')
  readonly label = fieldLabel
  readonly fmt = formatFieldValue
  role = '安全'
  segmentId = 'S-203'
  content = ''
  segments: RouteState['routes'][number]['segments'] = []
  constructor() { this.state$.subscribe((state) => { this.segments = state.routes.flatMap((route: RoutePackage) => route.segments) }) }
  addComment() {
    const segment = this.segments.find((item) => item.id === this.segmentId)
    this.store.dispatch(RouteActions.addComment({ comment: { id: `RV-${Date.now().toString().slice(-6)}`, segmentId: this.segmentId, role: this.role, author: '当前审阅人', content: this.content, status: '待确认', segmentVersion: segment?.version ?? 1, updatedAt: new Date().toISOString() } }))
    this.content = ''
  }
  resolve(id: string, status: '已接受' | '已退回') { this.store.dispatch(RouteActions.resolveComment({ id, status })) }
  updateSegment(id: string, field: 'level' | 'status', value: string) { this.store.dispatch(RouteActions.updateSegmentField({ id, field, value })) }
  sync() { this.store.dispatch(RouteActions.syncRequested()) }
  lockBaseline() { this.store.dispatch(RouteActions.lockBaseline()) }
  resolveConflict(id: string, choice: 'local' | 'remote') { this.store.dispatch(RouteActions.resolveConflict({ id, choice })) }
  sortedAudit(audit: AuditEntry[]): AuditEntry[] { return [...audit].sort((a, b) => b.at.localeCompare(a.at)) }
  kindLabel(entry: AuditEntry): string {
    const labels: Record<AuditEntry['kind'], string> = { segment: '区段变更', comment: '审批意见', remote: '远端合并', sync: '同步', conflict: '冲突', invalidation: '意见失效', baseline: '基线' }
    return labels[entry.kind]
  }
}
