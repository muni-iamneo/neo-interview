import { Component, signal, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule, TitleCasePipe } from '@angular/common';
import { Router } from '@angular/router';

import { ApiService, JWTRequest, AgentResponse, CreateAgentRequest, SessionInfo } from '../services/api.service';
import { ConfigService } from '../services/config.service';

@Component({
  selector: 'app-moderator',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './moderator.component.html',
  styleUrls: ['./moderator.component.css']
})
export class ModeratorComponent implements OnInit, OnDestroy {
  agentResponses = signal<string>('');
  private statusCheckInterval: any = null;

  // Agent management
  agents = signal<AgentResponse[]>([]);
  selectedAgent = signal<AgentResponse | null>(null);
  showCreateForm = signal<boolean>(false);
  isLoadingAgents = signal<boolean>(false);
  isCreatingAgent = signal<boolean>(false);
  
  // Create agent form
  agentForm = {
    name: '',
    role: '',
    interviewType: 'technical',
    systemPrompt: '',
    firstMessage: '',
    language: 'en'
  };
  
  // Interview types available
  interviewTypes = [
    { value: 'technical', label: 'Technical Interview' },
    { value: 'system_design', label: 'System Design' },
    { value: 'behavioral', label: 'Behavioral Interview' },
    { value: 'managerial', label: 'Managerial/Leadership' },
    { value: 'hr', label: 'HR/Culture Fit' },
    { value: 'product', label: 'Product Interview' },
    { value: 'panel', label: 'Panel Interview' },
    { value: 'case_study', label: 'Case Study' }
  ];
  
  // Interview settings
  interviewSettings = {
    userName: 'Candidate',
    meetingDuration: 30
  };
  
  formError = signal<string>('');
  successMessage = signal<string>('');
  agentToDelete = signal<AgentResponse | null>(null);
  showDeleteConfirm = signal<boolean>(false);
  isDeletingAgent = signal<boolean>(false);
  
  // UI state
  activeTab = signal<'overview' | 'setup' | 'configuration' | 'history'>('overview');
  darkMode = signal<boolean>(false);
  toastMessage = signal<string>('');
  toastType = signal<'success' | 'error' | 'info'>('info');
  currentSessionInfo = signal<any>(null); // Current active session info
  showActiveSessions = signal<boolean>(false); // Toggle for active sessions panel
  
  // Agent session history
  agentSessionHistory = signal<SessionInfo[]>([]);
  isLoadingHistory = signal<boolean>(false);

  constructor(
    private apiService: ApiService,
    private config: ConfigService,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.loadAgents();
    // Check for saved dark mode preference
    const savedDarkMode = localStorage.getItem('darkMode');
    if (savedDarkMode === 'true') {
      this.darkMode.set(true);
      document.body.classList.add('dark-mode');
    }
  }

  ngOnDestroy(): void {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
  }

  loadAgents(): void {
    this.isLoadingAgents.set(true);
    this.apiService.listAgents().subscribe({
      next: (agents) => {
        this.agents.set(agents);
        this.isLoadingAgents.set(false);
        
        if (agents.length > 0 && !this.selectedAgent()) {
          this.selectedAgent.set(agents[0]);
          this.interviewSettings.meetingDuration = agents[0].maxInterviewMinutes || 30;
        }
        
        console.log('✅ Loaded agents:', agents.length);
      },
      error: (err) => {
        console.error('❌ Failed to load agents', err);
        this.isLoadingAgents.set(false);
        this.formError.set('Failed to load agents. Please try again.');
      }
    });
  }

  selectAgent(agent: AgentResponse): void {
    this.selectedAgent.set(agent);
    this.interviewSettings.meetingDuration = agent.maxInterviewMinutes || 30;
    console.log('Selected agent:', agent.name);
    // Load session history when agent is selected

  }
  
