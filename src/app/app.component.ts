import { Component, inject } from '@angular/core'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { AsyncPipe } from '@angular/common'
import { Store } from '@ngrx/store'
import { MatToolbarModule } from '@angular/material/toolbar'
import { MatButtonModule } from '@angular/material/button'
import { MatChipsModule } from '@angular/material/chips'
import { MatIconModule } from '@angular/material/icon'
import { RouteState } from './store/route.reducer'
import { SyncState } from './store/sync.reducer'
import * as SyncActions from './store/sync.actions'

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, AsyncPipe, MatToolbarModule, MatButtonModule, MatChipsModule, MatIconModule],
  template: `
    <mat-toolbar class="topbar">
      <div class="brand"><span>铁</span><div><b>危险货物运输审批台</b><small>RAIL HAZMAT CONTROL</small></div></div>
      <nav><a mat-button routerLink="/workspace" routerLinkActive="active">路径编组</a><a mat-button routerLink="/risk-map" routerLinkActive="active">风险地图</a><a mat-button routerLink="/approval" routerLinkActive="active">多角色审批</a></nav>
      <span class="spacer"></span>
      @if (sync$ | async; as sync) {
        <mat-chip [class.online]="sync.online" [class.offline]="!sync.online" (click)="toggleOnline(sync.online)">
          <mat-icon>{{ sync.online ? 'wifi' : 'wifi_off' }}</mat-icon>
          {{ sync.online ? '协同在线' : '离线模式' }}
        </mat-chip>
        @if (sync.drafts.length > 0) { <mat-chip class="draft-chip">{{ sync.drafts.length }} 项草稿待同步</mat-chip> }
        @if (sync.conflicts.length > 0) { <mat-chip class="conflict-chip">{{ sync.conflicts.length }} 项冲突待处理</mat-chip> }
      }
      <button mat-flat-button color="primary">提交审批</button>
    </mat-toolbar>
    <router-outlet />
  `,
  styles: [`
    .topbar{height:68px;background:#0f172a;color:#fff;padding:0 22px;position:sticky;top:0;z-index:700}
    .brand{display:flex;align-items:center;gap:11px;min-width:260px}.brand>span{width:36px;height:36px;border-radius:7px;background:#2563eb;display:grid;place-items:center;font-weight:800}.brand b,.brand small{display:block}.brand small{font-size:9px;color:#94a3b8;letter-spacing:1px;margin-top:2px}
    nav{display:flex;gap:4px}nav a{color:#cbd5e1}nav a.active{background:#1e293b;color:#fff}
    mat-chip.online{background:#14532d;color:#bbf7d0}mat-chip.offline{background:#7c2d12;color:#fed7aa;cursor:pointer}
    .draft-chip{background:#1e3a8a;color:#bfdbfe}.conflict-chip{background:#7f1d1d;color:#fecaca}
    .spacer{flex:1}
    @media(max-width:900px){.topbar{height:auto;min-height:64px;padding:10px;flex-wrap:wrap}.brand{min-width:210px}nav{order:3;width:100%}.brand small,.topbar mat-chip{display:none}}
  `],
})
export class AppComponent {
  private readonly store = inject(Store<{ routes: RouteState; sync: SyncState }>)
  readonly sync$ = this.store.select('sync')
  toggleOnline(online: boolean) { this.store.dispatch(SyncActions.setOnline({ online: !online })) }
}
