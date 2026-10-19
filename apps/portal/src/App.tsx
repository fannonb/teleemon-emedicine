import { Center, Loader } from '@mantine/core';
import type { JSX, ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { Shell } from './components/Shell';
import { ActivatePage } from './pages/ActivatePage';
import { AppointmentsPage } from './pages/AppointmentsPage';
import { BookPage } from './pages/BookPage';
import { BillingPage } from './pages/BillingPage';
import { BookVisitPage } from './pages/BookVisitPage';
import { CheckInPage } from './pages/CheckInPage';
import { HomePage } from './pages/HomePage';
import { IntakePage } from './pages/IntakePage';
import { LandingPage } from './pages/LandingPage';
import { MessagesPage } from './pages/MessagesPage';
import { ProfilePage } from './pages/ProfilePage';
import { RefillsPage } from './pages/RefillsPage';
import { RegisterPage } from './pages/RegisterPage';
import { SignInPage } from './pages/SignInPage';
import { SummariesPage } from './pages/SummariesPage';
import { useSession } from './session';

function SignedIn({ children, clinical }: { readonly children: ReactNode; readonly clinical?: boolean }): JSX.Element {
  const { me, loading } = useSession();
  const location = useLocation();
  if (loading && !me) return <Center h={240}><Loader /></Center>;
  if (!me) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname)}`} replace />;
  // Limited proxies have no access to clinical pages; the server refuses those reads as well.
  if (clinical && me.access === 'limited') return <Navigate to="/home" replace />;
  return <>{children}</>;
}

export function App(): JSX.Element {
  const { me } = useSession();
  return (
    <Shell>
      <Routes>
        <Route path="/" element={me ? <Navigate to="/home" replace /> : <LandingPage />} />
        <Route path="/book" element={<BookPage />} />
        <Route path="/register" element={me ? <Navigate to="/home" replace /> : <RegisterPage />} />
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/activate" element={<ActivatePage />} />
        <Route path="/home" element={<SignedIn><HomePage /></SignedIn>} />
        <Route path="/appointments" element={<SignedIn><AppointmentsPage /></SignedIn>} />
        <Route path="/appointments/new" element={<SignedIn><BookVisitPage /></SignedIn>} />
        <Route path="/visit/:id" element={<SignedIn><CheckInPage /></SignedIn>} />
        <Route path="/intake" element={<SignedIn clinical><IntakePage /></SignedIn>} />
        <Route path="/messages" element={<SignedIn clinical><MessagesPage /></SignedIn>} />
        <Route path="/summaries" element={<SignedIn clinical><SummariesPage /></SignedIn>} />
        <Route path="/refills" element={<SignedIn clinical><RefillsPage /></SignedIn>} />
        <Route path="/billing" element={<SignedIn clinical><BillingPage /></SignedIn>} />
        <Route path="/profile" element={<SignedIn><ProfilePage /></SignedIn>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
