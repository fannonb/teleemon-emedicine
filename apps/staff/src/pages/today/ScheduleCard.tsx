import { Anchor, Badge, Card, Group, SegmentedControl, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconBuilding, IconCalendarOff, IconChevronRight, IconPhone, IconVideo } from '@tabler/icons-react';
import type { Modality } from '@teleemon/core';
import { PRACTICE_TIME_ZONE, US_STATE_TIME_ZONES } from '@teleemon/core';
import type { JSX } from 'react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { CardHeader } from '../../components/CardHeader';
import { EmptyState, ErrorState, RowsSkeleton } from '../../components/states';
import type { ScheduleRow } from '../../fhir/appointments';
import { STATUS_DISPLAY, isOpen } from '../../fhir/appointments';
import { patientName } from '../../fhir/patient';
import type { Loaded } from '../../hooks/useLoader';
import { formatTime, timeZoneAbbrev } from '../../utils/format';
import classes from './TodayPage.module.css';

const MODALITY: Record<Modality, { label: string; icon: JSX.Element }> = {
  video: { label: 'Video', icon: <IconVideo size={14} stroke={1.8} /> },
  phone: { label: 'Phone', icon: <IconPhone size={14} stroke={1.8} /> },
  office: { label: 'Office', icon: <IconBuilding size={14} stroke={1.8} /> },
};

export function ScheduleCard({
  schedule,
  nextId,
  onOpen,
  calendarLink = '/calendar',
}: {
  readonly schedule: Loaded<ScheduleRow[]>;
  readonly nextId?: string;
  readonly onOpen: (row: ScheduleRow) => void;
  readonly calendarLink?: string;
}): JSX.Element {
  const [view, setView] = useState<'upcoming' | 'all'>('all');
  const rows = schedule.data ?? [];
  const live = rows.filter((r) => !['cancelled', 'entered-in-error'].includes(r.appointment.status));
  const upcoming = live.filter((r) => isOpen(r.appointment.status));
  const shown = view === 'all' ? live : upcoming;
  const now = Date.now();
  const firstFuture = shown.findIndex((r) => new Date(r.appointment.start ?? 0).getTime() >= now);

  return (
    <Card padding={0} h="100%">
      <div className={classes.cardPad}>
        <CardHeader
          title="Today's schedule"
          count={schedule.data ? `${live.length} visit${live.length === 1 ? '' : 's'}` : undefined}
          action={
            <Group gap="sm" wrap="nowrap">
              <SegmentedControl
                size="xs"
                value={view}
                onChange={(v) => setView(v as typeof view)}
                data={[
                  { value: 'all', label: `All ${live.length}` },
                  { value: 'upcoming', label: `Upcoming ${upcoming.length}` },
                ]}
                aria-label="Filter schedule"
              />
              <Anchor component={Link} to={calendarLink} size="sm" visibleFrom="sm">
                Calendar
              </Anchor>
            </Group>
          }
        />
      </div>
      {schedule.loading && !schedule.data && (
        <div className={classes.cardPad}>
          <RowsSkeleton rows={6} />
        </div>
      )}
      {schedule.error && (
        <div className={classes.cardPad}>
          <ErrorState error={schedule.error} onRetry={schedule.reload} />
        </div>
      )}
      {schedule.data && shown.length === 0 && (
        <EmptyState icon={<IconCalendarOff size={22} />} title={view === 'upcoming' && live.length > 0 ? 'No more visits today' : 'No visits scheduled today'}>
          {view === 'upcoming' && live.length > 0 ? 'Everything on today’s schedule is complete.' : 'Same-day bookings appear here as soon as they are confirmed.'}
        </EmptyState>
      )}
      {shown.length > 0 && (
        <div role="table" aria-label="Appointments today">
          <div role="row" className={`${classes.scheduleGrid} ${classes.scheduleHead}`}>
            <span role="columnheader">Time</span>
            <span role="columnheader">Patient and visit</span>
            <span role="columnheader" className={classes.hideSm}>
              Where
            </span>
            <span role="columnheader">Status</span>
            <span />
          </div>
          {shown.map((row, i) => (
            <Fragment key={row.appointment.id}>
              {i === firstFuture && i > 0 && (
                <div className={classes.nowLine} role="separator" aria-label="Now">
                  <span>Now · {formatTime(new Date(now).toISOString())}</span>
                </div>
              )}
              <ScheduleItem row={row} isNext={row.appointment.id === nextId} onOpen={onOpen} />
            </Fragment>
          ))}
        </div>
      )}
    </Card>
  );
}

function ScheduleItem({ row, isNext, onOpen }: { readonly row: ScheduleRow; readonly isNext: boolean; readonly onOpen: (row: ScheduleRow) => void }): JSX.Element {
  const { appointment, patient, modality, locationState, licensed, visitType } = row;
  const status = STATUS_DISPLAY[appointment.status];
  const done = !isOpen(appointment.status);
  const patientZone = locationState ? US_STATE_TIME_ZONES[locationState] : undefined;
  const showLocal = !!patientZone && !!appointment.start && timeZoneAbbrev(appointment.start, patientZone) !== timeZoneAbbrev(appointment.start, PRACTICE_TIME_ZONE);

  return (
    <UnstyledButton
      role="row"
      className={`${classes.scheduleGrid} ${classes.scheduleRow} ${done ? classes.scheduleDone : ''} ${isNext ? classes.scheduleNext : ''}`}
      onClick={() => onOpen(row)}
      aria-label={`${formatTime(appointment.start)} ${patientName(patient)}, ${visitType}, ${status.label}`}
    >
      <span role="cell" className={classes.time}>
        <Text fw={650} size="sm" className="tm-num">
          {formatTime(appointment.start)}
        </Text>
        {showLocal && appointment.start && patientZone && (
          <Text size="xs" c="dimmed" className="tm-num">
            {formatTime(appointment.start, patientZone)} {timeZoneAbbrev(appointment.start, patientZone)}
          </Text>
        )}
      </span>
      <span role="cell" className={classes.who}>
        <Group gap={6} wrap="nowrap">
          <Text fw={600} size="sm" truncate>
            {patient ? patientName(patient) : 'Unknown patient'}
          </Text>
          {isNext && (
            <Badge size="xs" color="brand" variant="filled">
              Next
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed" truncate>
          {visitType}
        </Text>
      </span>
      <span role="cell" className={`${classes.where} ${classes.hideSm}`}>
        {modality && (
          <Tooltip label={MODALITY[modality].label}>
            <span className={classes.modality} aria-label={MODALITY[modality].label}>
              {MODALITY[modality].icon}
            </span>
          </Tooltip>
        )}
        {locationState &&
          (licensed ? (
            <Badge color="navy" variant="light" size="sm">
              {locationState}
            </Badge>
          ) : (
            <Tooltip label={`Patient located in ${locationState}, where the provider is not licensed. The visit cannot start until rescheduled.`}>
              <Badge color="red" variant="filled" size="sm" leftSection={<IconAlertTriangle size={11} />}>
                {locationState}
              </Badge>
            </Tooltip>
          ))}
      </span>
      <span role="cell">
        <Badge color={status.color} variant={appointment.status === 'fulfilled' ? 'light' : 'dot'} size="sm">
          {status.label}
        </Badge>
      </span>
      <IconChevronRight size={16} className={classes.rowChevron} aria-hidden />
    </UnstyledButton>
  );
}
