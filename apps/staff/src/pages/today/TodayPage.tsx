import { Button, Grid, Stack } from '@mantine/core';
import { formatHumanName } from '@medplum/core';
import type { HumanName } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconCalendarPlus, IconSearch } from '@tabler/icons-react';
import { spotlight } from '@mantine/spotlight';
import type { JSX } from 'react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { PageBody, PageHeader } from '../../components/PageHeader';
import type { ScheduleRow } from '../../fhir/appointments';
import { isOpen, loadSchedule } from '../../fhir/appointments';
import { useLoader } from '../../hooks/useLoader';
import { canSee, getPage } from '../../navigation';
import { useRoles } from '../../session/roles';
import { formatLongDate, practiceDayBounds } from '../../utils/format';
import { AlertsCard } from './AlertsCard';
import { ScheduleCard } from './ScheduleCard';
import { StatStrip } from './StatStrip';
import { useTodayAlerts } from './useTodayAlerts';
import { WorkQueueList, useWorkQueues } from './WorkQueues';

// P02 Today: summary strip → schedule (left) → what needs attention and work queues (right).

function greeting(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Los_Angeles' }).format(now));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function scrollTo(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function TodayPage(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const { roles, actualRoles } = useRoles();
  const now = new Date();
  const { start, end } = useMemo(() => practiceDayBounds(), []);
  const schedule = useLoader(() => loadSchedule(medplum, start, end), [medplum, start, end], 60000);
  const mfaEnforced = medplum.getProject()?.setting?.find((s) => s.name === 'mfaRequired')?.valueBoolean === true;
  const alerts = useTodayAlerts(schedule.data, mfaEnforced, actualRoles.includes('admin'));
  const queues = useWorkQueues(roles);

  const firstName = profile?.name?.[0]?.given?.[0] ?? formatHumanName(profile?.name?.[0] as HumanName);
  const rows = schedule.data ?? [];
  const next = rows.find((r) => isOpen(r.appointment.status) && r.appointment.end && new Date(r.appointment.end).getTime() > now.getTime());
  const canBook = canSee(getPage('P04'), roles);
  const calendarBuilt = getPage('P04').built;

  const openRow = (row: ScheduleRow): void => {
    if (calendarBuilt && canBook) navigate(`/calendar?appointment=${row.appointment.id}`);
    else if (row.patient) navigate(`/patients/${row.patient.id}`);
  };

  return (
    <PageBody>
      <PageHeader
        eyebrow={formatLongDate(now)}
        title={`${greeting(now)}${firstName ? `, ${firstName}` : ''}`}
        actions={
          <>
            <Button variant="default" leftSection={<IconSearch size={16} />} onClick={() => spotlight.open()}>
              Find patient
            </Button>
            {canBook && calendarBuilt && (
              <Button leftSection={<IconCalendarPlus size={16} />} onClick={() => navigate('/calendar?new=1')}>
                New appointment
              </Button>
            )}
          </>
        }
      />
      <StatStrip
        rows={rows}
        loading={schedule.loading && !schedule.data}
        next={next}
        alerts={alerts}
        queues={queues}
        onOpenNext={() => next && openRow(next)}
        onOpenSchedule={() => scrollTo('schedule')}
        onOpenAlerts={() => scrollTo('alerts')}
        onOpenQueues={() => scrollTo('queues')}
      />
      <Grid gutter="lg" align="flex-start">
        <Grid.Col span={{ base: 12, lg: 8 }} id="schedule">
          <ScheduleCard schedule={schedule} nextId={next?.appointment.id} onOpen={openRow} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Stack gap="lg">
            <AlertsCard alerts={alerts} />
            <div id="queues">
              <WorkQueueList queues={queues} />
            </div>
          </Stack>
        </Grid.Col>
      </Grid>
    </PageBody>
  );
}
