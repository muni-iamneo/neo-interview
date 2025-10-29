import { Component, signal, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule, TitleCasePipe } from '@angular/common';

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
    maxInterviewMinutes: 30,
    jobDescription: '',
    interviewType: 'technical',
    systemPrompt: ''
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
    private config: ConfigService
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
          this.interviewSettings.meetingDuration = agents[0].maxInterviewMinutes;
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
    this.interviewSettings.meetingDuration = agent.maxInterviewMinutes;
    console.log('Selected agent:', agent.name);
    // Load session history when agent is selected
    if (this.activeTab() === 'history') {
      this.loadAgentHistory(agent.id);
    }
  }
  
  setActiveTab(tab: 'overview' | 'setup' | 'configuration' | 'history'): void {
    this.activeTab.set(tab);
    // Load history when switching to history tab
    if (tab === 'history' && this.selectedAgent()) {
      this.loadAgentHistory(this.selectedAgent()!.id);
    }
  }
  
  loadAgentHistory(agentId: string): void {
    this.isLoadingHistory.set(true);
    this.apiService.getAgentSessionHistory(agentId).subscribe({
      next: (response) => {
        this.agentSessionHistory.set(response.sessions);
        this.isLoadingHistory.set(false);
        console.log(`✅ Loaded ${response.totalCount} sessions for agent`);
      },
      error: (err) => {
        console.error('❌ Failed to load agent history', err);
        this.isLoadingHistory.set(false);
        this.agentSessionHistory.set([]);
      }
    });
  }

  toggleCreateForm(): void {
    this.showCreateForm.update(v => !v);
    this.formError.set('');
    
    if (this.showCreateForm()) {
      this.agentForm = {
        name: '',
        role: '',
        maxInterviewMinutes: 30,
        jobDescription: '',
        interviewType: 'technical',
        systemPrompt: ''
      };
    }
  }

  createAgent(): void {
    this.formError.set('');
    
    if (!this.agentForm.name || !this.agentForm.role || !this.agentForm.jobDescription) {
      this.formError.set('Please fill in all required fields');
      return;
    }
    
    if (this.agentForm.maxInterviewMinutes < 5 || this.agentForm.maxInterviewMinutes > 180) {
      this.formError.set('Interview duration must be between 5 and 180 minutes');
      return;
    }
    
    this.isCreatingAgent.set(true);
    
    const request: CreateAgentRequest = {
      name: this.agentForm.name,
      role: this.agentForm.role,
      maxInterviewMinutes: this.agentForm.maxInterviewMinutes,
      jobDescription: this.agentForm.jobDescription,
      interviewType: this.agentForm.interviewType,
      systemPrompt: this.agentForm.systemPrompt || undefined
    };
    
    this.apiService.createAgent(request).subscribe({
      next: (agent) => {
        console.log('✅ Agent created:', agent);
        this.isCreatingAgent.set(false);
        this.showCreateForm.set(false);
        
        this.agents.update(list => [...list, agent]);
        this.selectedAgent.set(agent);
        this.interviewSettings.meetingDuration = agent.maxInterviewMinutes;
        
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
    
    // First, configure the session with the selected agent
    this.apiService.configureSession(sessionId, {
      agentId: agent.id,
      dynamicVariables: {
        user_name: this.interviewSettings.userName,
        meeting_duration: this.interviewSettings.meetingDuration.toString(),
        job_description: agent.jobDescription,
        role: agent.role
      }
    }).subscribe({
      next: (configRes) => {
        console.log('✅ Session configured:', configRes);
        
        // Calculate JWT TTL: interview duration + 5 minutes buffer (all in seconds)
        const interviewDurationMinutes = this.interviewSettings.meetingDuration;
        const bufferMinutes = 5;
        const jwtTtlSeconds = (interviewDurationMinutes + bufferMinutes) * 60;
        
        // Use sessionId as the room ID so rejoining uses the same meeting room
        // Now mint JWT and start the session
        const request: JWTRequest = {
          room: sessionId,  // Use sessionId as room ID for consistent rejoin
          user: { name: 'Moderator' },
          ttlSec: jwtTtlSeconds,  // Set TTL based on interview duration + buffer
          sessionId: sessionId  // Pass sessionId for tracking
        } as any;

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
            console.error('❌ JWT minting failed', err);
            this.agentResponses.set('[Error] Failed to create session\n');
          }
        });
      },
      error: (err) => {
        console.error('❌ Session configuration failed', err);
        this.formError.set(err.error?.detail || 'Failed to configure session. Please try again.');
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
  
  private monitorVoiceSession(): void {
    // Clear any existing interval
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }

    const sessionId = sessionStorage.getItem('currentSessionId') || '';
    if (!sessionId) {
      console.warn('No sessionId found for monitoring');
      return;
    }
    
    const checkStatus = () => {
      // Check detailed session info
      this.apiService.getSessionInfo(sessionId).subscribe({
        next: (info) => {
          this.currentSessionInfo.set(info);
          if (info.status === 'active') {
            console.log('✅ Voice session active');
            this.agentResponses.update((t) => {
              if (!t.includes('[System] Voice conversation started')) {
                return t + '[System] Voice conversation started\n';
              }
              return t;
            });
          }
        },
        error: () => {
          // Session might not exist yet, check basic status
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
              this.currentSessionInfo.set(null);
            }
          });
        }
      });
    };

    // Check immediately
    checkStatus();
    
    // Then check every 5 seconds
    this.statusCheckInterval = setInterval(checkStatus, 5000);
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
    try {
      await this.apiService.resumeSession(sessionId).toPromise();
      this.showToast('Session resumed successfully', 'success');
      // Refresh session info
      this.monitorVoiceSession();
    } catch (err: any) {
      this.showToast(`Failed to resume session: ${err.message || 'Unknown error'}`, 'error');
    }
  }
}
