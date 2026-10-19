import { ActionIcon, Badge, Button, Card, Checkbox, Group, Modal, SegmentedControl, Select, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { Appointment, Slot } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconBan, IconBuilding, IconCalendarPlus, IconChevronLeft, IconChevronRight, IconPhone, IconVideo } from '@tabler/icons-react';
import type { Modality } from '@teleemon/core';
import { ACTIVE_STATUSES, LICENSED_STATES, PRACTICE_TIME_ZONE, hoursFor, readSettings, zonedDate, zonedTime } from '@teleemon/core';
import type { CSSProperties, JSX } from 'react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageBody } from '../../components/PageHeader';
import { EmptyState, ErrorState, RowsSkeleton } from '../../components/states';
import { STATUS_DISPLAY } from '../../fhir/appointments';
import { patientName } from '../../fhir/patient';
import type { CalendarItem, Provider } from '../../fhir/scheduling';
import { addDays, dayLabel, loadProviders, loadRange, minutesOfDay, practiceParts, weekStart } from '../../fhir/scheduling';
import { useLoader } from '../../hooks/useLoader';
import { formatDate, formatTime } from '../../utils/format';
import { AppointmentDrawer } from './AppointmentDrawer';
import classes from './Calendar.module.css';

type View = 'day' | 'week' | 'month' | 'list';
const SLOT_PX = 28; // per 15 minutes: a 30-minute visit has room for time and patient name.
const MODALITY_ICON: Record<Modality, JSX.Element> = {
  video: <IconVideo size={12} />,
  phone: <IconPhone size={12} />,
  office: <IconBuilding size={12} />,
};

function rangeFor(view: View, date: string): { days: string[]; start: string; end: string } {
  let days: string[];
  if (view === 'day') days = [date];
  else if (view === 'month') {
    const first = `${date.slice(0, 8)}01`;
    const gridStart = weekStart(first);
    days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  } else {
    const mon = weekStart(date);
    days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  }
  return {
    days,
    start: zonedTime(days[0], 0, 0, PRACTICE_TIME_ZONE).toISOString(),
    end: zonedTime(addDays(days[days.length - 1], 1), 0, 0, PRACTICE_TIME_ZONE).toISOString(),
  };
}

