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
   * Check session status
   */
  async checkSessionStatus(): Promise<SessionInfo | null> {
    const sessionId = this.sessionId();
    if (!sessionId) {
      console.warn('No session ID available to check status');
      return null;
    }

    try {
      const info = await this.apiService.getSessionInfo(sessionId).toPromise();
      if (info) {
        this.sessionInfo.set(info);
        this.canRejoin.set(info.canRejoin === true);
        this.interviewStatus.set(info.status || 'unknown');
      }
      return info || null;
    } catch (err) {
      console.warn('Could not fetch session status:', err);
      return null;
    }
  }

  /**
   * Handle dropped/paused session auto-resume
   */
  async handleDroppedSession(sessionInfo: SessionInfo, onResume: (message: string) => void): Promise<void> {
    if (sessionInfo.status === 'dropped' || sessionInfo.status === 'paused') {
      if (sessionInfo.canRejoin) {
        console.log('🔄 Session was dropped, attempting to resume...');
        try {
          await this.apiService.resumeSession(this.sessionId()).toPromise();
          console.log('✅ Session resumed');
          onResume('[INFO] Rejoined session after network drop\n');
          this.interviewStatus.set('active');

          // Refresh session info
          const updatedInfo = await this.checkSessionStatus();
          if (updatedInfo) {
            this.sessionInfo.set(updatedInfo);
          }
        } catch (err) {
          console.error('Failed to resume session:', err);
        }
      }
    } else if (sessionInfo.status === 'ended') {
      onResume('[INFO] This interview session has ended.\n');
    }
  }

  /**
   * Start periodic session info refresh
   */
  startSessionInfoRefresh(intervalMs: number = 10000): void {
    if (this.sessionInfoInterval) {
      clearInterval(this.sessionInfoInterval);
    }

    this.sessionInfoInterval = setInterval(async () => {
      const info = await this.checkSessionStatus();
      if (info) {
        this.sessionInfo.set(info);
        this.canRejoin.set(info.canRejoin === true);
        this.interviewStatus.set(info.status || '');
      }
    }, intervalMs);
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
      await this.apiService.resumeSession(this.sessionId()).toPromise();

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

      // Refresh session info
      const updatedInfo = await this.checkSessionStatus();
      if (updatedInfo) {
        this.sessionInfo.set(updatedInfo);
        this.interviewStatus.set(updatedInfo.status || '');
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
