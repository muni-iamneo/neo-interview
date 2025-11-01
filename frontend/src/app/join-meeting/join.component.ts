import { Component, OnInit, signal } from '@angular/core';
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
export class JoinComponent implements OnInit {
  sessionId = signal<string>('');
  candidateName = signal<string>('');
  loading = signal(false);
  error = signal<string | null>(null);
  ready = signal(false);

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private apiService: ApiService
  ) {}

  ngOnInit() {
    // Extract session ID from route
    this.route.params.subscribe((params) => {
      const id = params['sessionId'];
      if (id) {
        this.sessionId.set(id);
        // Auto-join immediately without asking for name
        this.autoJoinInterview(id);
      } else {
        this.error.set('Invalid session ID');
      }
    });
  }

  autoJoinInterview(sessionId: string) {
    this.loading.set(true);
    this.error.set(null);

    // Generate room name based on session ID
    const room = `interview-${sessionId.substring(0, 8)}`;

    // Mint JWT with a default user name (Jitsi will let them change it)
    const jwtRequest: JWTRequest = {
      room,
      user: {
        name: 'Candidate',
        role: 'candidate',
      },
      features: {
        transcription: true,
      },
    };

    // Add sessionId to request body
    const requestBody = {
      ...jwtRequest,
      sessionId,
    };

    this.apiService.mintJWT(requestBody as any).subscribe({
      next: (response) => {
        // Store session data in sessionStorage
        sessionStorage.setItem('currentSessionId', sessionId);
        sessionStorage.setItem(
          'jaasSession',
          JSON.stringify({
            domain: response.domain,
            room: response.room,
            jwt: response.jwt,
            sessionId,
          })
        );

        // Navigate to agent view (interview room)
        this.router.navigate(['/agent']);
      },
      error: (err) => {
        console.error('Error minting JWT:', err);
        this.error.set(
          err.error?.error || 'Failed to join interview. Please try again.'
        );
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

    const sessionId = this.sessionId();
    if (!sessionId) {
      this.error.set('Invalid session ID');
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    // Generate a random room name based on session ID
    const room = `interview-${sessionId.substring(0, 8)}`;

    // Mint JWT for candidate
    const jwtRequest: JWTRequest = {
      room,
      user: {
        name,
        role: 'candidate',
      },
      features: {
        transcription: true,
      },
    };

    // Add sessionId to request body
    const requestBody = {
      ...jwtRequest,
      sessionId,
    };

    this.apiService.mintJWT(requestBody as any).subscribe({
      next: (response) => {
        // Store session data in sessionStorage
        sessionStorage.setItem('currentSessionId', sessionId);
        sessionStorage.setItem(
          'jaasSession',
          JSON.stringify({
            domain: response.domain,
            room: response.room,
            jwt: response.jwt,
            sessionId,
          })
        );

        // Navigate to agent view (interview room)
        this.router.navigate(['/agent']);
      },
      error: (err) => {
        console.error('Error minting JWT:', err);
        this.error.set(
          err.error?.error || 'Failed to join interview. Please try again.'
        );
        this.loading.set(false);
      },
    });
  }
}
