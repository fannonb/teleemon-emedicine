import { Button, Center, Loader } from '@mantine/core';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconLock, IconMapQuestion } from '@tabler/icons-react';
import type { ComponentType, JSX, ReactNode } from 'react';
import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { PageBody } from './components/PageHeader';
import { EmptyState } from './components/states';
import { StaffShell } from './layout/StaffShell';
import type { PageDef } from './navigation';
import { PAGES, canSee, getPage } from './navigation';
import { PlannedPage } from './pages/PlannedPage';
import { SettingsPage } from './pages/SettingsPage';
import { SignInPage } from './pages/SignInPage';
import { TodayPage } from './pages/today/TodayPage';
import { useRoles } from './session/roles';

// Pages load on demand so the first screen stays fast.
const named = <K extends string>(loader: () => Promise<Record<K, unknown>>, name: K): ComponentType =>
  lazy(async () => ({ default: (await loader())[name] as ComponentType }));

const PatientSearchPage = named(() => import('./pages/patients/PatientSearchPage'), 'PatientSearchPage');
const RegistrationPage = named(() => import('./pages/patients/RegistrationPage'), 'RegistrationPage');
const UsersPage = named(() => import('./pages/settings/UsersPage'), 'UsersPage');
const CalendarPage = named(() => import('./pages/calendar/CalendarPage'), 'CalendarPage');
const ProviderLicensurePage = named(() => import('./pages/settings/ProviderLicensurePage'), 'ProviderLicensurePage');
const PracticePage = named(() => import('./pages/settings/PracticePage'), 'PracticePage');
const MessagingPage = named(() => import('./pages/settings/MessagingPage'), 'MessagingPage');
const TemplatesPage = named(() => import('./pages/settings/TemplatesPage'), 'TemplatesPage');
const EncountersPage = named(() => import('./pages/encounters/EncountersPage'), 'EncountersPage');
const EncounterWorkspacePage = named(() => import('./pages/encounters/EncounterWorkspacePage'), 'EncounterWorkspacePage');
const NotePage = named(() => import('./pages/encounters/NotePage'), 'NotePage');
const NotesToSignPage = named(() => import('./pages/encounters/NotesToSignPage'), 'NotesToSignPage');
const ErxPage = named(() => import('./prescribing/ErxPage'), 'ErxPage');
const InboxPage = named(() => import('./inbox/InboxPage'), 'InboxPage');
const TasksPage = named(() => import('./inbox/TasksPage'), 'TasksPage');
const FaxCenterPage = named(() => import('./inbox/FaxCenterPage'), 'FaxCenterPage');
const LabsTab = named(() => import('./pages/chart/LabsTab'), 'LabsTab');
const RefillsPage = named(() => import('./prescribing/RefillsPage'), 'RefillsPage');
/** P24 lives on each signed note; its own URL lists visits to choose from. */
const ExportHome = (): JSX.Element => <Navigate to="/encounters" replace />;
/** P05 is the booking drawer on the calendar; its own URL opens it. */
const NewAppointment = (): JSX.Element => <Navigate to="/calendar?new=1" replace />;
const ChartLayout = named(() => import('./pages/chart/ChartLayout'), 'ChartLayout');
const OverviewTab = named(() => import('./pages/chart/OverviewTab'), 'OverviewTab');
const DemographicsTab = named(() => import('./pages/chart/DemographicsTab'), 'DemographicsTab');
const InsuranceTab = named(() => import('./pages/chart/InsuranceTab'), 'InsuranceTab');
const ConsentsTab = named(() => import('./pages/chart/ConsentsTab'), 'ConsentsTab');
const ProblemsTab = named(() => import('./pages/chart/ProblemsTab'), 'ProblemsTab');
const MedicationsTab = named(() => import('./pages/chart/MedicationsTab'), 'MedicationsTab');
const MeasuresTab = named(() => import('./pages/chart/MeasuresTab'), 'MeasuresTab');
const DocumentsTab = named(() => import('./pages/chart/DocumentsTab'), 'DocumentsTab');
const EncountersTab = named(() => import('./pages/chart/EncountersTab'), 'EncountersTab');
const CommunicationsTab = named(() => import('./pages/chart/CommunicationsTab'), 'CommunicationsTab');
const AccountTab = named(() => import('./pages/chart/AccountTab'), 'AccountTab');
const ChargeReviewPage = named(() => import('./billing/ChargeReviewPage'), 'ChargeReviewPage');
const PayersPage = named(() => import('./pages/settings/PayersPage'), 'PayersPage');
const ClaimsPage = named(() => import('./billing/ClaimsPage'), 'ClaimsPage');
const EligibilityPage = named(() => import('./billing/EligibilityPage'), 'EligibilityPage');
const RemittancePage = named(() => import('./billing/RemittancePage'), 'RemittancePage');
const DenialsPage = named(() => import('./billing/DenialsPage'), 'DenialsPage');
const StatementsPage = named(() => import('./billing/StatementsPage'), 'StatementsPage');
const ArPage = named(() => import('./billing/ArPage'), 'ArPage');
const ReportsPage = named(() => import('./pages/phase9/ReportsPage'), 'ReportsPage');
const WaitlistPage = named(() => import('./pages/phase9/WaitlistPage'), 'WaitlistPage');
const AuditPage = named(() => import('./pages/phase9/AuditPage'), 'AuditPage');
const IntegrationsPage = named(() => import('./pages/phase9/IntegrationsPage'), 'IntegrationsPage');
const LabsQueuePage = named(() => import('./pages/phase9/LabsQueuePage'), 'LabsQueuePage');

