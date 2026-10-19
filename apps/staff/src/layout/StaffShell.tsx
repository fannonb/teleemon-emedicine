import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
  Burger,
  Button,
  Collapse,
  Group,
  Kbd,
  Menu,
  ScrollArea,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure, useHotkeys } from '@mantine/hooks';
import { spotlight } from '@mantine/spotlight';
import { formatHumanName } from '@medplum/core';
import type { HumanName } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import {
  IconCalendarEvent,
  IconCalendarPlus,
  IconChartBar,
  IconChevronDown,
  IconClipboardCheck,
  IconClipboardText,
  IconEye,
  IconFileInvoice,
  IconFileText,
  IconFlask,
  IconHome,
  IconInbox,
  IconListCheck,
  IconLogout,
  IconMessagePlus,
  IconMoon,
  IconPill,
  IconReceipt,
  IconReportMoney,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconShieldLock,
  IconSun,
  IconUserPlus,
  IconUsers,
  IconCash,
  IconFileAlert,
  IconClockHour4,
  IconKeyboard,
  IconPrescription,
  IconRosetteDiscountCheck,
} from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { NavLink as RouterNavLink, useLocation, useNavigate } from 'react-router';
import type { Area, PageDef, Role } from '../navigation';
import { AREA_LABELS, PAGES, ROLE_LABELS, canSee, getPage } from '../navigation';
import { IdleTimeout } from '../session/IdleTimeout';
import { useRoles } from '../session/roles';
import { Logo } from './Logo';
import { PatientSpotlight } from './PatientSpotlight';
import { RecentPatients } from './RecentPatients';
import { ShortcutsModal } from './ShortcutsModal';
import classes from './StaffShell.module.css';

const ICONS: Record<string, ReactNode> = {
  P02: <IconHome size={18} stroke={1.7} />,
  P03: <IconInbox size={18} stroke={1.7} />,
  P04: <IconCalendarEvent size={18} stroke={1.7} />,
  P06: <IconClockHour4 size={18} stroke={1.7} />,
  P07: <IconUsers size={18} stroke={1.7} />,
  P08: <IconUserPlus size={18} stroke={1.7} />,
  P21: <IconClipboardText size={18} stroke={1.7} />,
  P23: <IconRosetteDiscountCheck size={18} stroke={1.7} />,
  P25: <IconPrescription size={18} stroke={1.7} />,
  P26: <IconPill size={18} stroke={1.7} />,
  P27: <IconFlask size={18} stroke={1.7} />,
  P28: <IconFileText size={18} stroke={1.7} />,
  P29: <IconListCheck size={18} stroke={1.7} />,
  P30: <IconClipboardCheck size={18} stroke={1.7} />,
  P31: <IconFileInvoice size={18} stroke={1.7} />,
  P32: <IconShieldCheck size={18} stroke={1.7} />,
  P33: <IconCash size={18} stroke={1.7} />,
  P34: <IconFileAlert size={18} stroke={1.7} />,
  P35: <IconReceipt size={18} stroke={1.7} />,
  P36: <IconReportMoney size={18} stroke={1.7} />,
  P37: <IconChartBar size={18} stroke={1.7} />,
  P45: <IconShieldLock size={18} stroke={1.7} />,
};

const AREA_ORDER: Area[] = ['daily', 'patients', 'clinical', 'billing', 'admin'];

