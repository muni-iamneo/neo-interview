import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService, JWTRequest } from '../services/api.service';

@Component({
  selector: 'app-monitor',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './monitor.component.html',
  styleUrls: ['./monitor.component.css'],
})
export class MonitorComponent implements OnInit {
  interviewId = signal<string>('');
  modTok = signal<string>('');
  loading = signal(false);
  error = signal<string | null>(null);
  linkInfo = signal<any>(null);

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private apiService: ApiService
  ) {}

  ngOnInit() {
    // Extract interview ID and moderator token from route
    this.route.params.subscribe((params) => {
      const id = params['interviewId'];
      if (id) {
        this.interviewId.set(id);
      }
    });

    this.route.queryParams.subscribe((params) => {
      const token = params['modTok'];
      if (token) {
        this.modTok.set(token);
      }
    });

    // Validate we have both
    if (!this.interviewId() || !this.modTok()) {
      this.error.set('Invalid monitoring link');
      return;
    }

    // Load link info
    this.loadLinkInfo();
  }

  loadLinkInfo() {
    this.loading.set(true);
    this.error.set(null);

    this.apiService.getLink(this.interviewId()).subscribe({
      next: (link) => {
        this.linkInfo.set(link);
        this.loading.set(false);

      },
      error: (err) => {
        console.error('Error loading link:', err);
        this.error.set('Failed to load interview link');
        this.loading.set(false);
      },
    });
  }

  joinAsMonitor() {
    const interviewId = this.interviewId();
    const modTok = this.modTok();

    if (!interviewId || !modTok) {
      this.error.set('Invalid monitoring credentials');
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    // Generate room name
    const room = `interview-${interviewId.substring(0, 8)}`;

    // Mint JWT with moderator token
    const jwtRequest: JWTRequest = {
      room,
      user: {
        name: 'Moderator',
        role: 'moderator',
      },
      features: {
        transcription: true,
      },
      interviewId,
      modTok
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
            isModerator: true,
          })
        );

        // Navigate to agent view (monitoring interface)
        this.router.navigate(['/agent']);
      },
      error: (err) => {
        console.error('Error minting JWT:', err);
        this.error.set(
          err.error?.error ||
            'Failed to join as moderator. Token may be invalid or expired.'
        );
        this.loading.set(false);
      },
    });
  }

  formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString();
  }

  formatTimestamp(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString();
  }

  getStatusBadgeClass(status: string): string {
    switch (status) {
      case 'pending':
        return 'badge-pending';
      case 'active':
        return 'badge-active';
      case 'ended':
        return 'badge-ended';
      case 'expired':
        return 'badge-expired';
      default:
        return 'badge-default';
    }
  }
}
