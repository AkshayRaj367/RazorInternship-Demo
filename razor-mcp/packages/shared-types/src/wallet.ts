/**
 * Wallet + transaction contract — the delegated spending-limit (UPI reserve simulation).
 * Shared by: agent-service (writer/enforcer), web (WalletBadge / OTPModal display).
 * Mirrored in PyMongo by apps/agent-service (db.py collection access).
 * All money values are integer PAISE. Never floats.
 */

export const INR = 'INR' as const;

export type WalletStatus = 'active' | 'frozen';

/** wallets document. */
export interface Wallet {
  _id: string;
  agentId: string;
  balancePaise: number;
  currency: typeof INR;
  /** Optimistic-concurrency counter — every debit increments it. */
  version: number;
  status: WalletStatus;
  createdAt: string;
  updatedAt: string;
}

export type TransactionType = 'autonomous' | 'otp_gated';

export type TransactionStatus =
  | 'pending'
  | 'awaiting_otp'
  | 'otp_verified'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'expired';

/** transactions document. */
export interface Transaction {
  _id: string;
  idempotencyKey: string;
  agentId: string;
  orderId?: string | null;
  amountPaise: number;
  type: TransactionType;
  status: TransactionStatus;
  /** Wallet version observed before this tx mutated it — audit anchor for OCC. */
  walletVersionBeforeTx: number;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  failureReason?: string | null;
  createdAt: string;
  updatedAt: string;
  /** TTL-managed only while status is pending/awaiting_otp (partial index). */
  expiresAt?: string | null;
}

/** Request body for POST /api/transactions/execute. */
export interface ExecuteTransactionRequest {
  agentId: string;
  sessionId: string;
  items: Array<{ sku: string; qty: number }>;
  idempotencyKey: string;
}

/**
 * Response shape returned VERBATIM on idempotent replays (the stored result is
 * replayed, never re-executed).
 */
export interface ExecuteTransactionResponse {
  status: 'completed' | 'awaiting_otp' | 'failed' | 'rejected' | 'expired' | 'pending';
  transactionId: string;
  idempotencyKey: string;
  amountPaise: number;
  orderNumber?: string | null;
  razorpayOrderId?: string | null;
  walletBalancePaise?: number;
  failureReason?: string | null;
  /** DEV_MODE=true only — see otp_service.py for why this never ships to prod. */
  devOtp?: string;
}

/** Request body for POST /api/transactions/:id/verify-otp. */
export interface VerifyOtpRequest {
  otp: string;
}

export interface VerifyOtpResponse {
  status: TransactionStatus;
  transactionId: string;
  attemptsLeft?: number;
  message?: string;
}
