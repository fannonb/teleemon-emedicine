import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import { Notifications } from '@mantine/notifications';
import '@mantine/notifications/styles.css';
import '@mantine/spotlight/styles.css';
import { MedplumClient } from '@medplum/core';
import { MedplumProvider } from '@medplum/react';
import '@medplum/react/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { App } from './App';
import { RoleProvider } from './session/roles';
import './styles/global.css';
import { theme } from './theme';

const medplum = new MedplumClient({
  baseUrl: import.meta.env.MEDPLUM_BASE_URL || undefined,
  clientId: import.meta.env.MEDPLUM_CLIENT_ID || undefined,
  onUnauthenticated: () => {
    if (window.location.pathname !== '/signin') {
      window.location.assign('/signin');
    }
  },
  cacheTime: 30000,
  autoBatchTime: 100,
});

const router = createBrowserRouter([{ path: '*', element: <App /> }]);

createRoot(document.getElementById('root') as HTMLDivElement).render(
  <StrictMode>
    <MedplumProvider medplum={medplum} navigate={(path) => router.navigate(path)}>
      <MantineProvider theme={theme} defaultColorScheme="light">
        <Notifications position="bottom-right" />
        <RoleProvider>
          <RouterProvider router={router} />
        </RoleProvider>
      </MantineProvider>
    </MedplumProvider>
  </StrictMode>
);
