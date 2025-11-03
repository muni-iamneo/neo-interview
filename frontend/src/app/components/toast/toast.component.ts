import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-toast',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="toast-container">
      <div
        *ngFor="let toast of toastService.toasts()"
        class="toast"
        [ngClass]="'toast-' + toast.type"
        [@slideIn]>
        <div class="toast-icon">
          <svg *ngIf="toast.type === 'success'" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <svg *ngIf="toast.type === 'error'" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <svg *ngIf="toast.type === 'warning'" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
          </svg>
          <svg *ngIf="toast.type === 'info'" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
        </div>
        <span class="toast-message">{{ toast.message }}</span>
        <button class="toast-close" (click)="toastService.remove(toast.id)">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
    </div>
  `,
  styles: [`
    .toast-container {
      position: fixed;
      top: var(--space-4);
      right: var(--space-4);
      z-index: 10001;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      pointer-events: none;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-4) var(--space-5);
      background: var(--surface-elevated);
      border-radius: var(--border-radius-lg);
      box-shadow: var(--shadow-xl);
      min-width: 320px;
      max-width: 480px;
      border: 2px solid;
      pointer-events: auto;
      animation: slideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(100%);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .toast-success {
      border-color: var(--success);
      background: var(--success-bg);
    }

    .toast-error {
      border-color: var(--error);
      background: var(--error-bg);
    }

    .toast-warning {
      border-color: var(--warning);
      background: var(--warning-bg);
    }

    .toast-info {
      border-color: var(--primary);
      background: var(--primary-lighter);
    }

    .toast-icon {
      flex-shrink: 0;
      width: 24px;
      height: 24px;
    }

    .toast-success .toast-icon {
      color: var(--success);
    }

    .toast-error .toast-icon {
      color: var(--error);
    }

    .toast-warning .toast-icon {
      color: var(--warning);
    }

    .toast-info .toast-icon {
      color: var(--primary);
    }

    .toast-icon svg {
      width: 100%;
      height: 100%;
    }

    .toast-message {
      flex: 1;
      font-size: var(--font-size-sm);
      font-weight: var(--font-weight-medium);
      color: var(--text-primary);
      line-height: var(--line-height-base);
    }

    .toast-close {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--text-tertiary);
      cursor: pointer;
      transition: all 0.2s;
      border-radius: var(--border-radius-sm);
    }

    .toast-close:hover {
      color: var(--text-primary);
      background: rgba(0, 0, 0, 0.1);
    }

    .toast-close svg {
      width: 100%;
      height: 100%;
    }

    @media (max-width: 640px) {
      .toast-container {
        top: var(--space-3);
        right: var(--space-3);
        left: var(--space-3);
      }

      .toast {
        min-width: auto;
        max-width: none;
      }
    }
  `]
})
export class ToastComponent {
  constructor(public toastService: ToastService) {}
}
