import { Component, OnInit, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  ApiService,
  AgentResponse,
  LinkInfo,
  CreateLinkRequest,
  CreateLinkResponse,
  SessionInfo,
  ConversationInfo,
  ConversationDetails,
  AnalysisResult,
} from '../services/api.service';
import { ToastService } from '../services/toast.service';
import { ToastComponent } from '../components/toast/toast.component';

interface LinkWithAgent extends LinkInfo {
  agentName?: string;
}

@Component({
  selector: 'app-agents-studio',
  standalone: true,
  imports: [CommonModule, FormsModule, ToastComponent],
  templateUrl: './agents-studio.component.html',
  styleUrls: ['./agents-studio.component.css'],
})
export class AgentsStudioComponent implements OnInit, OnDestroy {
  agents = signal<AgentResponse[]>([]);
  selectedAgent = signal<AgentResponse | null>(null);
  agentLinks = signal<LinkWithAgent[]>([]);
  showCreateModal = signal(false);
  showLinkModal = signal(false);
  createdLink = signal<CreateLinkResponse | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);

  // Form fields for create link
  maxMinutes = signal<number | null>(null);
  ttlMinutes = signal<number | null>(null);

  // Tabs state
  activeTab = signal<'links' | 'details' | 'conversations'>('details');
  detailsTab = signal<'overview' | 'configuration' | 'history'>('overview');

  // Session Status and History
  currentSessionInfo = signal<any>(null);
  agentSessionHistory = signal<SessionInfo[]>([]);
  isLoadingHistory = signal<boolean>(false);
  showActiveSessions = signal<boolean>(false);
  private statusCheckInterval: any = null;

  // Agent management
  showCreateAgentForm = signal<boolean>(false);
  isCreatingAgent = signal<boolean>(false);
  agentToDelete = signal<AgentResponse | null>(null);
  showDeleteConfirm = signal<boolean>(false);
  isDeletingAgent = signal<boolean>(false);
  successMessage = signal<string>('');

  // Create agent form
  agentForm = {
    name: '',
    role: '',
    maxInterviewMinutes: 30,
    jobDescription: '',
    interviewType: 'technical',
    systemPrompt: '',
    voiceProvider: 'neo'  // Default to Neo (custom pipeline)
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

  // Voice providers available
  voiceProviders = [
    { value: 'neo', label: 'Neo (Custom Pipeline) - Cost-effective, 900-1500ms latency' },
    { value: 'elevenlabs', label: 'ElevenLabs - Fast response, 200-500ms latency' }
  ];

  // Conversations state
  conversations = signal<ConversationInfo[]>([]);
  selectedConversation = signal<ConversationInfo | null>(null);
  conversationDetails = signal<ConversationDetails | null>(null);
  conversationAnalysis = signal<AnalysisResult | null>(null);
  isLoadingConversations = signal<boolean>(false);
  isLoadingAnalysis = signal<boolean>(false);
  conversationsCursor = signal<string | null>(null);
  hasMoreConversations = signal<boolean>(true);
  conversationActiveTab = signal<'transcript' | 'analysis'>('transcript');
  
  // Pagination state
  currentPage = signal<number>(1);
  pageSize = signal<number>(5);
  cursorHistory = signal<(string | null)[]>([]); // Track cursors for navigation: [null, cursor1, cursor2, ...]
  hasNextPage = signal<boolean>(false);
  hasPrevPage = signal<boolean>(false);
  
  // Available page size options
  pageSizeOptions = [5, 10, 20, 30, 50];

  // Search functionality
  searchQuery = signal<string>('');
  filteredAgents = signal<AgentResponse[]>([]);

  constructor(
    private apiService: ApiService,
    private router: Router,
    private toastService: ToastService
  ) {}

  ngOnInit() {
    this.loadAgents();
  }

  ngOnDestroy(): void {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
  }

  loadAgents() {
    this.loading.set(true);
    this.error.set(null);

    this.apiService.listAgents().subscribe({
      next: (agents) => {
        this.agents.set(agents);
        this.filteredAgents.set(agents);
        this.loading.set(false);

        // Auto-select the first agent if available and none selected
        if (agents.length > 0 && !this.selectedAgent()) {
          this.selectAgent(agents[0]);
        }
      },
      error: (err) => {
        console.error('Error loading agents:', err);
        this.error.set('Failed to load agents');
        this.loading.set(false);
      },
    });
  }

  filterAgents(query: string) {
    this.searchQuery.set(query);
    const lowerQuery = query.toLowerCase().trim();

    if (!lowerQuery) {
      this.filteredAgents.set(this.agents());
      return;
    }

    const filtered = this.agents().filter(agent =>
      agent.name.toLowerCase().includes(lowerQuery) ||
      agent.role.toLowerCase().includes(lowerQuery) ||
      agent.interviewType.toLowerCase().replace('_', ' ').includes(lowerQuery)
    );

    this.filteredAgents.set(filtered);
  }

  selectAgent(agent: AgentResponse) {
    this.selectedAgent.set(agent);

    // Lazy load content based on active tab
    if (this.activeTab() === 'links') {
      this.loadAgentLinks(agent.id);
    } else if (this.activeTab() === 'conversations') {
      this.loadConversations(agent.elevenAgentId || agent.id, 1, null);
    }
  }

  loadAgentLinks(agentId: string) {
    this.loading.set(true);

    this.apiService.listAgentLinks(agentId, undefined, 10).subscribe({
      next: (links) => {
        // Add agent name to each link
        const agent = this.agents().find((a) => a.id === agentId);
        const linksWithAgent = links.map((link) => ({
          ...link,
          agentName: agent?.name,
        }));
        this.agentLinks.set(linksWithAgent);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Error loading agent links:', err);
        this.error.set('Failed to load links');
        this.loading.set(false);
      },
    });
  }

  openCreateModal(agent: AgentResponse) {
    this.selectedAgent.set(agent);
    this.maxMinutes.set(agent.maxInterviewMinutes || 30);
    this.ttlMinutes.set(1440); // 24 hours default
    this.showCreateModal.set(true);
  }

  closeCreateModal() {
    this.showCreateModal.set(false);
    this.maxMinutes.set(null);
    this.ttlMinutes.set(null);
  }

  closeLinkModal() {
    this.showLinkModal.set(false);
    this.createdLink.set(null);
  }

  createLink() {
    const agent = this.selectedAgent();
    if (!agent) return;

    this.loading.set(true);
    this.error.set(null);

    const request: CreateLinkRequest = {
      agentId: agent.id,
      maxMinutes: this.maxMinutes() || undefined,
      ttlMinutes: this.ttlMinutes() || undefined,
    };

    this.apiService.createLink(request).subscribe({
      next: (response) => {
        this.createdLink.set(response);
        this.showCreateModal.set(false);
        this.showLinkModal.set(true);
        this.loading.set(false);

        // Reload links for this agent
        this.loadAgentLinks(agent.id);
      },
      error: (err) => {
        console.error('Error creating link:', err);
        this.error.set(err.error?.detail || 'Failed to create link');
        this.loading.set(false);
      },
    });
  }

  deleteLink(sessionId: string) {
    if (!confirm('Are you sure you want to cancel this link?')) {
      return;
    }

    this.loading.set(true);

    this.apiService.deleteLink(sessionId).subscribe({
      next: () => {
        const agent = this.selectedAgent();
        if (agent) {
          this.loadAgentLinks(agent.id);
        }
        this.loading.set(false);
        this.toastService.success('Link cancelled successfully');
      },
      error: (err) => {
        console.error('Error deleting link:', err);
        this.error.set('Failed to delete link');
        this.loading.set(false);
        this.toastService.error('Failed to cancel link');
      },
    });
  }

  copyToClipboard(text: string, type: string) {
    const fullUrl = `${window.location.origin}${text}`;
    navigator.clipboard.writeText(fullUrl).then(
      () => {
        this.toastService.success(`${type} URL copied to clipboard!`);
      },
      (err) => {
        console.error('Failed to copy:', err);
        this.toastService.error('Failed to copy URL');
      }
    );
  }

  formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString();
  }

  formatTimestamp(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString();
  }

  navigateToModeratorView() {
    this.router.navigate(['/moderator']);
  }

  getFullUrl(path: string): string {
    return `${window.location.origin}${path}`;
  }

  joinSession(sessionId: string) {
    // Join as moderator directly
    this.loading.set(true);
    this.error.set(null);

    const room = `interview-${sessionId.substring(0, 8)}`;

    // Mint JWT as moderator
    const jwtRequest = {
      room,
      user: {
        name: 'Moderator',
        role: 'moderator',
      },
      features: {
        transcription: true,
      },
      sessionId,
    };

    this.apiService.mintJWT(jwtRequest as any).subscribe({
      next: (response) => {
        // Store session data
        sessionStorage.setItem('currentSessionId', sessionId);
        sessionStorage.setItem(
          'jaasSession',
          JSON.stringify({
            domain: response.domain,
            room: response.room,
            jwt: response.jwt,
            sessionId,
            isModerator: true,
          })
        );

        // Navigate to agent view (meeting room)
        this.router.navigate(['/agent']);
      },
      error: (err) => {
        console.error('Error joining session:', err);
        this.error.set('Failed to join meeting. Please try again.');
        this.loading.set(false);
      },
    });
  }

  // Tab management
  setDetailsTab(tab: 'overview' | 'configuration' | 'history') {
    this.detailsTab.set(tab);
    if (tab === 'history' && this.selectedAgent()) {
      this.loadAgentHistory(this.selectedAgent()!.id);
    }
  }

  // Load agent session history
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

  // Monitor voice session status
  private monitorVoiceSession(): void {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }

    const sessionId = sessionStorage.getItem('currentSessionId') || '';
    if (!sessionId) {
      return;
    }

    const checkStatus = () => {
      this.apiService.getSessionInfo(sessionId).subscribe({
        next: (info) => {
          this.currentSessionInfo.set(info);
        },
        error: () => {
          this.apiService.getVoiceSessionStatus(sessionId).subscribe({
            next: (status) => {
              if (status.active) {
                console.log('✅ Voice session active');
              }
            },
            error: () => {
              this.currentSessionInfo.set(null);
            }
          });
        }
      });
    };

    checkStatus();
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
      this.toastService.warning('No active session found');
      return;
    }
    try {
      await this.apiService.resumeSession(sessionId).toPromise();
      this.toastService.success('Session resumed successfully');
      this.monitorVoiceSession();
    } catch (err: any) {
      this.toastService.error(`Failed to resume session: ${err.message || 'Unknown error'}`);
    }
  }

  // Agent Management Methods
  toggleCreateAgentForm(): void {
    this.showCreateAgentForm.update(v => !v);
    this.error.set(null);

    if (this.showCreateAgentForm()) {
      this.agentForm = {
        name: '',
        role: '',
        maxInterviewMinutes: 30,
        jobDescription: '',
        interviewType: 'technical',
        systemPrompt: '',
        voiceProvider: 'neo'  // Reset to default
      };
    }
  }

  createAgent(): void {
    this.error.set(null);

    if (!this.agentForm.name || !this.agentForm.role || !this.agentForm.jobDescription) {
      this.error.set('Please fill in all required fields');
      return;
    }

    if (this.agentForm.maxInterviewMinutes < 5 || this.agentForm.maxInterviewMinutes > 180) {
      this.error.set('Interview duration must be between 5 and 180 minutes');
      return;
    }

    this.isCreatingAgent.set(true);

    const request = {
      name: this.agentForm.name,
      role: this.agentForm.role,
      maxInterviewMinutes: this.agentForm.maxInterviewMinutes,
      jobDescription: this.agentForm.jobDescription,
      interviewType: this.agentForm.interviewType,
      systemPrompt: this.agentForm.systemPrompt || undefined,
      voiceProvider: this.agentForm.voiceProvider
    };

    this.apiService.createAgent(request).subscribe({
      next: (agent) => {
        console.log('✅ Agent created:', agent);
        this.isCreatingAgent.set(false);
        this.showCreateAgentForm.set(false);

        this.agents.update(list => [...list, agent]);
        this.selectedAgent.set(agent);

        this.successMessage.set(`Agent "${agent.name}" created successfully`);
        setTimeout(() => this.successMessage.set(''), 3000);
      },
      error: (err) => {
        console.error('❌ Failed to create agent', err);
        this.isCreatingAgent.set(false);
        this.error.set(err.error?.detail || 'Failed to create agent. Please try again.');
      }
    });
  }

  confirmDelete(agent: AgentResponse, event: Event): void {
    event.stopPropagation();
    this.agentToDelete.set(agent);
    this.showDeleteConfirm.set(true);
    this.error.set(null);
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
    this.error.set(null);

    this.apiService.deleteAgent(agent.id).subscribe({
      next: () => {
        console.log('✅ Agent deleted:', agent.name);
        this.isDeletingAgent.set(false);
        this.showDeleteConfirm.set(false);

        this.agents.update(list => list.filter(a => a.id !== agent.id));

        if (this.selectedAgent()?.id === agent.id) {
          const remaining = this.agents();
          this.selectedAgent.set(remaining.length > 0 ? remaining[0] : null);
        }

        this.agentToDelete.set(null);
        this.successMessage.set(`Agent "${agent.name}" deleted successfully`);

        setTimeout(() => this.successMessage.set(''), 3000);
      },
      error: (err) => {
        console.error('❌ Failed to delete agent', err);
        this.isDeletingAgent.set(false);
        this.error.set(err.error?.detail || 'Failed to delete agent. Please try again.');
      }
    });
  }

  // ==================== Conversations Tab Methods ====================

  setActiveTab(tab: 'links' | 'details' | 'conversations'): void {
    this.activeTab.set(tab);

    const agent = this.selectedAgent();
    if (!agent) return;

    // Lazy load content when switching tabs
    if (tab === 'links') {
      this.loadAgentLinks(agent.id);
    } else if (tab === 'conversations') {
      this.loadConversations(agent.elevenAgentId || agent.id, 1, null);
    }
  }

  loadConversations(agentId: string, page: number = 1, cursor?: string | null): void {
    if (!agentId) {
      console.error('No agent ID provided for loading conversations');
      return;
    }

    this.isLoadingConversations.set(true);
    this.error.set(null);
    
    // Clear conversations immediately when loading starts
    if (page === 1 && cursor === null) {
      this.conversations.set([]);
      this.currentPage.set(1);
      this.cursorHistory.set([null]); // Initialize with null for page 1
    }

    this.apiService.listAgentConversations(agentId, cursor || undefined, this.pageSize()).subscribe({
      next: (response) => {
        // Ensure we only show the conversations returned (respecting page size)
        const conversationsToShow = response.conversations.slice(0, this.pageSize());
        this.conversations.set(conversationsToShow);
        this.conversationsCursor.set(response.next_cursor);
        this.hasNextPage.set(!!response.next_cursor);
        
        // Update current page and pagination state
        const newPage = page;
        this.currentPage.set(newPage);
        this.hasPrevPage.set(newPage > 1);
        
        // Update cursor history
        // history[i] represents the cursor needed to load page i+1
        // history[0] = null (for page 1)
        // history[1] = cursor1 (to get page 2)
        // history[2] = cursor2 (to get page 3), etc.
        const history = this.cursorHistory();
        if (newPage === history.length) {
          // We loaded a new page - store the next cursor for future navigation
          // Only add if we have a next cursor (more pages available)
          if (response.next_cursor) {
            this.cursorHistory.set([...history, response.next_cursor]);
          }
        }
        
        this.isLoadingConversations.set(false);
      },
      error: (err) => {
        console.error('Error loading conversations:', err);
        this.error.set(err.error?.detail || 'Failed to load conversations');
        this.isLoadingConversations.set(false);
      }
    });
  }

  nextPage(): void {
    const agent = this.selectedAgent();
    if (!agent) return;

    const currentCursor = this.conversationsCursor();
    if (!currentCursor) return;

    const nextPageNum = this.currentPage() + 1;
    
    // Load next page using current cursor
    this.loadConversations(agent.elevenAgentId || agent.id, nextPageNum, currentCursor);
  }

  prevPage(): void {
    const agent = this.selectedAgent();
    if (!agent) return;

    const currentPageNum = this.currentPage();
    if (currentPageNum <= 1) return;

    const history = this.cursorHistory();
    const prevPageNum = currentPageNum - 1;
    
    // history[prevPageNum - 1] is the cursor needed to load prevPageNum
    // For page 2, prevPageNum = 1, so use history[0] = null
    // For page 3, prevPageNum = 2, so use history[1] (cursor for page 2)
    const prevCursor = history[prevPageNum - 1];
    
    // Trim history to remove future cursors when going back
    if (history.length > prevPageNum) {
      this.cursorHistory.set(history.slice(0, prevPageNum));
    }
    
    // Load previous page
    this.loadConversations(agent.elevenAgentId || agent.id, prevPageNum, prevCursor);
  }

  goToPage(page: number): void {
    const agent = this.selectedAgent();
    if (!agent) return;

    if (page === 1) {
      this.loadConversations(agent.elevenAgentId || agent.id, 1, null);
    } else if (page === this.currentPage() + 1) {
      // Next page
      this.nextPage();
    } else {
      // For other pages, reload from start and navigate forward
      // This is a limitation of cursor-based pagination
      this.loadConversations(agent.elevenAgentId || agent.id, 1, null);
    }
  }

  onPageSizeChange(newSize: number): void {
    const agent = this.selectedAgent();
    if (!agent) return;

    // Clear conversations immediately
    this.conversations.set([]);
    
    // Update page size and reset to first page
    this.pageSize.set(newSize);
    this.currentPage.set(1);
    this.cursorHistory.set([null]);
    
    // Reload conversations with new page size
    this.loadConversations(agent.elevenAgentId || agent.id, 1, null);
  }

  selectConversation(conversation: ConversationInfo): void {
    this.selectedConversation.set(conversation);
    this.conversationDetails.set(null);
    this.conversationAnalysis.set(null);

    // Load conversation details
    this.apiService.getConversationDetails(conversation.conversation_id).subscribe({
      next: (details) => {
        this.conversationDetails.set(details);

        // Try to load existing analysis
        this.apiService.getAnalysis(conversation.conversation_id).subscribe({
          next: (analysis) => {
            this.conversationAnalysis.set(analysis);
          },
          error: (err) => {
            // Analysis doesn't exist yet, which is fine
            if (err.status !== 404) {
              console.error('Error loading analysis:', err);
            }
          }
        });
      },
      error: (err) => {
        console.error('Error loading conversation details:', err);
        this.error.set(err.error?.detail || 'Failed to load conversation details');
      }
    });
  }

  closeConversationModal(): void {
    this.selectedConversation.set(null);
    this.conversationDetails.set(null);
    this.conversationAnalysis.set(null);
    this.conversationActiveTab.set('transcript');
  }

  copyAnalysis(): void {
    const analysis = this.conversationAnalysis();
    if (!analysis) return;

    const textToCopy = `
INTERVIEW ANALYSIS REPORT
========================

Conversation ID: ${analysis.conversation_id}
Generated: ${this.formatDateTime(analysis.generated_at)}

RECOMMENDATION: ${analysis.analysis.hiring_recommendation.toUpperCase()}

SUBJECT KNOWLEDGE:
${Object.entries(analysis.analysis.subject_knowledge)
  .map(([subject, level]) => `  • ${subject}: ${level}`)
  .join('\n')}

REASONING:
${analysis.analysis.reasoning}

STRENGTHS:
${analysis.analysis.strengths.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}

${analysis.analysis.concerns.length > 0 ? `CONCERNS:\n${analysis.analysis.concerns.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}` : 'CONCERNS: None identified'}
    `.trim();

    navigator.clipboard.writeText(textToCopy).then(() => {
      this.successMessage.set('Analysis copied to clipboard!');
      setTimeout(() => this.successMessage.set(''), 3000);
    }).catch(err => {
      console.error('Failed to copy:', err);
      this.error.set('Failed to copy to clipboard');
    });
  }

  generateAnalysis(conversationId: string, forceRegenerate: boolean = false): void {
    this.isLoadingAnalysis.set(true);
    this.error.set(null);

    this.apiService.generateAnalysis(conversationId, forceRegenerate).subscribe({
      next: (analysis) => {
        this.conversationAnalysis.set(analysis);
        this.isLoadingAnalysis.set(false);

        this.successMessage.set('Analysis generated successfully');
        setTimeout(() => this.successMessage.set(''), 3000);
      },
      error: (err) => {
        console.error('Error generating analysis:', err);
        this.error.set(err.error?.detail || 'Failed to generate analysis');
        this.isLoadingAnalysis.set(false);
      }
    });
  }

  formatDuration(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  formatDateTime(dateStr: string): string {
    if (!dateStr) return 'N/A';

    const date = new Date(dateStr);

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return 'N/A';
    }

    // Use relative time for recent conversations
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;

    // For older conversations, show formatted date
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  getFullDateTime(dateStr: string): string {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return 'N/A';

    return date.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  getObjectKeys(obj: any): string[] {
    return Object.keys(obj || {});
  }

  getRecommendationBadgeClass(recommendation: string): string {
    switch (recommendation) {
      case 'hire':
        return 'badge-hire';
      case 'no-hire':
        return 'badge-no-hire';
      case 'consider':
        return 'badge-consider';
      default:
        return '';
    }
  }

  getKnowledgeChipClass(level: string): string {
    switch (level) {
      case 'expert':
        return 'chip-expert';
      case 'intermediate':
        return 'chip-intermediate';
      case 'beginner':
        return 'chip-beginner';
      default:
        return '';
    }
  }

  getBadgeClass(level: string): string {
    switch (level.toLowerCase()) {
      case 'expert':
        return 'badge-expert';
      case 'intermediate':
        return 'badge-intermediate';
      case 'beginner':
        return 'badge-beginner';
      default:
        return '';
    }
  }

  getStatusBadgeClass(status: string): string {
    switch (status?.toLowerCase()) {
      case 'done':
      case 'completed':
        return 'badge-active';
      case 'in_progress':
      case 'active':
        return 'badge-pending';
      case 'failed':
      case 'error':
        return 'badge-expired';
      default:
        return 'badge-default';
    }
  }

  copyConversationId(conversationId: string): void {
    navigator.clipboard.writeText(conversationId).then(() => {
      this.successMessage.set('Conversation ID copied to clipboard!');
      setTimeout(() => this.successMessage.set(''), 2000);
    }).catch(err => {
      console.error('Failed to copy:', err);
      this.error.set('Failed to copy to clipboard');
    });
  }
}
