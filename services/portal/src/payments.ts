// Card on file (X02). Card numbers never reach Teleemon: in Stripe mode the browser sends them to
// Stripe through Stripe's own element and the service stores only Stripe's customer and payment
// method IDs plus brand and last four digits. Only Stripe TEST keys are accepted in this phase.
// Without keys a sandbox adapter simulates the outcome and collects nothing.

import type { MedplumClient } from '@medplum/core';
import type { Patient } from '@medplum/fhirtypes';
import type { CardOnFile } from '@teleemon/core';
import { EXT, cardOnFile } from '@teleemon/core';
import { createHash } from 'node:crypto';
import { HttpError, badRequest } from './http';
import type { PortalSession } from './session';

export interface SetupResult {
  readonly mode: 'sandbox' | 'stripe';
  readonly publishableKey?: string;
  readonly clientSecret?: string;
}

/** Outcome of one off-session card charge (X08). `chargeId` is the processor's id; it is the ledger's paymentId when posted. */
export interface ChargeResult {
  readonly chargeId: string;
  readonly status: 'succeeded' | 'declined';
  /** Plain-language reason, set when declined. */
  readonly message?: string;
}

export interface PaymentAdapter {
  readonly mode: 'sandbox' | 'stripe';
  setup(patient: Patient): Promise<SetupResult>;
  confirm(patient: Patient, body: { setupIntentId?: string; sandboxOutcome?: string }): Promise<CardOnFile>;
  remove(card: CardOnFile): Promise<void>;
  /** Charges a saved card. The same idempotency key never charges twice. */
  charge(card: CardOnFile, cents: number, idempotencyKey: string): Promise<ChargeResult>;
}

/** Stripe's standard decline test number (4000 0000 0000 0002) ends in these digits. */
const SANDBOX_DECLINE_LAST4 = '0002';

export class SandboxPayments implements PaymentAdapter {
  readonly mode = 'sandbox' as const;
  async setup(): Promise<SetupResult> {
    return { mode: 'sandbox' };
  }
  async confirm(patient: Patient, body: { sandboxOutcome?: string }): Promise<CardOnFile> {
    if (body.sandboxOutcome === 'decline') throw new HttpError(402, 'Your card was declined (sandbox test). Try another card.', 'card-declined');
    if (body.sandboxOutcome !== 'success') throw badRequest('Choose a sandbox test outcome.');
    const id = createHash('sha256').update(`sandbox:${patient.id}`).digest('hex').slice(0, 14);
    return { provider: 'sandbox', customer: `sandbox_cus_${id}`, paymentMethod: `sandbox_pm_${Date.now().toString(36)}`, brand: 'visa', last4: '4242', expMonth: 12, expYear: new Date().getUTCFullYear() + 3, savedAt: new Date().toISOString() };
  }
  async remove(): Promise<void> {}
  /** Deterministic: the same key and amount give the same id. Declines only for a card ending 0002 (no sandbox card does today). */
  async charge(card: CardOnFile, cents: number, idempotencyKey: string): Promise<ChargeResult> {
    const chargeId = `sbx_${createHash('sha256').update(`charge:${idempotencyKey}:${cents}`).digest('hex').slice(0, 24)}`;
    if (card.last4 === SANDBOX_DECLINE_LAST4) return { chargeId, status: 'declined', message: 'Your card was declined (sandbox test). Try another card.' };
    return { chargeId, status: 'succeeded' };
  }
}

const BANK_DECLINED = 'Your bank declined this payment. Try another card in your profile, or call your bank.';
const BANK_APPROVAL = 'Your bank needs to approve this payment. Add a different card in your profile, or call us.';
const PROCESSOR_DOWN = 'The payment could not be completed. Please try again in a few minutes, or call us. You will not be charged twice.';

interface StripeError { readonly type?: string; readonly code?: string; readonly payment_intent?: { readonly id?: string } }
interface StripeIntent { readonly id?: string; readonly status?: string; readonly latest_charge?: string | { readonly id?: string } | null; readonly error?: StripeError }

