import { Badge, Modal, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconClock, IconInfoCircle, IconPlayerPause } from '@tabler/icons-react';
import type { Claim } from '@medplum/fhirtypes';
import type { ClaimStatus } from '@teleemon/core';
import { claimContentHash, scrubStampOf } from '@teleemon/core';
import type { JSX, ReactNode } from 'react';

export { ConfirmStep } from './AccountDialogs';

/** The server's last scrub of a claim, and whether it still describes the claim as it is. */
export function ScrubBadge({ claim }: { readonly claim: Claim }): JSX.Element {
  const stamp = scrubStampOf(claim);
  if (!stamp) {
    return (
      <Badge color="gray" variant="light" leftSection={<IconInfoCircle size={12} />}>
        Not scrubbed
      </Badge>
    );
  }
  if (stamp.hash !== claimContentHash(claim)) {
    return (
      <Badge color="orange" variant="light" leftSection={<IconAlertTriangle size={12} />}>
        Changed since scrub
      </Badge>
    );
  }
  const errors = stamp.findings.filter((f) => f.severity === 'error').length;
  const warnings = stamp.findings.length - errors;
  if (errors > 0) {
    return (
      <Badge color="red" variant="light" leftSection={<IconCircleX size={12} />}>
        {errors} error{errors === 1 ? '' : 's'}
      </Badge>
    );
  }
  if (warnings > 0) {
    return (
      <Badge color="orange" variant="light" leftSection={<IconAlertTriangle size={12} />}>
        {warnings} warning{warnings === 1 ? '' : 's'}
      </Badge>
    );
  }
  return (
    <Badge color="green" variant="light" leftSection={<IconCircleCheck size={12} />}>
      Clean
    </Badge>
  );
}

const CLAIM_STATUS: Record<ClaimStatus, { label: string; color: string; icon: JSX.Element }> = {
  draft: { label: 'Draft', color: 'gray', icon: <IconInfoCircle size={12} /> },
  scrubbed: { label: 'Scrubbed', color: 'blue', icon: <IconCircleCheck size={12} /> },
  submitted: { label: 'Submitted', color: 'indigo', icon: <IconClock size={12} /> },
  accepted: { label: 'Accepted', color: 'brand', icon: <IconCircleCheck size={12} /> },
  rejected: { label: 'Rejected', color: 'red', icon: <IconCircleX size={12} /> },
  paid: { label: 'Paid', color: 'green', icon: <IconCircleCheck size={12} /> },
  'partially-paid': { label: 'Partially paid', color: 'green', icon: <IconCircleCheck size={12} /> },
  denied: { label: 'Denied', color: 'red', icon: <IconAlertTriangle size={12} /> },
  appealed: { label: 'Appealed', color: 'orange', icon: <IconClock size={12} /> },
  closed: { label: 'Closed', color: 'gray', icon: <IconPlayerPause size={12} /> },
};

/** Work status as text and an icon, never colour alone. */
export function ClaimStatusBadge({ status }: { readonly status: ClaimStatus }): JSX.Element {
  const s = CLAIM_STATUS[status];
  return (
    <Badge variant="light" color={s.color} leftSection={s.icon}>
      {s.label}
    </Badge>
  );
}

/** A modal with the standard close behaviour; closing is blocked while a posting is running. */
export function ModalShell({
  title,
  onClose,
  busy = false,
  size = 'md',
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly busy?: boolean;
  readonly size?: 'md' | 'lg';
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Modal opened onClose={busy ? () => undefined : onClose} title={<Text fw={650}>{title}</Text>} centered size={size} closeOnClickOutside={!busy} closeOnEscape={!busy}>
      {children}
    </Modal>
  );
}

/**
 * A deadline as text and an icon: overdue red, due within a week amber, otherwise grey.
 * `days` is whole days from today (negative once passed).
 */
export function DeadlineBadge({ days, date }: { readonly days: number | undefined; readonly date?: string }): JSX.Element {
  if (days === undefined) return <Text size="sm" c="dimmed">No deadline</Text>;
  const when = date ? <Text span size="xs" c="dimmed" className="tm-num"> {date}</Text> : null;
  if (days < 0) {
    return (
      <Badge color="red" variant="light" leftSection={<IconAlertTriangle size={12} />}>
        Overdue {Math.abs(days)} d
        {when}
      </Badge>
    );
  }
  if (days <= 7) {
    return (
      <Badge color="orange" variant="light" leftSection={<IconClock size={12} />}>
        {days} d left
        {when}
      </Badge>
    );
  }
  return (
    <Badge color="gray" variant="light" leftSection={<IconClock size={12} />}>
      {days} d left
      {when}
    </Badge>
  );
}