export function StaffShell({ children }: { readonly children: ReactNode }): JSX.Element {
  const [mobileOpened, { toggle, close }] = useDisclosure(false);
  const [plannedOpened, { toggle: togglePlanned }] = useDisclosure(false);
  const [shortcutsOpened, shortcuts] = useDisclosure(false);
  const { roles } = useRoles();
  const location = useLocation();
  const navigate = useNavigate();

  // Keyboard navigation. Ignored while typing in a field (Mantine default).
  const go = (id: string): void => {
    const page = getPage(id);
    if (canSee(page, roles)) navigate(page.path);
  };
  useHotkeys([
    ['/', () => spotlight.open()],
    ['alt+T', () => go('P02')],
    ['alt+P', () => go('P07')],
    ['alt+C', () => go('P04')],
    ['alt+N', () => go('P08')],
    ['shift+?', shortcuts.open],
  ]);

  const sections = AREA_ORDER.map((area) => ({
    area,
    pages: PAGES.filter((p) => p.built && p.area === area && p.inSidebar && canSee(p, roles)),
  })).filter((s) => s.pages.length > 0);
  const planned = PAGES.filter((p) => !p.built && p.inSidebar && canSee(p, roles));
  const activePlanned = planned.some((p) => location.pathname.startsWith(p.path));
  const showSettings = roles.includes('admin') || PAGES.some((p) => p.path.startsWith('/settings/') && canSee(p, roles));

  return (
    <AppShell
      layout="alt"
      header={{ height: 60 }}
      navbar={{ width: 248, breakpoint: 'md', collapsed: { mobile: !mobileOpened } }}
      padding={0}
    >
      <AppShell.Header className={classes.header}>
        <div className={classes.headerInner}>
          <Burger opened={mobileOpened} onClick={toggle} hiddenFrom="md" size="sm" aria-label="Toggle navigation" />
          <UnstyledButton
            className={classes.search}
            onClick={() => spotlight.open()}
            aria-label="Search patients (Control K)"
          >
            <IconSearch size={16} stroke={1.8} />
            <span className={classes.searchText}>Search patients<span className={classes.searchDetail}> by name, DOB or phone</span></span>
            <Kbd size="xs" visibleFrom="sm">
              Ctrl K
            </Kbd>
          </UnstyledButton>
          <Group gap={8} ml="auto" wrap="nowrap" className={classes.headerActions}>
            <QuickActions />
            <ColorSchemeToggle />
            <UserMenu onShortcuts={shortcuts.open} />
          </Group>
        </div>
      </AppShell.Header>

      <AppShell.Navbar className={classes.navbar}>
        <AppShell.Section className={classes.brand}>
          <Logo />
        </AppShell.Section>
        <AppShell.Section grow component={ScrollArea} type="never" className={classes.navScroll}>
          <nav aria-label="Main">
            {sections.map(({ area, pages }) => (
              <div key={area} className={classes.section}>
                <Text className={classes.sectionLabel}>{AREA_LABELS[area]}</Text>
                {pages.map((page) => (
                  <SidebarLink key={page.id} page={page} onNavigate={close} />
                ))}
                {area === 'patients' && <RecentPatients onNavigate={close} />}
              </div>
            ))}
            {showSettings && (
              <div className={classes.section}>
                <RouterNavLink
                  to="/settings"
                  onClick={close}
                  className={({ isActive }) =>
                    `${classes.link} ${isActive || location.pathname.startsWith('/settings') ? classes.linkActive : ''}`
                  }
                >
                  <IconSettings size={18} stroke={1.7} />
                  <span className={classes.linkLabel}>Settings</span>
                </RouterNavLink>
              </div>
            )}
            {planned.length > 0 && (
              <div className={classes.section}>
                <UnstyledButton className={classes.plannedToggle} onClick={togglePlanned} aria-expanded={plannedOpened || activePlanned} aria-controls="planned-navigation">
                  <IconClockHour4 size={17} />
                  <span className={classes.linkLabel}>Coming later</span>
                  <IconChevronDown size={14} style={{ transform: plannedOpened || activePlanned ? 'rotate(180deg)' : undefined }} />
                </UnstyledButton>
                <Collapse in={plannedOpened || activePlanned} id="planned-navigation">
                  {planned.map((page) => <SidebarLink key={page.id} page={page} onNavigate={close} />)}
                </Collapse>
              </div>
            )}
          </nav>
        </AppShell.Section>
        <AppShell.Section className={classes.footer}>
          <PreviewBanner />
          <Text size="xs" className={classes.footerText}>
            Synthetic data only · Phases 1–9
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main className={classes.main}>{children}</AppShell.Main>
      <PatientSpotlight />
      <ShortcutsModal opened={shortcutsOpened} onClose={shortcuts.close} />
      <IdleTimeout />
    </AppShell>
  );
}

function SidebarLink({ page, onNavigate }: { readonly page: PageDef; readonly onNavigate: () => void }): JSX.Element {
  const location = useLocation();
  // "Find patient" stays highlighted inside any chart (/patients/:id/...), but not on /patients/new.
  const inChart = page.id === 'P07' && /^\/patients\/(?!new(\/|$))[^/]+/.test(location.pathname);
  return (
    <RouterNavLink
      to={page.path}
      end={page.path === '/patients'}
      onClick={onNavigate}
      className={({ isActive }) => `${classes.link} ${isActive || inChart ? classes.linkActive : ''}`}
    >
      {ICONS[page.id]}
      <span className={classes.linkLabel}>{page.title}</span>
      {!page.built && (
        <Tooltip label={`Planned for Phase ${page.phase}`} position="right">
          <span className={classes.phaseTag} aria-label={`Planned for phase ${page.phase}`}>
            P{page.phase}
          </span>
        </Tooltip>
      )}
    </RouterNavLink>
  );
}

