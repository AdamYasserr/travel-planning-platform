/**
 * POST /payments/:id/test-confirm exists only against Stripe TEST mode and outside production.
 * (Env validation additionally refuses any key that does not start with sk_test_.)
 */
export function isTestConfirmEnabled(
  secretKey: string | undefined | null,
  nodeEnv: string | undefined | null,
): boolean {
  return !!secretKey && secretKey.startsWith('sk_test_') && nodeEnv !== 'production';
}

/** Stripe test payment methods used by test-confirm. */
export const TEST_PAYMENT_METHODS = {
  success: 'pm_card_visa',
  decline: 'pm_card_chargeDeclined',
} as const;
