import { Routes } from '@angular/router';
import { ModeratorComponent } from './moderator/moderator.component';
import { AgentComponent } from './agent/agent.component';

export const routes: Routes = [
  { path: '', redirectTo: 'moderator', pathMatch: 'full' },
  { path: 'moderator', component: ModeratorComponent },
  { path: 'agent', component: AgentComponent },
];
