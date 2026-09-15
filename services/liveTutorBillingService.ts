import { canUseLiveTutor as checkLiveTutorAllowance, type BillingDecision } from './billingService';

export type LiveTutorBillingResult = BillingDecision;

interface LiveTutorReservationOptions {
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export async function canUseLiveTutor(userId: string, seconds = 60): Promise<LiveTutorBillingResult> {
  return checkLiveTutorAllowance(userId, seconds);
}

export async function consumeLiveTutorSeconds(userId: string, seconds = 60, _options: LiveTutorReservationOptions = {}): Promise<LiveTutorBillingResult> {
  return checkLiveTutorAllowance(userId, seconds);
}

export async function consumeLiveTutorMinutes(userId: string, minutes = 1, options: LiveTutorReservationOptions = {}): Promise<LiveTutorBillingResult> {
  return consumeLiveTutorSeconds(userId, minutes * 60, options);
}