  setActiveTab(tab: 'overview' | 'setup' | 'configuration' | 'history'): void {
    this.activeTab.set(tab);
    // Load history when switching to history tab

  }
  
  loadAgentHistory(agentId: string): void {
    // History endpoint deprecated
    this.isLoadingHistory.set(false);
    this.agentSessionHistory.set([]);
  }

  toggleCreateForm(): void {
    this.showCreateForm.update(v => !v);
    this.formError.set('');
    
    if (this.showCreateForm()) {
      this.agentForm = {
        name: '',
        role: '',
        interviewType: 'technical',
        systemPrompt: '',
        firstMessage: '',
        language: 'en'
      };
    }
  }

  createAgent(): void {
    this.formError.set('');
    
    if (!this.agentForm.name || !this.agentForm.role) {
      this.formError.set('Please fill in all required fields');
      return;
    }
    
    this.isCreatingAgent.set(true);
    
    const request: CreateAgentRequest = {
      name: this.agentForm.name,
      role: this.agentForm.role,
      interviewType: this.agentForm.interviewType,
      systemPrompt: this.agentForm.systemPrompt || undefined,
      firstMessage: this.agentForm.firstMessage || undefined,
      language: this.agentForm.language
      // maxInterviewMinutes and jobDescription removed from Agent creation
    };
    
    this.apiService.createAgent(request).subscribe({
      next: (agent) => {
        console.log('✅ Agent created:', agent);
        this.isCreatingAgent.set(false);
        this.showCreateForm.set(false);
        
        this.agents.update(list => [...list, agent]);
        this.selectedAgent.set(agent);
        this.interviewSettings.meetingDuration = agent.maxInterviewMinutes || 30;
        
        this.agentResponses.update(t => t + `[Success] Agent "${agent.name}" created\n`);
      },
      error: (err) => {
        console.error('❌ Failed to create agent', err);
        this.isCreatingAgent.set(false);
        this.formError.set(err.error?.detail || 'Failed to create agent. Please try again.');
      }
    });
  }

  startSession(): void {
    if (!this.selectedAgent()) {
      this.formError.set('Please select or create an agent first');
      return;
    }
    
    const agent = this.selectedAgent()!;
    // Generate UUID for the session ID
    const sessionId = crypto.randomUUID();
    
    // Calculate JWT TTL: interview duration + 5 minutes buffer (all in seconds)
    const interviewDurationMinutes = this.interviewSettings.meetingDuration;
    const bufferMinutes = 5;
    const jwtTtlSeconds = (interviewDurationMinutes + bufferMinutes) * 60;
    
    // Build JWT request directly with agentId and dynamic variables
    const request: JWTRequest = {
      room: sessionId,  // Use sessionId as room ID for consistent rejoin
      user: { name: 'Moderator', role: 'moderator' },
      ttlSec: jwtTtlSeconds,
      sessionId: sessionId,
      agentId: agent.id, // Pass agent ID for ad-hoc session
      dynamic_variables: {
        user_name: this.interviewSettings.userName,
        meeting_duration: this.interviewSettings.meetingDuration.toString(),
        job_description: agent.jobDescription || '',
        role: agent.role
      }
    };

    this.apiService.mintJWT(request).subscribe({
      next: (res) => {
        try {
          // Store JaaS session data with sessionId
          const sessionData = {
            ...res,
            sessionId: sessionId  // Include sessionId in stored data
          };
          sessionStorage.setItem('jaasSession', JSON.stringify(sessionData));
          sessionStorage.setItem('currentSessionId', sessionId); // Also store separately for easy access
          console.log('✅ JaaS session created and saved with sessionId:', sessionId);
        } catch (error) {
          console.error('❌ Failed to save JaaS session', error);
          return;
        }
        
        this.agentResponses.update(t => 
          t + `[Info] Starting interview with agent "${agent.name}"\n` +
          `[Info] Duration: ${this.interviewSettings.meetingDuration} minutes\n`
        );
        
        // Open agent page in new tab
        window.open('/agent', '_blank');
        
        // Monitor voice session status
        this.monitorVoiceSession();
      },
      error: (err) => {
        console.error('❌ Session creation failed', err);
        this.formError.set(err.error?.detail || 'Failed to create session. Please try again.');
        this.agentResponses.set('[Error] Failed to create session\n');
      }
    });
  }

