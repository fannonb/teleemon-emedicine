import { Card, Skeleton, Text, Tooltip, UnstyledButton } from '@mantine/core';
import type { MedplumClient } from '@medplum/core';
import { getReferenceString } from '@medplum/core';
import type { ResourceType } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import {
  IconChevronRight,
  IconFileAlert,
  IconFileInvoice,
  IconFlask,
  IconListCheck,
  IconMessage,
  IconPill,
  IconPrinter,
  IconRosetteDiscountCheck,
} from '@tabler/icons-react';
import { CODE_SYSTEMS, OPEN_TASK_STATUS_PARAM } from '@teleemon/core';
import { QUEUES } from '../../inbox/inbox';
import type { JSX, ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { CardHeader } from '../../components/CardHeader';
import { useLoader } from '../../hooks/useLoader';
import type { Role } from '../../navigation';
import { formatAge } from '../../utils/format';
import classes from './TodayPage.module.css';

interface QueueDef {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly path: string;
  readonly roles: readonly Role[];
  /** Live queues have a query; planned queues name the phase that builds them. */
  readonly query?: { resourceType: ResourceType; params: Record<string, string>; arrivedParam: string; arrivedField: string };
  readonly phase?: number;
}

export interface QueueCount {
  readonly total: number;
  readonly oldest?: string;
}

export interface QueueState {
  readonly def: QueueDef;
  readonly count?: QueueCount;
  readonly loading: boolean;
  readonly error: boolean;
}

function queueDefs(profileRef: string): QueueDef[] {
  return [
    {
      key: 'messages',
      label: 'Patient messages',
      icon: <IconMessage size={17} />,
      path: '/inbox',
      roles: ['provider', 'frontdesk'],
      query: { resourceType: 'Communication', params: QUEUES.messages.params(), arrivedParam: 'sent', arrivedField: 'sent' },
    },
    {
      key: 'tasks',
      label: 'My tasks',
      icon: <IconListCheck size={17} />,
      path: '/tasks',
      roles: ['provider', 'frontdesk', 'biller'],
      query: {
        resourceType: 'Task',
        params: QUEUES.myTasks.params(profileRef),
        arrivedParam: 'authored-on',
        arrivedField: 'authoredOn',
      },
    },
    {
      key: 'notes',
      label: 'Unsigned notes',
      icon: <IconRosetteDiscountCheck size={17} />,
      path: '/notes',
      roles: ['provider'],
      query: { resourceType: 'Composition', params: { status: 'preliminary' }, arrivedParam: 'date', arrivedField: 'date' },
    },
    {
      key: 'refills',
      label: 'Refill requests',
      icon: <IconPill size={17} />,
      path: '/refills',
      roles: ['provider'],
      query: {
        resourceType: 'Task',
        params: { owner: profileRef, code: `${CODE_SYSTEMS.taskCode}|rx-renewal`, status: OPEN_TASK_STATUS_PARAM },
        arrivedParam: 'authored-on',
        arrivedField: 'authoredOn',
      },
    },
    {
      key: 'results',
      label: 'Results to review',
      icon: <IconFlask size={17} />,
      path: '/inbox',
      roles: ['provider'],
      query: { resourceType: 'Task', params: QUEUES.results.params(profileRef), arrivedParam: 'authored-on', arrivedField: 'authoredOn' },
    },
    {
      key: 'faxes',
      label: 'Faxes to file',
      icon: <IconPrinter size={17} />,
      path: '/documents',
      roles: ['frontdesk'],
      query: { resourceType: 'Task', params: QUEUES.faxes.params(), arrivedParam: 'authored-on', arrivedField: 'authoredOn' },
    },
    { key: 'rejections', label: 'Claim rejections', icon: <IconFileInvoice size={17} />, path: '/billing/claims', roles: ['biller', 'provider'], phase: 8 },
    { key: 'denials', label: 'Denials to work', icon: <IconFileAlert size={17} />, path: '/billing/denials', roles: ['biller', 'provider'], phase: 8 },
  ];
}

async function loadCounts(medplum: MedplumClient, defs: QueueDef[]): Promise<Record<string, QueueCount | null>> {
  const entries = await Promise.all(
    defs
      .filter((d) => d.query)
      .map(async (d) => {
        const q = d.query as NonNullable<QueueDef['query']>;
        try {
          // The count and the oldest item use the same criteria as the linked list.
          const [counted, oldest] = await Promise.all([
            medplum.search(q.resourceType, { ...q.params, _summary: 'count' }, { cache: 'no-cache' }),
            medplum.search(q.resourceType, { ...q.params, _sort: q.arrivedParam, _count: '1' }, { cache: 'no-cache' }),
          ]);
          const first = oldest.entry?.[0]?.resource as Record<string, unknown> | undefined;
          return [d.key, { total: counted.total ?? 0, oldest: first?.[q.arrivedField] as string | undefined }] as const;
        } catch {
          return [d.key, null] as const;
        }
      })
  );
  return Object.fromEntries(entries);
}

/** Work queues for the signed-in roles, with live counts refreshed every minute. */
export function useWorkQueues(roles: readonly Role[]): QueueState[] {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const profileRef = (profile && getReferenceString(profile)) ?? '';
  const defs = queueDefs(profileRef).filter((d) => roles.includes('admin') || d.roles.some((r) => roles.includes(r)));
  const counts = useLoader(() => loadCounts(medplum, defs), [medplum, profileRef, roles.join()], 60000);
  return defs.map((def) => ({
    def,
    count: counts.data?.[def.key] ?? undefined,
    loading: counts.loading && !counts.data,
    error: counts.data?.[def.key] === null,
  }));
}

function ageColor(since: string): string {
  const hours = (Date.now() - new Date(since).getTime()) / 3600000;
  if (hours >= 48) return 'red';
  if (hours >= 24) return 'orange';
  return 'dimmed';
}

export function WorkQueueList({ queues }: { readonly queues: QueueState[] }): JSX.Element {
  const navigate = useNavigate();
  const live = queues.filter((q) => q.def.query);
  const planned = queues.filter((q) => !q.def.query);
  return (
    <Card>
      <CardHeader title="Work queues" action={<Text size="xs" c="dimmed">Refreshes every minute</Text>} />
      <div className={classes.queueList}>
        {live.map((q) => (
          <UnstyledButton key={q.def.key} className={classes.queueRow} onClick={() => navigate(q.def.path)} aria-label={`${q.def.label}: ${q.count?.total ?? 'loading'}`}>
            <span className={classes.queueIcon}>{q.def.icon}</span>
            <Text size="sm" fw={550} className={classes.queueLabel}>
              {q.def.label}
            </Text>
            <span className={classes.queueMeta}>
              {q.loading ? (
                <Skeleton height={18} width={28} />
              ) : q.error ? (
                <Text size="xs" c="red">
                  Unavailable
                </Text>
              ) : (
                <>
                  {q.count?.oldest && (q.count.total ?? 0) > 0 && (
                    <Text size="xs" c={ageColor(q.count.oldest)} className="tm-num">
                      oldest {formatAge(q.count.oldest)}
                    </Text>
                  )}
                  <Text fw={700} className={`${classes.queueCount} tm-num`}>
                    {q.count?.total ?? 0}
                  </Text>
                </>
              )}
            </span>
            <IconChevronRight size={16} className={classes.rowChevron} aria-hidden />
          </UnstyledButton>
        ))}
      </div>
      {planned.length > 0 && (
        <Tooltip
          multiline
          w={260}
          label={planned.map((q) => `${q.def.label}: Phase ${q.def.phase}`).join(' · ')}
        >
          <Text size="xs" c="dimmed" mt="sm" style={{ cursor: 'help' }}>
            {planned.length} more queue{planned.length > 1 ? 's' : ''} ({planned.map((q) => q.def.label.toLowerCase()).join(', ')}) arrive in later phases.
          </Text>
        </Tooltip>
      )}
    </Card>
  );
}
