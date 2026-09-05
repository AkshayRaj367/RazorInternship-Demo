/**
 * Audit trail contract — the RazorSense timeline.
 * Shared by: agent-service (writer), ws-gateway (backlog replay), web (renderer).
 * Mirrored in PyMongo by apps/agent-service/services/audit_service.py.
 */

export const AuditStepEnum = {
  INTENT: 'INTENT',
  INVENTORY_LOCK: 'INVENTORY_LOCK',
  GUARDRAIL_PASS: 'GUARDRAIL_PASS',
  GUARDRAIL_OTP_REQUIRED: 'GUARDRAIL_OTP_REQUIRED',
  OTP_VERIFIED: 'OTP_VERIFIED',
  ORDER_GENERATED: 'ORDER_GENERATED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  RECOVERY_INITIATED: 'RECOVERY_INITIATED',
  RECOVERY_LINK_SENT: 'RECOVERY_LINK_SENT',
  ORDER_COMPLETED: 'ORDER_COMPLETED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
} as const;

export type AuditStep = (typeof AuditStepEnum)[keyof typeof AuditStepEnum];

/** Ordered happy path: Intent -> Inventory Lock -> Guardrail Pass -> Order Generated -> ... */
export const HAPPY_PATH_STEPS: AuditStep[] = [
  AuditStepEnum.INTENT,
  AuditStepEnum.INVENTORY_LOCK,
  AuditStepEnum.GUARDRAIL_PASS,
  AuditStepEnum.ORDER_GENERATED,
  AuditStepEnum.ORDER_COMPLETED,
];

/** Branch steps shown distinctly when a payment fails and recovery takes over. */
export const RECOVERY_PATH_STEPS: AuditStep[] = [
  AuditStepEnum.PAYMENT_FAILED,
  AuditStepEnum.RECOVERY_INITIATED,
  AuditStepEnum.RECOVERY_LINK_SENT,
  AuditStepEnum.ORDER_COMPLETED,
];

/** OTP-gate branch (amount above the delegated spending limit). */
export const OTP_PATH_STEPS: AuditStep[] = [
  AuditStepEnum.GUARDRAIL_OTP_REQUIRED,
  AuditStepEnum.OTP_VERIFIED,
];

/** audit_logs document as stored in Mongo (no TTL — the durable trail). */
export interface AuditLogEntry {
  _id: string;
  sessionId: string;
  agentId: string;
  orderId?: string | null;
  step: AuditStep;
  detail: Record<string, unknown>;
  timestamp: string;
}

/** Payload pushed per-event over Socket.IO (event name: `audit:event`). */
export interface AuditEventPayload {
  sessionId: string;
  entry: AuditLogEntry;
}

/** Payload sent once on room (re)join before any live events (event name: `audit:backlog`). */
export interface AuditBacklogPayload {
  sessionId: string;
  events: AuditLogEntry[];
}

/** Payload for the human-in-the-loop OTP gate (event name: `otp:required`). */
export interface OtpRequiredPayload {
  sessionId: string;
  transactionId: string;
  amountPaise: number;
  orderNumber?: string;
  devOtp?: string; // present ONLY when the backend runs with DEV_MODE=true
  /** v2: where the code went — 'email' (human + SMTP), 'inline' (agent), 'dev' (no SMTP, DEV_MODE). */
  delivery?: 'email' | 'inline' | 'dev';
}

/** Payload for the autonomous revenue-recovery agent (event name: `recovery:alt_link`). */
export interface RecoveryLinkPayload {
  sessionId: string;
  orderNumber: string;
  recoverySessionId: string;
  declineReason: string;
  altPaymentLinkId?: string | null;
  altPaymentLinkUrl?: string | null;
  /** False when Razorpay TEST keys are absent (honest degradation, no fabricated links). */
  configured?: boolean;
  /** Why the link could not be generated, when configured is false / creation failed. */
  reason?: string | null;
}
