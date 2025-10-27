import { Component, signal, OnDestroy } from '@angular/core';

import { ApiService, JWTRequest } from '../services/api.service';
import { ConfigService } from '../services/config.service';

@Component({
  selector: 'app-moderator',
  standalone: true,
  imports: [],
  templateUrl: './moderator.component.html'
})
export class ModeratorComponent implements OnDestroy {
  agentResponses = signal<string>('');
  private statusCheckInterval: any = null;

  constructor(
    private apiService: ApiService,
    private config: ConfigService
  ) {}

  ngOnDestroy(): void {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
  }

  startSession(): void {
    const request: JWTRequest = {
      room: 'testroom',
      user: { name: 'Moderator' }
    };

    this.apiService.mintJWT(request).subscribe({
      next: (res) => {
        try {
          sessionStorage.setItem('jaasSession', JSON.stringify(res));
          console.log('✅ JaaS session created and saved');
        } catch (error) {
          console.error('❌ Failed to save JaaS session', error);
          return;
        }
        
        // Open agent page in new tab
        window.open('/agent', '_blank');
        
        // Monitor voice session status
        this.monitorVoiceSession();
      },
      error: (err) => {
        console.error('❌ JWT minting failed', err);
        this.agentResponses.set('[Error] Failed to create session\n');
      }
    });
  }

  private monitorVoiceSession(): void {
    // Clear any existing interval
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }

    const sessionId = this.config.DEFAULT_SESSION_ID;
    
    const checkStatus = () => {
      this.apiService.getVoiceSessionStatus(sessionId).subscribe({
        next: (status) => {
          if (status.active) {
            console.log('✅ Voice session active');
            this.agentResponses.update((t) => 
              t + '[System] Voice conversation started\n'
            );
          }
        },
        error: () => {
          console.log('⏳ Voice session not yet active');
        }
      });
    };

    // Check immediately
    checkStatus();
    
    // Then check every 5 seconds
    this.statusCheckInterval = setInterval(checkStatus, 5000);
  }
}
