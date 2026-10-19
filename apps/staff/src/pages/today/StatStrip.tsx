import { SimpleGrid, Skeleton, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconCalendarEvent, IconClockHour4, IconInbox } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import type { ScheduleRow } from '../../fhir/appointments';
import { patientName } from '../../fhir/patient';
import { formatTime, relativeFromNow } from '../../utils/format';
import classes from './TodayPage.module.css';
import type { TodayAlerts } from './useTodayAlerts';
import type { QueueState } from './WorkQueues';

interface StatProps {
  readonly icon: ReactNode;
  readonly color: string;
  readonly label: string;
  readonly value: ReactNode;
  readonly detail?: ReactNode;
  readonly loading?: boolean;
  readonly onClick?: () => void;
}

function Stat({ icon, color, label, value, detail, loading, onClick }: StatProps): JSX.Element {
  return (
    <UnstyledButton className={classes.stat} onClick={onClick} disabled={!onClick}>
      <ThemeIcon variant="light" color={color} size={36} radius="md">
        {icon}
      </ThemeIcon>
      <div className={classes.statText}>
        <Text size="xs" c="dimmed" fw={600} tt="uppercase" lts="0.04em">
          {label}
        </Text>
        {loading ? (
          <Skeleton height={22} width={70} mt={4} />
        ) : (
          <Text fz={20} fw={700} lh={1.25} className="tm-num" truncate>
            {value}
          </Text>
        )}
        {detail && !loading && (
          <Text size="xs" c="dimmed" truncate>
            {detail}
          </Text>
        )}
      </div>
    </UnstyledButton>
  );
}

/** Four equal summary cards across the top of Today: the day at a glance, each one a shortcut. */
export function StatStrip({
  rows,
  loading,
  next,
  alerts,
  queues,
  onOpenNext,
  onOpenSchedule,
  onOpenAlerts,
  onOpenQueues,
}: {
  readonly rows: ScheduleRow[];
  readonly loading: boolean;
  readonly next?: ScheduleRow;
  readonly alerts: TodayAlerts;
  readonly queues: QueueState[];
  readonly onOpenNext: () => void;
  readonly onOpenSchedule: () => void;
  readonly onOpenAlerts: () => void;
  readonly onOpenQueues: () => void;
}): JSX.Element {
  const active = rows.filter((r) => !['cancelled', 'entered-in-error'].includes(r.appointment.status));
  const remaining = active.filter((r) => ['booked', 'arrived', 'checked-in', 'pending', 'proposed'].includes(r.appointment.status));
  const red = alerts.items.filter((a) => a.severity === 'red').length;
  const liveQueues = queues.filter((q) => q.def.query);
  const workTotal = liveQueues.reduce((sum, q) => sum + (q.count?.total ?? 0), 0);

  return (
    <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="md" mb="lg">
      <Stat
        icon={<IconCalendarEvent size={20} />}
        color="navy"
        label="Visits today"
        loading={loading}
        value={active.length}
        detail={`${remaining.length} remaining · ${active.length - remaining.length} done`}
        onClick={onOpenSchedule}
      />
      <Stat
        icon={<IconClockHour4 size={20} />}
        color="brand"
        label="Next visit"
        loading={loading}
        value={next?.appointment.start ? formatTime(next.appointment.start) : 'None'}
        detail={next ? `${patientName(next.patient)} · ${relativeFromNow(next.appointment.start as string)}` : 'Nothing else booked today'}
        onClick={next ? onOpenNext : undefined}
      />
      <Stat
        icon={<IconAlertTriangle size={20} />}
        color={red > 0 ? 'red' : alerts.items.length > 0 ? 'orange' : 'green'}
        label="Needs attention"
        loading={alerts.loading}
        value={alerts.items.length}
        detail={alerts.items[0]?.title ?? 'All clear'}
        onClick={onOpenAlerts}
      />
      <Stat
        icon={<IconInbox size={20} />}
        color="blue"
        label="My work"
        loading={liveQueues.some((q) => q.loading)}
        value={workTotal}
        detail={liveQueues.map((q) => `${q.count?.total ?? 0} ${q.def.label.replace('My ', '').toLowerCase()}`).join(' · ')}
        onClick={onOpenQueues}
      />
    </SimpleGrid>
  );
}
