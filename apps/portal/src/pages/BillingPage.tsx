import { Alert, Button, Card, Group, Modal, SimpleGrid, Stack, Text, TextInput, ThemeIcon, Title } from '@mantine/core';
import type { Invoice } from '@medplum/fhirtypes';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCircleCheck, IconCreditCard, IconPrinter, IconReceipt } from '@tabler/icons-react';
import { formatCents, moneyCents, parseDollars } from '@teleemon/core';
import type { JSX } from 'react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { PortalError, errorText } from '../api';
import { Page } from '../components/Shell';
import { Empty, Show, useLoader } from '../components/states';
import { useMe, useSession } from '../session';

interface BillingView {
  readonly owedCents: number;
  readonly creditCents: number;
  readonly statements: { readonly id: string; readonly date: string; readonly totalCents: number }[];
  readonly recent: { readonly date: string; readonly description: string; readonly cents: number }[];
  readonly card: { readonly brand: string; readonly last4: string } | null;
}

interface PayResult {
  readonly status: 'posted' | 'processing';
  readonly receiptId: string;
  readonly cents: number;
  readonly message: string;
}

/** Whole dollars and cents as typed: 1234 becomes "1234.00". */
const dollarsText = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

/** Calendar days come from the service as YYYY-MM-DD; they are shown without a time zone shift. */
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const signed = (cents: number): string => (cents > 0 ? `+${formatCents(cents)}` : formatCents(cents));

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (value: string): string => value.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] as string);

/**
 * Opens the browser's print dialog on a standalone, print-formatted statement, so a patient can
 * print it or save it as a PDF. Rendered in a fresh window with the practice heading; every value is
 * escaped. Nothing is sent anywhere.
 */