/** Stripe in test mode: SetupIntent for off-session use; the payment element runs in the browser. */
export class StripeTestPayments implements PaymentAdapter {
  readonly mode = 'stripe' as const;
  constructor(private readonly secretKey: string, private readonly publishableKey: string) {
    if (!secretKey.startsWith('sk_test_') || !publishableKey.startsWith('pk_test_')) throw new Error('Only Stripe test-mode keys (sk_test_/pk_test_) are allowed in this phase.');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<T> {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form ? new URLSearchParams(form) : undefined,
    });
    const json = (await res.json()) as T & { error?: { message?: string } };
    if (!res.ok) throw new HttpError(502, `The payment processor refused the request: ${json.error?.message ?? res.status}`);
    return json;
  }

  async setup(patient: Patient): Promise<SetupResult> {
    // The Stripe customer carries an opaque patient ID only: no name, email or clinical detail.
    const found = await this.call<{ data: { id: string }[] }>('GET', `customers/search?query=${encodeURIComponent(`metadata['teleemon_patient']:'${patient.id}'`)}`);
    const customer = found.data[0]?.id ?? (await this.call<{ id: string }>('POST', 'customers', { 'metadata[teleemon_patient]': patient.id as string })).id;
    const intent = await this.call<{ client_secret: string }>('POST', 'setup_intents', { customer, usage: 'off_session', 'payment_method_types[]': 'card', 'metadata[teleemon_patient]': patient.id as string });
    return { mode: 'stripe', publishableKey: this.publishableKey, clientSecret: intent.client_secret };
  }

  async confirm(patient: Patient, body: { setupIntentId?: string }): Promise<CardOnFile> {
    if (!/^seti_[A-Za-z0-9]+$/.test(body.setupIntentId ?? '')) throw badRequest('The card was not saved. Please try again.');
    type Intent = { status: string; customer: string; metadata?: Record<string, string>; payment_method?: { id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } } };
    const intent = await this.call<Intent>('GET', `setup_intents/${body.setupIntentId}?expand[]=payment_method`);
    if (intent.metadata?.teleemon_patient !== patient.id) throw new HttpError(403, 'This card setup belongs to someone else.');
    if (intent.status !== 'succeeded' || !intent.payment_method?.card) throw new HttpError(402, 'The card was not confirmed. Please try again.', 'card-declined');
    const card = intent.payment_method.card;
    return { provider: 'stripe', customer: intent.customer, paymentMethod: intent.payment_method.id, brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year, savedAt: new Date().toISOString() };
  }

  async remove(card: CardOnFile): Promise<void> {
    if (card.provider === 'stripe') await this.call('POST', `payment_methods/${card.paymentMethod}/detach`).catch(() => undefined);
  }

  /**
   * Off-session PaymentIntent on the saved customer and payment method. Stripe's Idempotency-Key is
   * the portal's key, so a retry after a lost response returns the same intent and charges nothing new.
   */
  async charge(card: CardOnFile, cents: number, idempotencyKey: string): Promise<ChargeResult> {
    let res: Response;
    try {
      res = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey },
        body: new URLSearchParams({ amount: String(cents), currency: 'usd', customer: card.customer, payment_method: card.paymentMethod, off_session: 'true', confirm: 'true' }),
      });
    } catch {
      throw new HttpError(502, PROCESSOR_DOWN);
    }
    const json = (await res.json().catch(() => ({}))) as StripeIntent;
    if (res.ok && json.status === 'succeeded' && json.id) {
      const latest = json.latest_charge;
      return { chargeId: typeof latest === 'string' ? latest : (latest?.id ?? json.id), status: 'succeeded' };
    }
    const error = json.error;
    if (error?.type === 'card_error' || error?.code === 'authentication_required' || (res.ok && json.status)) {
      const message = error?.code === 'authentication_required' ? BANK_APPROVAL : BANK_DECLINED;
      const chargeId = error?.payment_intent?.id ?? json.id ?? `dec_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 20)}`;
      return { chargeId, status: 'declined', message };
    }
    // Anything else (a request problem or an outage) is not a decision about the card: nothing is posted.
    throw new HttpError(502, PROCESSOR_DOWN);
  }
}

export function paymentsFromEnv(): PaymentAdapter {
  const { STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY } = process.env;
  return STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY ? new StripeTestPayments(STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY) : new SandboxPayments();
}

const publicCard = (c: CardOnFile | undefined) => (c ? { brand: c.brand, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, provider: c.provider, savedAt: c.savedAt } : undefined);

export async function currentCard(service: MedplumClient, session: PortalSession): Promise<unknown> {
  const patient = await service.readResource('Patient', session.patient.id as string, { cache: 'no-cache' });
  return { card: publicCard(cardOnFile(patient)) };
}

export async function saveCard(service: MedplumClient, adapter: PaymentAdapter, session: PortalSession, body: { setupIntentId?: string; sandboxOutcome?: string }): Promise<unknown> {
  const card = await adapter.confirm(session.patient, body);
  const patient = await service.readResource('Patient', session.patient.id as string, { cache: 'no-cache' });
  const previous = cardOnFile(patient);
  await service.updateResource<Patient>({
    ...patient,
    extension: [...(patient.extension ?? []).filter((e) => e.url !== EXT.cardOnFile), { url: EXT.cardOnFile, valueString: JSON.stringify(card) }],
  }, { headers: { 'If-Match': `W/"${patient.meta?.versionId}"` } });
  if (previous && previous.paymentMethod !== card.paymentMethod) await adapter.remove(previous);
  return { card: publicCard(card) };
}

export async function removeCard(service: MedplumClient, adapter: PaymentAdapter, session: PortalSession): Promise<unknown> {
  const patient = await service.readResource('Patient', session.patient.id as string, { cache: 'no-cache' });
  const card = cardOnFile(patient);
  if (!card) return { card: undefined };
  await service.updateResource<Patient>({ ...patient, extension: patient.extension?.filter((e) => e.url !== EXT.cardOnFile) }, { headers: { 'If-Match': `W/"${patient.meta?.versionId}"` } });
  await adapter.remove(card);
  return { card: undefined };
}