function QuickActions(): JSX.Element | null {
  const navigate = useNavigate();
  const { roles } = useRoles();
  const canRegister = canSee(getPage('P08'), roles);
  if (!canRegister) return null;
  return (
    <Menu position="bottom-end" width={220} shadow="md">
      <Menu.Target>
        <Button size="sm" className={classes.newButton} aria-label="New" leftSection={<IconUserPlus size={16} />} rightSection={<IconChevronDown size={14} />}>
          New
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconUserPlus size={16} />} onClick={() => navigate('/patients/new')}>
          Patient
        </Menu.Item>
        <Menu.Item leftSection={<IconCalendarPlus size={16} />} onClick={() => navigate('/calendar?new=1')}>
          Appointment
        </Menu.Item>
        <Menu.Label>Coming later</Menu.Label>
        <Menu.Item disabled leftSection={<IconMessagePlus size={16} />}>
          Message
        </Menu.Item>
        <Menu.Item disabled leftSection={<IconListCheck size={16} />}>
          Task
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function ColorSchemeToggle(): JSX.Element {
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme('light');
  const next = computed === 'light' ? 'dark' : 'light';
  return (
    <Tooltip label={`Switch to ${next} mode`}>
      <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => setColorScheme(next)} aria-label={`Switch to ${next} mode`}>
        {computed === 'light' ? <IconMoon size={18} stroke={1.7} /> : <IconSun size={18} stroke={1.7} />}
      </ActionIcon>
    </Tooltip>
  );
}

function UserMenu({ onShortcuts }: { readonly onShortcuts: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const { actualRoles, previewRole, setPreviewRole } = useRoles();
  const name = formatHumanName(profile?.name?.[0] as HumanName) || 'Signed in';
  const initials = name
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join('');
  const isAdmin = actualRoles.includes('admin');

  return (
    <Menu position="bottom-end" width={240} shadow="md">
      <Menu.Target>
        <UnstyledButton className={classes.user} aria-label="Account menu">
          <Avatar size={30} radius="xl" color="navy" variant="filled">
            {initials}
          </Avatar>
          <div className={classes.userText}>
            <Text size="sm" fw={600} lh={1.2} truncate>
              {name}
            </Text>
            <Text size="xs" c="dimmed" lh={1.2}>
              {actualRoles.map((r) => ROLE_LABELS[r]).join(', ') || 'No role'}
            </Text>
          </div>
          <IconChevronDown size={14} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {isAdmin && (
          <>
            <Menu.Label>Preview navigation as</Menu.Label>
            {(['provider', 'frontdesk', 'biller'] as Role[]).map((role) => (
              <Menu.Item
                key={role}
                leftSection={<IconEye size={16} />}
                rightSection={previewRole === role ? <Badge size="xs">On</Badge> : undefined}
                onClick={() => setPreviewRole(previewRole === role ? undefined : role)}
              >
                {ROLE_LABELS[role]}
              </Menu.Item>
            ))}
            <Menu.Divider />
          </>
        )}
        <Menu.Item leftSection={<IconSettings size={16} />} onClick={() => navigate('/settings')}>
          Settings
        </Menu.Item>
        <Menu.Item leftSection={<IconKeyboard size={16} />} rightSection={<Kbd size="xs">?</Kbd>} onClick={onShortcuts}>
          Keyboard shortcuts
        </Menu.Item>
        <Menu.Item
          color="red"
          leftSection={<IconLogout size={16} />}
          onClick={() => medplum.signOut().then(() => navigate('/signin'))}
        >
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function PreviewBanner(): JSX.Element | null {
  const { previewRole, setPreviewRole } = useRoles();
  if (!previewRole) {
    return null;
  }
  return (
    <div className={classes.preview}>
      <IconEye size={14} />
      <Text size="xs" fw={600}>
        Previewing as {ROLE_LABELS[previewRole]}
      </Text>
      <UnstyledButton className={classes.previewExit} onClick={() => setPreviewRole(undefined)}>
        Exit
      </UnstyledButton>
    </div>
  );
}

