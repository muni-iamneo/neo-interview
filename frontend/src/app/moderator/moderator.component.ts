import { Component, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-moderator',
  standalone: true,
  imports: [],
  templateUrl: './moderator.component.html',
  styleUrl: './moderator.component.css'
})
export class ModeratorComponent {
  constructor(private http: HttpClient) {}

  transcripts = signal<string>('');
  agentResponses = signal<string>('');
  eventsWs: WebSocket | null = null;

  startSession() {
    this.http
      .post<any>('http://localhost:8000/jaas/jwt', { room: 'testroom', user: { name: 'Moderator' } })
      .subscribe({
        next: (res) => {
          try {
            sessionStorage.setItem('jaasSession', JSON.stringify(res));
          } catch {
            console.error('Failed to save JaaS session');
          }
          
          // Open agent page in new tab
          window.open('/agent', '_blank');
          
          // Connect to voice session status for monitoring
          this.connectToVoiceSessionStatus();
        },
        error: (err) => console.error('Moderator JWT fetch failed', err),
      });
  }

  /**
   * Connect to voice session status to monitor the conversation
   */
  private connectToVoiceSessionStatus() {
    // Check session status periodically
    const checkStatus = () => {
      this.http.get<any>(`http://localhost:8000/voice/sessions/testsession`)
        .subscribe({
          next: (status) => {
            if (status.active) {
              console.log('✅ Voice session active');
              this.agentResponses.update((t) => t + '[System] Voice conversation started\n');
            } else {
              console.log('⏳ Voice session not yet active');
            }
          },
          error: (err) => {
            console.log('Voice session not found yet');
          }
        });
    };

    // Check immediately and then every 5 seconds
    checkStatus();
    setInterval(checkStatus, 5000);
  }
}
