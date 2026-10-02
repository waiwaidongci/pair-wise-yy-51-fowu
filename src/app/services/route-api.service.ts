import { inject, Injectable } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { map } from 'rxjs'
import type { RoutePackage } from '../types'
import { initMeta, now } from './sync-merge'

@Injectable({ providedIn: 'root' })
export class RouteApiService {
  private readonly http = inject(HttpClient)

  getRoutePackages() {
    return this.http.get<{ items: RoutePackage[] }>('route-data.json').pipe(
      map((response) => {
        const at = now()
        return response.items.map((r) => ({
          ...initMeta(r, 'remote' as const, at),
          segments: r.segments.map((s) => initMeta(s, 'remote' as const, at)),
        }))
      }),
    )
  }
}
