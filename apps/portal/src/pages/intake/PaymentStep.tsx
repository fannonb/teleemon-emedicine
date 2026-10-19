import { Alert, Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCreditCard } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { errorText } from '../../api';
import { Show, useLoader } from '../../components/states';
import { useSession } from '../../session';
import type { StepProps } from '../IntakePage';

interface Card { readonly brand: string; readonly last4: string; readonly expMonth: number; readonly expYear: number; readonly provider: string }
interface PaymentInfo { readonly mode: 'sandbox' | 'stripe'; readonly card?: Card }

// Card on file. Card numbers go from the browser to Stripe only (Stripe's payment element); in the
// local sandbox no card details are collected at all.
export function PaymentStep({ saved }: StepProps): JSX.Element {
  const { api } = useSession();
  const info = useLoader(() => api.get<PaymentInfo>('payment'), [api]);
  return <Show loaded={info}>{(i) => <Payment info={i} reload={info.reload} next={() => saved()} />}</Show>;
}

/** The card on file outside intake (profile page): the same rules, without the step's Continue button. */
export function CardOnFile(): JSX.Element {
  const { api } = useSession();
  const info = useLoader(() => api.get<PaymentInfo>('payment'), [api]);
  return <Show loaded={info}>{(i) => <Payment info={i} reload={info.reload} />}</Show>;
}

function Payment({ info, reload, next }: { readonly info: PaymentInfo; readonly reload: () => void; readonly next?: () => void }): JSX.Element {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [replacing, setReplacing] = useState(!info.card);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setReplacing(false);
      reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <Text size="sm">Your card is charged only for balances after a visit (copays, deductibles or self-pay fees), as described in the financial policy.</Text>
      {info.card && !replacing && (
        <Group justify="space-between">
          <Group gap="xs"><IconCreditCard /><Text fw={600} tt="capitalize">{info.card.brand} ending {info.card.last4}</Text><Text size="sm" c="dimmed" className="tm-num">expires {String(info.card.expMonth).padStart(2, '0')}/{info.card.expYear}</Text></Group>
          {info.card.provider === 'sandbox' && <Badge color="gray">Sandbox test card</Badge>}
        </Group>
      )}
      {replacing && info.mode === 'sandbox' && (
        <Alert color="blue" title="Sandbox payments">
          <Stack gap="xs">
            <Text size="sm">No payment processor is connected in this environment, so no card details are collected. Choose a test outcome.</Text>
            <Group>
              <Button size="sm" loading={busy} onClick={() => void run(() => api.post('payment/confirm', { sandboxOutcome: 'success' }))}>Save test card (Visa 4242)</Button>
              <Button size="sm" variant="default" loading={busy} onClick={() => void run(() => api.post('payment/confirm', { sandboxOutcome: 'decline' }))}>Simulate a decline</Button>
            </Group>
          </Stack>
        </Alert>
      )}
      {replacing && info.mode === 'stripe' && <StripeCard onSaved={() => { setReplacing(false); reload(); }} />}
      {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
      <Group justify="space-between">
        {info.card && !replacing ? (
          <Group gap="xs">
            <Button variant="subtle" onClick={() => setReplacing(true)}>Use a different card</Button>
            <Button variant="subtle" color="red" loading={busy} onClick={() => void run(() => api.post('payment/remove'))}>Remove card</Button>
          </Group>
        ) : <span />}
        {next && <Button disabled={!info.card} onClick={next}>Continue</Button>}
      </Group>
    </Stack>
  );
}

interface StripeJs {
  elements(opts: { clientSecret: string }): { create(type: 'payment'): { mount(el: HTMLElement): void; destroy(): void } };
  confirmSetup(opts: { elements: unknown; redirect: 'if_required' }): Promise<{ error?: { message?: string }; setupIntent?: { id: string } }>;
}
declare global {
  interface Window { Stripe?: (key: string) => StripeJs }
}

/** Stripe.js is loaded only on this step, only in Stripe mode (it is Stripe's PCI requirement). */
async function loadStripe(): Promise<NonNullable<Window['Stripe']>> {
  if (!window.Stripe) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('The payment form could not load. Check your connection.'));
      document.head.appendChild(s);
    });
  }
  return window.Stripe as NonNullable<Window['Stripe']>;
}

function StripeCard({ onSaved }: { readonly onSaved: () => void }): JSX.Element {
  const { api } = useSession();
  const mount = useRef<HTMLDivElement>(null);
  const ctx = useRef<{ stripe: StripeJs; elements: unknown }>(undefined);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let element: { destroy(): void } | undefined;
    (async () => {
      const { publishableKey, clientSecret } = await api.post<{ publishableKey: string; clientSecret: string }>('payment/setup');
      const stripe = (await loadStripe())(publishableKey);
      const elements = stripe.elements({ clientSecret });
      const payment = elements.create('payment');
      if (mount.current) payment.mount(mount.current);
      element = payment;
      ctx.current = { stripe, elements };
      setReady(true);
    })().catch((err: unknown) => setError(errorText(err)));
    return () => element?.destroy();
  }, [api]);

  const save = async (): Promise<void> => {
    if (!ctx.current) return;
    setBusy(true);
    setError(undefined);
    try {
      const { error: stripeError, setupIntent } = await ctx.current.stripe.confirmSetup({ elements: ctx.current.elements, redirect: 'if_required' });
      if (stripeError || !setupIntent) throw new Error(stripeError?.message ?? 'The card was not saved.');
      await api.post('payment/confirm', { setupIntentId: setupIntent.id });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <Badge color="orange" variant="outline">Stripe test mode: use card 4242 4242 4242 4242</Badge>
      <div ref={mount} />
      {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
      <Group justify="flex-end"><Button disabled={!ready} loading={busy} onClick={() => void save()}>Save card</Button></Group>
    </Stack>
  );
}