  confirmDelete(agent: AgentResponse, event: Event): void {
    event.stopPropagation(); // Prevent card selection
    this.agentToDelete.set(agent);
    this.showDeleteConfirm.set(true);
    this.formError.set('');
    this.successMessage.set('');
  }

  cancelDelete(): void {
    this.agentToDelete.set(null);
    this.showDeleteConfirm.set(false);
  }

  deleteAgent(): void {
    const agent = this.agentToDelete();
    if (!agent) return;

    this.isDeletingAgent.set(true);
    this.formError.set('');

    this.apiService.deleteAgent(agent.id).subscribe({
      next: () => {
        console.log('✅ Agent deleted:', agent.name);
        this.isDeletingAgent.set(false);
        this.showDeleteConfirm.set(false);
        
        // Remove from list
        this.agents.update(list => list.filter(a => a.id !== agent.id));
        
        // Clear selection if deleted agent was selected
        if (this.selectedAgent()?.id === agent.id) {
          const remaining = this.agents();
          this.selectedAgent.set(remaining.length > 0 ? remaining[0] : null);
        }
        
        this.agentToDelete.set(null);
        this.successMessage.set(`Agent "${agent.name}" deleted successfully`);
        
        // Clear success message after 3 seconds
        setTimeout(() => this.successMessage.set(''), 3000);
      },
      error: (err) => {
        console.error('❌ Failed to delete agent', err);
        this.isDeletingAgent.set(false);
        this.formError.set(err.error?.detail || 'Failed to delete agent. Please try again.');
      }
    });
  }

  getUserInitials(): string {
    // You can replace this with actual user data from your auth service
    return 'M';
  }
  
  toggleDarkMode(): void {
    this.darkMode.update(v => !v);
    localStorage.setItem('darkMode', this.darkMode().toString());
    document.body.classList.toggle('dark-mode');
  }
  
  showToast(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
    this.toastMessage.set(message);
    this.toastType.set(type);
    setTimeout(() => this.toastMessage.set(''), 4000);
  }
  
  // DEPRECATED: Session status monitoring removed
  // Sessions are now auto-created on join and GET /v1/sessions endpoints removed from API
  private monitorVoiceSession(): void {
    console.warn('Session monitoring deprecated - sessions are auto-created on join');
    // Clear any existing interval
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
  }

  formatTime(timestamp: number): string {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString();
  }

  getSessionStatusBorderColor(): string {
    const info = this.currentSessionInfo();
    if (!info) return '#6c757d';
    if (info.status === 'active') return '#28a745';
    if (info.status === 'dropped' || info.status === 'paused') return '#ffc107';
    return '#dc3545';
  }

  async resumeCurrentSession(): Promise<void> {
    const sessionId = sessionStorage.getItem('currentSessionId') || '';
    if (!sessionId) {
      this.showToast('No active session found', 'error');
      return;
    }
    
    const request: JWTRequest = {
      room: sessionId,
      sessionId: sessionId,
      rejoin: true,
      user: { name: 'Moderator', role: 'moderator' }
    };

    // Use mintJWT instead of deprecated resumeSession
    this.apiService.mintJWT(request).subscribe({
      next: (res) => {
        this.showToast('Session resumed successfully', 'success');
        this.monitorVoiceSession();
      },
      error: (err) => {
        this.showToast(`Failed to resume session: ${err.message || 'Unknown error'}`, 'error');
      }
    });
  }

  navigateToStudio(): void {
    this.router.navigate(['/studio']);
  }
}