function printStatement(invoice: Invoice, patientName: string): void {
  const rows = (invoice.lineItem ?? [])
    .map((l) => `<tr><td>${escapeHtml(l.chargeItemCodeableConcept?.text ?? 'Account activity')}</td><td class="r">${escapeHtml(signed(moneyCents(l.priceComponent?.[0]?.amount) ?? 0))}</td></tr>`)
    .join('');
  const dated = invoice.date ? new Date(invoice.date).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Statement${dated ? ` \u2014 ${escapeHtml(dated)}` : ''}</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #1a2230; margin: 40px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: #5b6b80; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th, td { text-align: left; padding: 8px 0; border-bottom: 1px solid #e3e8ef; }
  td.r, th.r { text-align: right; white-space: nowrap; }
  tfoot th { border-bottom: none; border-top: 2px solid #1f2d5c; }
  .foot { margin-top: 28px; font-size: 12px; color: #5b6b80; }
</style></head><body>
  <h1>Teleemon Behavioral Health &amp; Wellness</h1>
  <div class="muted">Statement${dated ? ` &middot; ${escapeHtml(dated)}` : ''}</div>
  <div class="muted">Patient: ${escapeHtml(patientName)}</div>
  <table>
    <thead><tr><th>Account activity</th><th class="r">Amount</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="2" class="muted">No line items on this statement.</td></tr>'}</tbody>
    <tfoot><tr><th>Total</th><th class="r">${escapeHtml(formatCents(moneyCents(invoice.totalNet) ?? 0))}</th></tr></tfoot>
  </table>
  <div class="foot">Amounts with a minus sign are payments or credits.<br>Questions? Message us in the patient portal or call the office. In a crisis, call or text 988.</div>
</body></html>`;
  const win = window.open('', '_blank', 'width=760,height=900');
  if (!win) {
    notifications.show({ color: 'orange', message: 'Allow pop-ups to print or save this statement.' });
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}

/** A fresh idempotency key. Works without crypto.randomUUID (plain http on a LAN address). */
function newKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// X08 Billing and payments: what is owed, statements, recent activity, and a payment on the card on file.
export function BillingPage(): JSX.Element {
  const { api } = useSession();
  const me = useMe();
  const billing = useLoader(() => api.get<BillingView>('billing'), [api, me.patientRef]);
  const [receipt, setReceipt] = useState<PayResult>();
  const [openStatement, setOpenStatement] = useState<string>();
  return (
    <Page title="Billing & payments">
      <Show loaded={billing} rows={3}>
        {(b) => (
          <Stack gap="lg">
            <Card>
              <SimpleGrid cols={{ base: 1, sm: b.creditCents > 0 ? 2 : 1 }} spacing="lg">
                <div>
                  <Text size="sm" c="dimmed">You owe</Text>
                  <Text fw={700} fz={32} className="tm-num">{formatCents(b.owedCents)}</Text>
                  <Text size="sm" c="dimmed">{b.owedCents > 0 ? 'Pay below, at the front desk or by phone.' : 'You are all paid up.'}</Text>
                </div>
                {b.creditCents > 0 && (
                  <div>
                    <Text size="sm" c="dimmed">Credit on your account</Text>
                    <Text fw={700} fz={32} className="tm-num">{formatCents(b.creditCents)}</Text>
                    <Text size="sm" c="dimmed">Used for future visits, or refunded.</Text>
                  </div>
                )}
              </SimpleGrid>
            </Card>

            {receipt && (
              <Alert color={receipt.status === 'posted' ? 'brand' : 'blue'} icon={<IconCircleCheck size={18} />} title={receipt.status === 'posted' ? 'Payment received' : 'Payment on its way'}>
                <Stack gap={4}>
                  <Text size="sm">{receipt.message}</Text>
                  <Text size="sm">Receipt <span className="tm-num">{receipt.receiptId}</span></Text>
                </Stack>
              </Alert>
            )}

            {b.owedCents > 0 && (
              // Keyed by the amount owed, so the field and its key reset once a payment changes the balance.
              <PayCard key={b.owedCents} owed={b.owedCents} card={b.card} onPaid={(r) => { setReceipt(r); billing.reload(); }} />
            )}

            <Card>
              <Stack gap="sm">
                <Group gap="xs"><ThemeIcon variant="light"><IconReceipt size={18} /></ThemeIcon><Title order={2}>Statements</Title></Group>
                {b.statements.length === 0 ? (
                  <Empty title="No statements yet" text="You will get one here if you owe a balance after a visit." />
                ) : (
                  b.statements.map((s) => (
                    <Group key={s.id} justify="space-between" wrap="nowrap" py={8} style={{ borderBottom: '1px solid var(--tm-border)' }}>
                      <div>
                        <Text fw={600}>{dayLabel(s.date)}</Text>
                        <Text size="sm" c="dimmed">Statement</Text>
                      </div>
                      <Group gap="sm" wrap="nowrap">
                        <Text className="tm-num">{formatCents(s.totalCents)}</Text>
                        <Button variant="subtle" size="sm" onClick={() => setOpenStatement(s.id)} aria-label={`View statement from ${dayLabel(s.date)}`}>View</Button>
                      </Group>
                    </Group>
                  ))
                )}
              </Stack>
            </Card>

            <Card>
              <Stack gap="sm">
                <Title order={2}>Recent activity</Title>
                {b.recent.length === 0 ? (
                  <Text size="sm" c="dimmed">Charges and payments will show here.</Text>
                ) : (
                  b.recent.map((r, i) => (
                    <Group key={i} justify="space-between" wrap="nowrap" py={8} style={{ borderBottom: '1px solid var(--tm-border)' }}>
                      <div>
                        <Text fw={600}>{r.description}</Text>
                        <Text size="sm" c="dimmed">{dayLabel(r.date)}</Text>
                      </div>
                      <Text className="tm-num" c={r.cents < 0 ? 'green.8' : undefined}>{signed(r.cents)}</Text>
                    </Group>
                  ))
                )}
              </Stack>
            </Card>
          </Stack>
        )}
      </Show>
      {openStatement && <StatementView id={openStatement} onClose={() => setOpenStatement(undefined)} />}
    </Page>
  );
}

function PayCard({ owed, card, onPaid }: { readonly owed: number; readonly card: BillingView['card']; readonly onPaid: (r: PayResult) => void }): JSX.Element {
  const { api } = useSession();
  const [text, setText] = useState(dollarsText(owed));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Set when a payment may or may not have gone through (a server error or a dropped connection):
  // the amount is then locked, and "Try again" repeats the same charge under the same key.
  const [unsure, setUnsure] = useState(false);
  // The key makes a retry safe. It changes when the amount changes or the payment is refused; it is
  // kept after an unsure outcome, so the same charge is retried rather than a second one started.
  const key = useRef(newKey());

  const cents = parseDollars(text);
  const problem = cents === undefined ? 'Enter an amount like 25.00.' : cents <= 0 ? 'Enter an amount greater than $0.00.' : cents > owed ? `You can pay up to ${formatCents(owed)}.` : undefined;

  const pay = async (): Promise<void> => {
    if (cents === undefined || problem) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.post<PayResult>('billing/pay', { cents, key: key.current });
      key.current = newKey();
      setUnsure(false);
      onPaid(result);
    } catch (err) {
      const refused = err instanceof PortalError && err.status < 500;
      if (refused) key.current = newKey();
      setUnsure(!refused);
      setError(refused ? errorText(err) : `We could not confirm this payment. Press Try again to finish it safely, or call us. ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Stack gap="md">
        <Title order={2}>Pay your balance</Title>
        {card ? (
          <Group gap="xs">
            <IconCreditCard size={18} aria-hidden="true" />
            <Text size="sm" tt="capitalize">Paying with {card.brand} ending {card.last4}</Text>
          </Group>
        ) : (
          <Alert color="blue" title="No card on file">
            <Stack gap="xs" align="flex-start">
              <Text size="sm">Add a card to pay online. You can also pay at the front desk or by phone.</Text>
              <Button component={Link} to="/profile" variant="light" size="sm">Add a card</Button>
            </Stack>
          </Alert>
        )}
        <TextInput
          label="Amount to pay"
          description={`Up to ${formatCents(owed)}`}
          leftSection="$"
          inputMode="decimal"
          value={text}
          error={problem}
          disabled={!card || busy || unsure}
          onChange={(e) => {
            setText(e.currentTarget.value);
            key.current = newKey();
          }}
        />
        {error && <Alert color={unsure ? 'orange' : 'red'} icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
        <Group justify="flex-end">
          <Button loading={busy} disabled={!card || (!unsure && !!problem)} onClick={() => void pay()}>
            {unsure ? 'Try again' : cents !== undefined && !problem ? `Pay ${formatCents(cents)}` : 'Pay'}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function StatementView({ id, onClose }: { readonly id: string; readonly onClose: () => void }): JSX.Element {
  const { medplum } = useSession();
  // Patients read their own statements (Invoice) directly, under their compartment policy.
  const invoice = useLoader(() => medplum.readResource('Invoice', id, { cache: 'no-cache' }), [medplum, id]);
  return (
    <Modal opened onClose={onClose} title="Statement" centered>
      <Show loaded={invoice} rows={2}>{(inv) => <StatementLines invoice={inv} />}</Show>
    </Modal>
  );
}

function StatementLines({ invoice }: { readonly invoice: Invoice }): JSX.Element {
  const me = useMe();
  const lines = invoice.lineItem ?? [];
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">Dated {invoice.date ? new Date(invoice.date).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : ''}</Text>
      {lines.length === 0 ? (
        <Text size="sm">No line items on this statement.</Text>
      ) : (
        lines.map((l, i) => (
          <Group key={i} justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm">{l.chargeItemCodeableConcept?.text ?? 'Account activity'}</Text>
            <Text size="sm" className="tm-num" style={{ whiteSpace: 'nowrap' }}>{signed(moneyCents(l.priceComponent?.[0]?.amount) ?? 0)}</Text>
          </Group>
        ))
      )}
      <Group justify="space-between" pt="sm" style={{ borderTop: '1px solid var(--tm-border)' }}>
        <Text fw={650}>Total</Text>
        <Text fw={650} className="tm-num">{formatCents(moneyCents(invoice.totalNet) ?? 0)}</Text>
      </Group>
      <Group justify="flex-end">
        <Button variant="light" size="sm" leftSection={<IconPrinter size={16} />} onClick={() => printStatement(invoice, me.patientName)}>Print / save as PDF</Button>
      </Group>
    </Stack>
  );
}