// P04 Calendar and schedule.
export function CalendarPage(): JSX.Element {
  const medplum = useMedplum();
  const [params, setParams] = useSearchParams();
  const today = zonedDate(new Date());
  const view = (params.get('view') as View) || 'week';
  const date = params.get('date') || today;
  const drawerId = params.get('appointment') ?? undefined;
  const newStart = params.get('start') ?? undefined;
  const drawerOpen = !!drawerId || params.get('new') === '1';
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [move, setMove] = useState<{ item: CalendarItem; start: string }>();

  const set = (changes: Record<string, string | undefined>): void => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const range = useMemo(() => rangeFor(view, date), [view, date]);
  const providers = useLoader(() => loadProviders(medplum), [medplum]);
  const settings = useLoader(() => readSettings(medplum, 'practice'), [medplum]);
  const data = useLoader(() => loadRange(medplum, range.start, range.end), [medplum, range.start, range.end], 60000);

  const items = (data.data?.items ?? []).filter(
    (i) => (showCancelled || !['cancelled', 'entered-in-error'].includes(i.appointment.status)) && (!providerFilter || i.practitionerRef === `Practitioner/${providerFilter}`)
  );
  const closures = (settings.data?.closures ?? []).map((c) => c.date);

  const step = (dir: number): void => {
    const next = view === 'day' ? addDays(date, dir) : view === 'month' ? `${new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + dir, 1)).toISOString().slice(0, 7)}-01` : addDays(date, 7 * dir);
    set({ date: next });
  };
  const title =
    view === 'day'
      ? dayLabel(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      : view === 'month'
        ? dayLabel(date, { month: 'long', year: 'numeric' })
        : `${dayLabel(range.days[0], { month: 'short', day: 'numeric' })} – ${dayLabel(range.days[6], { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const confirmMove = async (): Promise<void> => {
    if (!move) return;
    const a = move.item.appointment;
    const duration = Date.parse(a.end as string) - Date.parse(a.start as string);
    try {
      await medplum.updateResource<Appointment>({ ...a, start: move.start, end: new Date(Date.parse(move.start) + duration).toISOString() });
      notifications.show({ color: 'brand', message: `Moved to ${formatDate(practiceParts(move.start).ymd)} ${formatTime(move.start)}.` });
      data.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not moved', message: normalizeErrorString(err), autoClose: 8000 });
    }
    setMove(undefined);
  };

  return (
    <PageBody wide>
      <header className={classes.pageHeader}>
        <div className={classes.pageTitle}>
          <Text size="xs" c="dimmed" fw={600} mb={6}>Daily work</Text>
          <Title order={1}>Calendar</Title>
          <Text size="sm" c="dimmed" mt={8}>All times Pacific. Open a visit for patient-local time and appointment details.</Text>
        </div>
        <Group gap="sm" className={classes.headerActions}>
          <Button variant="default" leftSection={<IconBan size={16} />} onClick={() => setBlocking(true)}>
            Block time
          </Button>
          <Button leftSection={<IconCalendarPlus size={16} />} onClick={() => set({ new: '1', appointment: undefined, start: undefined })}>
            New appointment
          </Button>
        </Group>
      </header>
      <Card padding={0} className={classes.toolbar}>
        <div className={classes.toolbarContent}>
          <div className={classes.dateNavigation}>
            <Group gap={6} wrap="nowrap">
              <ActionIcon variant="default" size="lg" onClick={() => step(-1)} aria-label="Previous">
                <IconChevronLeft size={18} />
              </ActionIcon>
              <Button variant="default" onClick={() => set({ date: today })}>
                Today
              </Button>
              <ActionIcon variant="default" size="lg" onClick={() => step(1)} aria-label="Next">
                <IconChevronRight size={18} />
              </ActionIcon>
            </Group>
            <Text fw={650} className={`tm-num ${classes.rangeTitle}`}>
              {title}
            </Text>
          </div>
          <div className={classes.viewControls}>
            <Checkbox size="xs" label="Show cancelled" checked={showCancelled} onChange={(e) => setShowCancelled(e.currentTarget.checked)} />
            {(providers.data?.length ?? 0) > 1 && (
              <Select
                size="xs"
                placeholder="All providers"
                clearable
                value={providerFilter}
                onChange={setProviderFilter}
                data={(providers.data ?? []).map((p) => ({ value: p.practitioner.id as string, label: [p.practitioner.name?.[0]?.given?.[0], p.practitioner.name?.[0]?.family].join(' ') }))}
              />
            )}
            <SegmentedControl
              size="sm"
              value={view}
              onChange={(v) => set({ view: v })}
              data={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
                { value: 'list', label: 'List' },
              ]}
            />
          </div>
        </div>
      </Card>

      {data.error ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : !data.data ? (
        <Card>
          <RowsSkeleton rows={8} />
        </Card>
      ) : view === 'month' ? (
        <MonthView days={range.days} month={date.slice(0, 7)} items={items} closures={closures} hours={settings.data?.hours} onPickDay={(d) => set({ view: 'day', date: d })} />
      ) : view === 'list' ? (
        <ListView items={items} onOpen={(i) => set({ appointment: i.appointment.id, new: undefined })} />
      ) : (
        <TimeGrid
          days={view === 'day' ? range.days : range.days.filter((d, i) => i < 6 || items.some((it) => practiceParts(it.appointment.start as string).ymd === d))}
          items={items}
          blocked={data.data.blocked}
          closures={closures}
          hours={settings.data?.hours}
          today={today}
          onOpen={(i) => set({ appointment: i.appointment.id, new: undefined })}
          onEmpty={(start) => set({ new: '1', appointment: undefined, start })}
          onDrop={(item, start) => setMove({ item, start })}
        />
      )}
      <Legend />

      <AppointmentDrawer
        opened={drawerOpen}
        appointmentId={drawerId}
        initialStart={newStart}
        providers={providers.data ?? []}
        onClose={() => set({ appointment: undefined, new: undefined, start: undefined })}
        onSaved={data.reload}
      />
      {blocking && providers.data && <BlockTimeModal providers={providers.data} date={date} onClose={() => setBlocking(false)} onSaved={() => { setBlocking(false); data.reload(); }} />}
      <Modal opened={!!move} onClose={() => setMove(undefined)} title="Move appointment?" centered>
        {move && (
          <Stack>
            <Text size="sm">
              Move <b>{patientName(move.item.patient)}</b> from {formatDate(practiceParts(move.item.appointment.start as string).ymd)} {formatTime(move.item.appointment.start)} to{' '}
              <b>
                {formatDate(practiceParts(move.start).ymd)} {formatTime(move.start)}
              </b>
              ? The server re-checks conflicts and licensure, and the change is kept in the visit history.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setMove(undefined)}>
                Keep
              </Button>
              <Button onClick={confirmMove}>Move</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </PageBody>
  );
}

function lanes(items: CalendarItem[]): Map<string, { lane: number; of: number }> {
  const sorted = [...items].sort((a, b) => (a.appointment.start as string).localeCompare(b.appointment.start as string));
  const result = new Map<string, { lane: number; of: number }>();
  let cluster: CalendarItem[] = [];
  let clusterEnd = '';
  const flush = (): void => {
    const ends: string[] = [];
    for (const it of cluster) {
      let lane = ends.findIndex((e) => e <= (it.appointment.start as string));
      if (lane === -1) lane = ends.length;
      ends[lane] = it.appointment.end as string;
      result.set(it.appointment.id as string, { lane, of: 0 });
    }
    for (const it of cluster) result.set(it.appointment.id as string, { lane: result.get(it.appointment.id as string)?.lane ?? 0, of: ends.length });
    cluster = [];
  };
  // A cluster is a run of visits that overlap each other directly or through a chain;
  // every visit in a cluster shares the cluster's lane count so widths line up.
  for (const it of sorted) {
    if (cluster.length && (it.appointment.start as string) >= clusterEnd) {
      flush();
      clusterEnd = '';
    }
    cluster.push(it);
    if ((it.appointment.end as string) > clusterEnd) clusterEnd = it.appointment.end as string;
  }
  flush();
  return result;
}

function TimeGrid({
  days,
  items,
  blocked,
  closures,
  hours,
  today,
  onOpen,
  onEmpty,
  onDrop,
}: {
  readonly days: string[];
  readonly items: CalendarItem[];
  readonly blocked: Slot[];
  readonly closures: string[];
  readonly hours?: Parameters<typeof hoursFor>[1];
  readonly today: string;
  readonly onOpen: (i: CalendarItem) => void;
  readonly onEmpty: (start: string) => void;
  readonly onDrop: (item: CalendarItem, start: string) => void;
}): JSX.Element {
  // Visible range: earliest opening to latest closing across these days (default 9–21).
  const opens = days.map((d) => hoursFor(d, hours, closures)).filter(Boolean) as { start: string; end: string }[];
  const firstMin = Math.min(9 * 60, ...opens.map((o) => minutesOfDay(o.start)), ...items.map((i) => minutesOfDay(i.appointment.start as string)));
  const lastMin = Math.max(21 * 60, ...opens.map((o) => minutesOfDay(o.end)), ...items.map((i) => minutesOfDay(i.appointment.end as string)));
  const startMin = Math.floor(firstMin / 60) * 60;
  const endMin = Math.ceil(lastMin / 60) * 60;
  const rows = (endMin - startMin) / 15;
  const height = rows * SLOT_PX;
  const [dragId, setDragId] = useState<string>();
  const nowMin = minutesOfDay(new Date().toISOString());

  return (
    <Card padding={0} className={classes.gridCard}>
      <div className={classes.gridViewport} tabIndex={0} role="region" aria-label="Appointment calendar. Scroll for later times or more days.">
        <div className={classes.grid} style={{ '--days': days.length } as CSSProperties}>
          <div className={classes.cornerCell}>PT</div>
          {days.map((d) => {
            const count = items.filter((i) => practiceParts(i.appointment.start as string).ymd === d && ACTIVE_STATUSES.includes(i.appointment.status)).length;
            const closed = !hoursFor(d, hours, closures);
            return (
              <div key={d} className={`${classes.dayHead} ${d === today ? classes.dayHeadToday : ''}`}>
                <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                  {dayLabel(d, { weekday: 'short' })}
                </Text>
                <Group gap={6} justify="center">
                  <Text fw={700} className={d === today ? classes.todayNum : undefined}>
                    {Number(d.slice(8))}
                  </Text>
                  {closed ? (
                    <Badge size="xs" color="gray" variant="light">
                      Closed
                    </Badge>
                  ) : count > 0 ? (
                    <Badge size="xs" variant="light" color="navy">
                      {count}
                    </Badge>
                  ) : null}
                </Group>
              </div>
            );
          })}

          <div className={classes.gutter} style={{ height }}>
            {Array.from({ length: (endMin - startMin) / 60 }, (_, h) => (
              <div key={h} className={classes.hourLabel} style={{ top: h * 4 * SLOT_PX }}>
                {formatHour(startMin / 60 + h)}
              </div>
            ))}
          </div>
          {days.map((d) => {
            const open = hoursFor(d, hours, closures);
            const dayItems = items.filter((i) => practiceParts(i.appointment.start as string).ymd === d);
            const laneMap = lanes(dayItems.filter((i) => !['cancelled', 'entered-in-error'].includes(i.appointment.status)));
            const dayBlocks = blocked.filter((b) => practiceParts(b.start).ymd === d);
            return (
              <div key={d} className={`${classes.dayCol} ${d === today ? classes.dayColToday : ''}`} style={{ height }}>
                {Array.from({ length: rows }, (_, r) => {
                  const min = startMin + r * 15;
                  const start = zonedTime(d, Math.floor(min / 60), min % 60, PRACTICE_TIME_ZONE).toISOString();
                  const inHours = !!open && start >= open.start && start < open.end;
                  const past = start < new Date().toISOString();
                  return (
                    <div
                      key={r}
                      className={`${classes.cell} ${min % 60 === 0 ? classes.cellHour : ''} ${!inHours ? classes.cellClosed : ''}`}
                      style={{ top: r * SLOT_PX, height: SLOT_PX }}
                      onClick={() => inHours && !past && onEmpty(start)}
                      onDragOver={(e) => {
                        if (inHours && !past) {
                          e.preventDefault();
                          e.currentTarget.classList.add(classes.cellDrop);
                        }
                      }}
                      onDragLeave={(e) => e.currentTarget.classList.remove(classes.cellDrop)}
                      onDrop={(e) => {
                        e.currentTarget.classList.remove(classes.cellDrop);
                        const item = items.find((i) => i.appointment.id === dragId);
                        if (item && start !== item.appointment.start) onDrop(item, start);
                      }}
                      title={inHours && !past ? `Book ${formatTime(start)}` : undefined}
                    />
                  );
                })}
                {dayBlocks.map((b) => {
                  const top = ((minutesOfDay(b.start) - startMin) / 15) * SLOT_PX;
                  const h = ((Date.parse(b.end) - Date.parse(b.start)) / 900000) * SLOT_PX;
                  return (
                    <div key={b.id} className={classes.blocked} style={{ top, height: h }}>
                      <IconBan size={13} aria-hidden="true" />
                      <span>{b.comment ?? 'Blocked'}</span>
                    </div>
                  );
                })}
                {d === today && nowMin >= startMin && nowMin <= endMin && <div className={classes.nowLine} style={{ top: ((nowMin - startMin) / 15) * SLOT_PX }} />}
                {dayItems.map((i) => {
                  const a = i.appointment;
                  const top = ((minutesOfDay(a.start as string) - startMin) / 15) * SLOT_PX;
                  const h = Math.max(SLOT_PX - 6, ((Date.parse(a.end as string) - Date.parse(a.start as string)) / 900000) * SLOT_PX - 6);
                  const lane = laneMap.get(a.id as string) ?? { lane: 0, of: 1 };
                  const unlicensed = !!i.locationState && !(LICENSED_STATES as readonly string[]).includes(i.locationState);
                  const movable = ['booked', 'pending', 'proposed'].includes(a.status) && (a.start as string) > new Date().toISOString();
                  const preview = [
                    patientName(i.patient), `${formatTime(a.start)}–${formatTime(a.end)} PT`, i.visitLabel,
                    STATUS_DISPLAY[a.status].label, i.locationState,
                    unlicensed ? 'Not licensed in patient location' : undefined,
                  ].filter(Boolean).join(' · ');
                  return (
                    <Tooltip key={a.id} label={preview} multiline w={280} events={{ hover: true, focus: true, touch: false }}>
                      <button
                        type="button"
                        className={`${classes.event} ${h < 44 ? classes.eventCompact : ''} ${classes[`status_${a.status.replace('-', '_')}`] ?? ''}`}
                        style={{ top: top + 3, height: h, left: `calc(${(100 / lane.of) * lane.lane}% + 6px)`, width: `calc(${100 / lane.of}% - 12px)` }}
                        onClick={() => onOpen(i)}
                        draggable={movable}
                        onDragStart={(e) => {
                          setDragId(a.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        aria-label={`${formatTime(a.start)} ${patientName(i.patient)}, ${i.visitLabel}, ${STATUS_DISPLAY[a.status].label}`}
                      >
                        <span className={classes.eventTime}>
                          {formatTime(a.start)}
                          <span className={classes.eventIndicators}>
                            {i.modality && <span className={classes.eventIcon}>{MODALITY_ICON[i.modality]}</span>}
                            {unlicensed && (
                              <IconAlertTriangle size={12} color="var(--mantine-color-red-6)" aria-label={`Not licensed in ${i.locationState}`} />
                            )}
                            <span className={classes.statusDot} aria-hidden="true" />
                          </span>
                        </span>
                        <span className={classes.eventName}>{patientName(i.patient)}</span>
                        {h >= 74 && <span className={classes.eventType}>{i.visitLabel}</span>}
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {items.length === 0 && (
        <Text size="sm" c="dimmed" ta="center" py="sm">
          No visits in this range. Click any open time to book.
        </Text>
      )}
    </Card>
  );
}

function formatHour(h: number): string {
  return `${((h + 11) % 12) + 1} ${h < 12 || h === 24 ? 'AM' : 'PM'}`;
}

function MonthView({ days, month, items, closures, hours, onPickDay }: { readonly days: string[]; readonly month: string; readonly items: CalendarItem[]; readonly closures: string[]; readonly hours?: Parameters<typeof hoursFor>[1]; readonly onPickDay: (d: string) => void }): JSX.Element {
  const today = zonedDate(new Date());
  return (
    <Card padding={0} className={classes.gridCard}>
      <div className={classes.monthViewport}>
        <div className={classes.month}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d} className={classes.monthHead}>
              {d}
            </div>
          ))}
          {days.map((d) => {
            const list = items.filter((i) => practiceParts(i.appointment.start as string).ymd === d);
            const closed = !hoursFor(d, hours, closures);
            return (
              <button type="button" key={d} className={`${classes.monthCell} ${d.slice(0, 7) !== month ? classes.monthOther : ''} ${closed ? classes.monthClosed : ''}`} onClick={() => onPickDay(d)}>
                <span className={`${classes.monthNum} ${d === today ? classes.todayNum : ''}`}>{Number(d.slice(8))}</span>
                {list.slice(0, 3).map((i) => (
                  <span key={i.appointment.id} className={classes.monthItem}>
                    <b className="tm-num">{formatTime(i.appointment.start)}</b> {patientName(i.patient)}
                  </span>
                ))}
                {list.length > 3 && <span className={classes.monthMore}>+{list.length - 3} more</span>}
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function ListView({ items, onOpen }: { readonly items: CalendarItem[]; readonly onOpen: (i: CalendarItem) => void }): JSX.Element {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState icon={<IconCalendarPlus size={22} />} title="No visits this week" />
      </Card>
    );
  }
  return (
    <Card padding={0}>
      <Table.ScrollContainer minWidth={720}>
        <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="lg">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Time</Table.Th>
              <Table.Th>Patient</Table.Th>
              <Table.Th>Visit</Table.Th>
              <Table.Th>Located in</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((i) => (
              <Table.Tr key={i.appointment.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(i)}>
                <Table.Td className="tm-num">{dayLabel(practiceParts(i.appointment.start as string).ymd)}</Table.Td>
                <Table.Td className="tm-num">{formatTime(i.appointment.start)}</Table.Td>
                <Table.Td fw={600}>{patientName(i.patient)}</Table.Td>
                <Table.Td>{i.visitLabel}</Table.Td>
                <Table.Td>
                  <Badge size="sm" color={i.locationState && !(LICENSED_STATES as readonly string[]).includes(i.locationState) ? 'red' : 'navy'} variant="light">
                    {i.locationState ?? '—'}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" color={STATUS_DISPLAY[i.appointment.status].color} variant="dot">
                    {STATUS_DISPLAY[i.appointment.status].label}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

function Legend(): JSX.Element {
  return (
    <div className={classes.calendarFooter}>
      <Group gap="lg" className={classes.legend}>
        <span className={`${classes.legendItem} ${classes.status_booked}`}><span className={classes.statusDot} />Booked</span>
        <span className={`${classes.legendItem} ${classes.status_arrived}`}><span className={classes.statusDot} />Checked in</span>
        <span className={`${classes.legendItem} ${classes.status_fulfilled}`}><span className={classes.statusDot} />Completed</span>
        <span className={`${classes.legendItem} ${classes.status_noshow}`}><span className={classes.statusDot} />No-show</span>
        <span className={classes.legendItem}><IconBan size={13} />Blocked time</span>
      </Group>
      <Text size="xs" c="dimmed">
        Drag a booked visit to reschedule · click an open time to book
      </Text>
    </div>
  );
}

function BlockTimeModal({ providers, date, onClose, onSaved }: { readonly providers: Provider[]; readonly date: string; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [providerId, setProviderId] = useState<string | null>(providers[0]?.practitioner.id ?? null);
  const [day, setDay] = useState(date);
  const [from, setFrom] = useState('13:00');
  const [to, setTo] = useState('14:00');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const save = async (): Promise<void> => {
    const provider = providers.find((p) => p.practitioner.id === providerId);
    if (!provider || !reason.trim() || to <= from) {
      setError('Choose the provider, a start before the end, and a reason.');
      return;
    }
    try {
      await medplum.createResource<Slot>({
        resourceType: 'Slot',
        schedule: createReference(provider.schedule),
        status: 'busy-unavailable',
        start: zonedTime(day, Number(from.slice(0, 2)), Number(from.slice(3)), PRACTICE_TIME_ZONE).toISOString(),
        end: zonedTime(day, Number(to.slice(0, 2)), Number(to.slice(3)), PRACTICE_TIME_ZONE).toISOString(),
        comment: reason.trim(),
      });
      notifications.show({ color: 'brand', message: 'Time blocked. It can no longer be booked without an overbook reason.' });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };
  return (
    <Modal opened onClose={onClose} title="Block time" centered>
      <Stack>
        {providers.length > 1 && <Select label="Provider" data={providers.map((p) => ({ value: p.practitioner.id as string, label: [p.practitioner.name?.[0]?.given?.[0], p.practitioner.name?.[0]?.family].join(' ') }))} value={providerId} onChange={setProviderId} />}
        <TextInput label="Date" type="date" value={day} onChange={(e) => setDay(e.currentTarget.value)} />
        <Group grow>
          <TextInput label="From" type="time" step={900} value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
          <TextInput label="To" type="time" step={900} value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        </Group>
        <TextInput label="Reason" placeholder="e.g. Lunch, admin time, personal" value={reason} onChange={(e) => setReason(e.currentTarget.value)} required />
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save}>Block time</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
