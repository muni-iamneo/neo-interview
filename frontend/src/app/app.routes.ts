import { Routes } from '@angular/router';
import { ModeratorComponent } from './moderator/moderator.component';
import { AgentComponent } from './agent/agent.component';
import { AgentsStudioComponent } from './agents-studio/agents-studio.component';
import { JoinComponent } from './join-meeting/join.component';
import { MonitorComponent } from './monitor/monitor.component';

export const routes: Routes = [
  { path: '', redirectTo: 'moderator', pathMatch: 'full' },
  { path: 'moderator', component: ModeratorComponent },
  { path: 'agent', component: AgentComponent },
  { path: 'studio', component: AgentsStudioComponent },
  { path: 'join/:sessionId', component: JoinComponent },
  { path: 'monitor/:sessionId', component: MonitorComponent },
];
