import { Injectable, signal } from '@angular/core';
import { ApiService, SessionInfo } from './api.service';

/**
 * Session Management Service
 * Handles session state, status checking, rejoin logic, and periodic refresh
 */
@Injectable({
  providedIn: 'root'
})
export class SessionManagementService {
  // Session signals
  sessionId = signal<string>('');
  sessionInfo = signal<SessionInfo | null>(null);
  canRejoin = signal<boolean>(false);
  interviewStatus = signal<string>('');
  hasValidSession = signal<boolean>(false);
  showEndConfirm = signal<boolean>(false);

  private sessionInfoInterval: any = null;

  constructor(private apiService: ApiService) {}

  /**
   * Initialize session from sessionStorage
   */
  initializeFromStorage(): { sessionId: string; jaasSession: any } | null {
    try {
      const storedSessionId = sessionStorage.getItem('currentSessionId');
      const jaasSessionRaw = sessionStorage.getItem('jaasSession');

      if (storedSessionId) {
        this.sessionId.set(storedSessionId);
      }

      if (jaasSessionRaw) {
        const jaasSession = JSON.parse(jaasSessionRaw);
        console.log('✅ Using existing JaaS session from moderator:', jaasSession);

        if (jaasSession.sessionId) {
          this.sessionId.set(jaasSession.sessionId);
        } else if (storedSessionId) {
          this.sessionId.set(storedSessionId);
        }

        return {
          sessionId: this.sessionId(),
          jaasSession
        };
      }

      console.error('❌ No JaaS session found. Please start from moderator page first.');
      return null;
    } catch (error) {
      console.error('Failed to parse session from sessionStorage:', error);
      return null;
    }
  }

  /**
   * Check session status (DEPRECATED - sessions are auto-created on join)
   * This method now only returns session info from local state
   */
  async checkSessionStatus(): Promise<SessionInfo | null> {
    const sessionId = this.sessionId();
    if (!sessionId) {
      console.warn('No session ID available to check status');
      return null;
    }

    // NOTE: GET /v1/sessions/{id} endpoint has been removed from API
    // Sessions are now auto-created when joining via interview links
    // Return cached session info if available
    const cached = this.sessionInfo();
    if (cached) {
      console.log('Using cached session info (API endpoint deprecated)');
      return cached;
    }

    console.warn('Session status check endpoint deprecated - sessions are auto-created on join');
    return null;
  }

  /**
   * Handle dropped/paused session auto-resume
   */
  async handleDroppedSession(sessionInfo: SessionInfo, onResume: (message: string) => void): Promise<void> {
    if (sessionInfo.status === 'dropped' || sessionInfo.status === 'paused') {
      if (sessionInfo.canRejoin) {
        console.log('🔄 Session was dropped, attempting to resume...');
        try {
          await this.apiService.mintJWT({
            room: this.sessionId(),
            user: { name: 'Participant' },
            sessionId: this.sessionId(),
            rejoin: true
          }).toPromise();
          console.log('✅ Session resumed');
          onResume('[INFO] Rejoined session after network drop\n');
          this.interviewStatus.set('active');
        } catch (err) {
          console.error('Failed to resume session:', err);
        }
      }
    } else if (sessionInfo.status === 'ended') {
      onResume('[INFO] This interview session has ended.\n');
    }
  }

  /**
   * Start periodic session info refresh (DEPRECATED)
   * Session status polling is deprecated - sessions are auto-created on join
   */
  startSessionInfoRefresh(intervalMs: number = 10000): void {
    console.warn('Session info refresh deprecated - sessions are auto-created on join');
    // Clearing any existing interval to prevent errors
    if (this.sessionInfoInterval) {
      clearInterval(this.sessionInfoInterval);
      this.sessionInfoInterval = null;
    }
  }

  /**
   * Stop session info refresh
   */
  stopSessionInfoRefresh(): void {
    if (this.sessionInfoInterval) {
      clearInterval(this.sessionInfoInterval);
      this.sessionInfoInterval = null;
    }
  }

  /**
   * Attempt to rejoin session
   */
  async attemptRejoin(onUpdate: (message: string) => void): Promise<boolean> {
    if (!this.canRejoin()) {
      return false;
    }

    try {
      onUpdate('[INFO] Attempting to rejoin session...\n');
      // Resume logic handled by mintJWT (join) below

      // Check if we have JWT in sessionStorage
      const raw = sessionStorage.getItem('jaasSession');
      if (raw) {
        const res = JSON.parse(raw);

        try {
          const roomId = res.room.split('/').pop() || this.sessionId();
          const sessionInfo = this.sessionInfo();
          let jwtTtlSeconds: number | undefined = undefined;

          if (sessionInfo && sessionInfo.maxInterviewMinutes) {
            const bufferMinutes = 5;
            jwtTtlSeconds = (sessionInfo.maxInterviewMinutes + bufferMinutes) * 60;
          }

          const jwtRes = await this.apiService.mintJWT({
            room: roomId,
            user: { name: 'Candidate' },
            ttlSec: jwtTtlSeconds,
            sessionId: this.sessionId(),
            rejoin: true
          } as any).toPromise();

          if (jwtRes) {
            sessionStorage.setItem('jaasSession', JSON.stringify(jwtRes));
            onUpdate('[SUCCESS] Session rejoined! Reconnecting...\n');
            setTimeout(() => {
              window.location.reload();
            }, 1000);
            return true;
          }
        } catch (jwtErr) {
          console.log('Using existing JWT for rejoin');
          this.hasValidSession.set(true);
          return true;
        }
      } else {
        onUpdate('[ERROR] No session found to rejoin\n');
        return false;
      }

      return true;
    } catch (err: any) {
      console.error('Failed to rejoin session:', err);
      onUpdate(`[ERROR] Failed to rejoin: ${err.message || 'Unknown error'}\n`);
      return false;
    }
  }

  /**
   * Get status border color
   */
  getStatusBorderColor(): string {
    const status = this.interviewStatus();
    if (status === 'active') return '#28a745';
    if (status === 'dropped' || status === 'paused') return '#ffc107';
    if (status === 'ended') return '#dc3545';
    return '#6c757d';
  }

  /**
   * Show end confirmation dialog
   */
  requestEndInterview(): void {
    this.showEndConfirm.set(true);
  }

  /**
   * Cancel end interview
   */
  cancelEndInterview(): void {
    this.showEndConfirm.set(false);
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopSessionInfoRefresh();
  }

  /**
   * Getters for signals (for backward compatibility)
   */
  getSessionId(): string {
    return this.sessionId();
  }

  setHasValidSession(value: boolean): void {
    this.hasValidSession.set(value);
  }
}
