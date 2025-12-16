import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService, JWTRequest } from '../services/api.service';

@Component({
  selector: 'app-join',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './join.component.html',
  styleUrls: ['./join.component.css'],
})
export class JoinComponent implements OnInit, OnDestroy {
  interviewId = signal<string>('');
  candidateName = signal<string>('');
  loading = signal(false);
  error = signal<string | null>(null);
  ready = signal(false);
  
  // Join-time restriction UI state
  tooEarly = signal(false);
  scheduledAt = signal<string>('');
  canJoinAt = signal<string>('');
  startsInSeconds = signal<number>(0);
  private countdownInterval: any = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private apiService: ApiService
  ) {}

  ngOnInit() {
    // Extract interview ID from route
    this.route.params.subscribe((params) => {
      const id = params['interviewId'];
      if (id) {
        this.interviewId.set(id);
        // Auto-join immediately without asking for name
        this.autoJoinInterview(id);
      } else {
        this.error.set('Invalid interview ID');
      }
    });
  }

  autoJoinInterview(interviewId: string) {
    this.loading.set(true);
    this.error.set(null);

    // Generate room name based on interview ID
    const room = `interview-${interviewId.substring(0, 8)}`;

    // Mint JWT with a default user name (Jitsi will let them change it)
    const jwtRequest: JWTRequest = {
      room,
      user: {
        name: 'Candidate',
        role: 'participant',
      },
      features: {
        transcription: true,
      },
      interviewId // Use new field
    };
    
    // Pass strictly typed request
    this.apiService.mintJWT(jwtRequest).subscribe({
      next: (response) => {
        // Store session data in sessionStorage
        sessionStorage.setItem('currentSessionId', interviewId);
        sessionStorage.setItem(
          'jaasSession',
          JSON.stringify({
            domain: response.domain,
            room: response.room,
            jwt: response.jwt,
            interviewId,
          })
        );

        // Navigate to agent view (interview room)
        this.router.navigate(['/agent']);
      },
      error: (err) => {
        console.error('Error minting JWT:', err);
        
        // Handle join-time restrictions
        if (err.status === 425) {
          // Too Early - show countdown
          this.handleTooEarlyError(err.error);
        } else if (err.status === 410) {
          // Expired or ended
          this.error.set(
            err.error?.message || 'This interview link has expired or ended.'
          );
        } else {
          this.error.set(
            err.error?.error || 'Failed to join interview. Please try again.'
          );
        }
        
        this.loading.set(false);
      },
    });
  }

  joinInterview() {
    const name = this.candidateName().trim();
    if (!name) {
      this.error.set('Please enter your name');
      return;
    }

    const interviewId = this.interviewId();
    if (!interviewId) {
      this.error.set('Invalid interview ID');
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    // Generate room name based on interview ID
    const room = `interview-${interviewId.substring(0, 8)}`;

    // Mint JWT for candidate
    const jwtRequest: JWTRequest = {
      room,
      user: {
        name,
        role: 'participant',
      },
      features: {
        transcription: true,
      },
      interviewId
    };
    
    this.apiService.mintJWT(jwtRequest).subscribe({
      next: (response) => {
        // Store session data in sessionStorage
        sessionStorage.setItem('currentSessionId', interviewId);
        sessionStorage.setItem(
          'jaasSession',
          JSON.stringify({
            domain: response.domain,
            room: response.room,
            jwt: response.jwt, 
            interviewId,
          })
        );

        // Navigate to agent view (interview room)
        this.router.navigate(['/agent']);
      },
      error: (err) => {
        console.error('Error minting JWT:', err);
        
        // Handle join-time restrictions
        if (err.status === 425) {
          // Too Early - show countdown
          this.handleTooEarlyError(err.error);
        } else if (err.status === 410) {
          // Expired or ended
          this.error.set(
            err.error?.message || 'This interview link has expired or ended.'
          );
        } else {
          this.error.set(
            err.error?.error || 'Failed to join interview. Please try again.'
          );
        }
        
        this.loading.set(false);
      },
    });
  }
  
  // Handle "Too Early" error with countdown
  private handleTooEarlyError(errorData: any) {
    this.tooEarly.set(true);
    this.scheduledAt.set(errorData.scheduled_at || '');
    this.canJoinAt.set(errorData.can_join_at || '');
    this.startsInSeconds.set(errorData.starts_in_seconds || 0);
    
    // Start countdown
    this.startCountdown();
  }
  
  private startCountdown() {
    // Clear any existing interval
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    
    this.countdownInterval = setInterval(() => {
      const remaining = this.startsInSeconds() - 1;
      
      if (remaining <= 0) {
        // Countdown finished - auto-retry join
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
        this.tooEarly.set(false);
        this.autoJoinInterview(this.interviewId());
      } else {
        this.startsInSeconds.set(remaining);
      }
    }, 1000);
  }
  
  formatCountdown(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
  
  formatDateTime(isoString: string): string {
    if (!isoString) return '';
    try {
      return new Date(isoString).toLocaleString();
    } catch {
      return isoString;
    }
  }
  
  ngOnDestroy() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
  }
}