/** Built standalone pages, by page ID. A phase delivers a page by adding it here and setting `built: true`. */
const BUILT: Record<string, ComponentType> = {
  P06: WaitlistPage,
  P27: LabsQueuePage,
  P37: ReportsPage,
  P44: IntegrationsPage,
  P45: AuditPage,
  P02: TodayPage,
  P07: PatientSearchPage,
  P04: CalendarPage,
  P05: NewAppointment,
  P08: RegistrationPage,
  P21: EncountersPage,
  P23: NotesToSignPage,
  P24: ExportHome,
  P03: InboxPage,
  P25: ErxPage,
  P28: FaxCenterPage,
  P29: TasksPage,
  P26: RefillsPage,
  P30: ChargeReviewPage,
  P31: ClaimsPage,
  P32: EligibilityPage,
  P33: RemittancePage,
  P34: DenialsPage,
  P35: StatementsPage,
  P36: ArPage,
  P40: PayersPage,
  P41: TemplatesPage,
  P38: PracticePage,
  P39: ProviderLicensurePage,
  P42: MessagingPage,
  P43: UsersPage,
};

/** Chart sections (P09–P20) by route segment. */
const CHART: { id: string; segment: string; element: JSX.Element }[] = [
  { id: 'P09', segment: '', element: <OverviewTab /> },
  { id: 'P10', segment: 'demographics', element: <DemographicsTab /> },
  { id: 'P11', segment: 'insurance', element: <InsuranceTab /> },
  { id: 'P12', segment: 'consents', element: <ConsentsTab /> },
  { id: 'P13', segment: 'problems', element: <ProblemsTab /> },
  { id: 'P14', segment: 'medications', element: <MedicationsTab /> },
  { id: 'P15', segment: 'measures', element: <MeasuresTab /> },
  { id: 'P16', segment: 'labs', element: <LabsTab /> },
  { id: 'P17', segment: 'documents', element: <DocumentsTab /> },
  { id: 'P18', segment: 'encounters', element: <EncountersTab /> },
  { id: 'P19', segment: 'account', element: <AccountTab /> },
  { id: 'P20', segment: 'communications', element: <CommunicationsTab /> },
];

const pageLoader = (
  <Center h="50vh">
    <Loader color="brand" />
  </Center>
);

export function App(): JSX.Element | null {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const location = useLocation();

  if (medplum.isLoading()) {
    return (
      <Center h="100dvh">
        <Loader color="brand" />
      </Center>
    );
  }

  if (!profile) {
    return (
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route path="*" element={<Navigate to="/signin" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  const standalonePages = PAGES.filter((p) => !p.path.includes(':') && p.id !== 'P01');

  return (
    <StaffShell>
      <Suspense fallback={pageLoader}>
        <Routes>
          <Route path="/" element={<Navigate to="/today" replace />} />
          <Route path="/signin" element={<Navigate to="/today" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          {standalonePages.map((page) => (
            <Route key={page.id} path={page.path} element={<Guarded page={page} />} />
          ))}
          <Route path="/encounters/:encounterId" element={<Guarded page={getPage('P21')} element={<EncounterWorkspacePage />} />} />
          <Route path="/encounters/:encounterId/note" element={<Guarded page={getPage('P23')} element={<NotePage />} />} />
          <Route path="/encounters/session" element={<Navigate to="/encounters" replace />} />
          <Route path="/patients/:patientId" element={<ChartLayout />}>
            {CHART.map((c) =>
              c.segment ? (
                <Route key={c.id} path={c.segment} element={<ChartGuarded id={c.id}>{c.element}</ChartGuarded>} />
              ) : (
                <Route key={c.id} index element={<ChartGuarded id={c.id}>{c.element}</ChartGuarded>} />
              )
            )}
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </StaffShell>
  );
}

function Guarded({ page, element }: { readonly page: PageDef; readonly element?: JSX.Element }): JSX.Element {
  const { roles, loading, error } = useRoles();
  if (loading) return pageLoader;
  if (error) return <Centered><EmptyState icon={<IconLock size={22} />} title="Access unavailable">{error}</EmptyState></Centered>;
  if (!canSee(page, roles)) {
    return <NoAccess />;
  }
  if (element) return element;
  const Built = page.built ? BUILT[page.id] : undefined;
  return Built ? <Built /> : <PlannedPage page={page} />;
}

function ChartGuarded({ id, children }: { readonly id: string; readonly children: ReactNode }): JSX.Element {
  const { roles, loading, error } = useRoles();
  if (loading) return pageLoader;
  if (error) return <Centered><EmptyState icon={<IconLock size={22} />} title="Access unavailable">{error}</EmptyState></Centered>;
  return canSee(getPage(id), roles) ? <Suspense fallback={pageLoader}>{children}</Suspense> : <NoAccess />;
}

function NoAccess(): JSX.Element {
  return (
    <Centered>
      <EmptyState icon={<IconLock size={22} />} title="Your role doesn't include this page">
        Ask a practice administrator if you need access. Every access request is logged.
      </EmptyState>
    </Centered>
  );
}

function NotFound(): JSX.Element {
  const navigate = useNavigate();
  return (
    <Centered>
      <EmptyState
        icon={<IconMapQuestion size={22} />}
        title="Page not found"
        action={
          <Button mt="sm" variant="light" onClick={() => navigate('/today')}>
            Back to {getPage('P02').title}
          </Button>
        }
      >
        The link may be out of date.
      </EmptyState>
    </Centered>
  );
}

function Centered({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <PageBody>
      <Center mih="60vh">{children}</Center>
    </PageBody>
  );
}
