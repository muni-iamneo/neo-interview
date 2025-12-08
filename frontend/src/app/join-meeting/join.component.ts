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
  interviewId = signal<string>('');
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
        this.error.set(
          err.error?.error || 'Failed to join interview. Please try again.'
        );
        this.loading.set(false);
      },
    });
  }
}
