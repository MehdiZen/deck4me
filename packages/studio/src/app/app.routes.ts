import { Routes } from '@angular/router'
import { GesturesPage } from './pages/gestures.page'
import { LivePage } from './pages/live.page'
import { SettingsPage } from './pages/settings.page'

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'gestures' },
  { path: 'gestures', component: GesturesPage },
  { path: 'live', component: LivePage },
  { path: 'reglages', component: SettingsPage },
]
