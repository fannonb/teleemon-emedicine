import { Card, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { IconChevronRight, IconCircleCheck } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router';
import { CardHeader } from '../../components/CardHeader';
import { RowsSkeleton } from '../../components/states';
import classes from './TodayPage.module.css';
import type { TodayAlerts } from './useTodayAlerts';

export function AlertsCard({ alerts }: { readonly alerts: TodayAlerts }): JSX.Element {
  const navigate = useNavigate();
  const { items, loading } = alerts;
  return (
    <Card id="alerts">
      <CardHeader title="Needs attention" count={items.length > 0 ? items.length : undefined} />
      {loading && items.length === 0 ? (
        <RowsSkeleton rows={2} height={52} />
      ) : items.length === 0 ? (
        <div className={classes.allClear}>
          <ThemeIcon color="green" variant="light" radius="xl">
            <IconCircleCheck size={16} />
          </ThemeIcon>
          <Text size="sm" c="dimmed">
            All clear. Licences, safety screens and today's patient locations are in order.
          </Text>
        </div>
      ) : (
        <Stack gap={4} aria-live="polite">
          {items.map((a) => {
            const body = (
              <>
                <ThemeIcon color={a.severity} variant="light" radius="xl" size={28}>
                  {a.icon}
                </ThemeIcon>
                <div className={classes.alertText}>
                  <Text size="sm" fw={600} lh={1.35}>
                    {a.title}
                  </Text>
                  <Text size="xs" c="dimmed" lh={1.4}>
                    {a.detail}
                  </Text>
                </div>
                {a.link && <IconChevronRight size={16} className={classes.rowChevron} />}
              </>
            );
            return a.link ? (
              <UnstyledButton key={a.key} className={`${classes.alertRow} ${classes.alertRowLink}`} onClick={() => navigate(a.link as string)}>
                {body}
              </UnstyledButton>
            ) : (
              <div key={a.key} className={classes.alertRow}>
                {body}
              </div>
            );
          })}
        </Stack>
      )}
      <Text size="xs" c="dimmed" mt="md">
        Review refill requests and lab follow-ups in your inbox. Prescribing checks run before each prescription is sent.
      </Text>
    </Card>
  );
}
