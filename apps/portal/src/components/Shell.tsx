import { Anchor, Badge, Group, Menu, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { IconCalendar, IconFileText, IconHome, IconLogout, IconMessage, IconPill, IconReceipt, IconUser } from '@tabler/icons-react';
import { CRISIS_LINES } from '@teleemon/core';
import type { JSX, ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { useSession } from '../session';

/**
 * The Teleemon lockup: mark and wordmark from the brand artwork (apps/portal/public/brand). The
 * header is navy in both colour schemes, so the white artwork is always used.
 */
export function Logo({ height = 44 }: { readonly height?: number }): JSX.Element {
  return (
    <Group gap={10} wrap="nowrap" aria-label="Teleemon Behavioral Health">
      <img src="/brand/teleemon-mark-white.png" alt="" style={{ height, width: 'auto', display: 'block', flexShrink: 0 }} />
      <img src="/brand/teleemon-wordmark-white.png" alt="Teleemon" style={{ height: Math.round(height * 0.52), width: 'auto', display: 'block', flexShrink: 0 }} />
    </Group>
  );
}

/** Crisis lines on every page, signed in or not (X01–X09 acceptance). */
export function CrisisFooter(): JSX.Element {
  return (
    <footer className="tm-crisis" aria-label="Crisis resources">
      <div className="tm-crisis-inner">
        <Stack gap={2}>
          <Text size="sm">
            Need help now? <Anchor href="tel:988" fw={650}>Call or text 988</Anchor>. In an emergency, <Anchor href="tel:911" fw={650}>call 911</Anchor>.
          </Text>
          <Text size="xs" c="dimmed">{CRISIS_LINES.notMonitored}</Text>
        </Stack>
      </div>
    </footer>
  );
}

const NAV = [
  { to: '/home', label: 'Home', icon: IconHome, clinical: false },
  { to: '/appointments', label: 'Visits', icon: IconCalendar, clinical: false },
  { to: '/messages', label: 'Messages', icon: IconMessage, clinical: true },
  { to: '/summaries', label: 'Summaries', icon: IconFileText, clinical: true },
  { to: '/refills', label: 'Refills', icon: IconPill, clinical: true },
  { to: '/billing', label: 'Billing', icon: IconReceipt, clinical: true },
] as const;

export function Shell({ children }: { readonly children: ReactNode }): JSX.Element {
  const { me, signOut } = useSession();
  const navigate = useNavigate();
  const items = NAV.filter((n) => !n.clinical || me?.access !== 'limited');
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header className="tm-header">
        <div className="tm-header-inner">
          <Link to={me ? '/home' : '/'} style={{ textDecoration: 'none' }} aria-label="Teleemon home"><Logo height={34} /></Link>
          {me && (
            <nav className="tm-top-links" aria-label="Main">
              {items.map((n) => <NavLink key={n.to} to={n.to}>{n.label}</NavLink>)}
            </nav>
          )}
          <div style={{ flex: 1 }} />
          {me && (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <UnstyledButton aria-label="Account" style={{ color: '#fff' }}>
                  <Group gap={6} wrap="nowrap"><IconUser size={18} /><Text size="sm" c="white" visibleFrom="xs">{me.actorName.split(' ')[0]}</Text></Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconUser size={16} />} onClick={() => navigate('/profile')}>Profile</Menu.Item>
                <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void signOut().then(() => navigate('/signin'))}>Sign out</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </div>
      </header>
      {me && me.access !== 'self' && (
        <div style={{ background: 'var(--mantine-color-blue-light)' }}>
          <Group className="tm-header-inner" gap="xs" py={6}>
            <Text size="sm">You are signed in as <b>{me.actorName}</b> for <b>{me.patientName}</b>.</Text>
            {me.access === 'limited' && <Badge color="blue">Scheduling and insurance only</Badge>}
          </Group>
        </div>
      )}
      <main style={{ flex: 1 }}>{children}</main>
      <CrisisFooter />
      {me && (
        <nav className="tm-bottom-nav" aria-label="Main">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to}>
              <n.icon size={20} aria-hidden="true" />
              {n.label}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}

export function Page({ title, subtitle, children, actions }: { readonly title: string; readonly subtitle?: ReactNode; readonly children: ReactNode; readonly actions?: ReactNode }): JSX.Element {
  return (
    <div className="tm-page">
      <Group justify="space-between" align="flex-start" mb="lg" wrap="nowrap" gap="sm">
        <div>
          <Title order={1}>{title}</Title>
          {subtitle && <Text c="dimmed" mt={4}>{subtitle}</Text>}
        </div>
        {actions}
      </Group>
      <Stack gap="lg">{children}</Stack>
    </div>
  );
}
