import { MantineProvider, localStorageColorSchemeManager } from '@mantine/core';
import '@mantine/core/styles.css';
import { Notifications } from '@mantine/notifications';
import '@mantine/notifications/styles.css';
import { MedplumClient } from '@medplum/core';
import { MedplumProvider } from '@medplum/react-hooks';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { App } from './App';
import { PortalSessionProvider } from './session';
import './styles.css';
import { theme } from './theme';

// The portal signs in through its own public ClientApplication (ADR-012), never the staff client.
const medplum = new MedplumClient({
  baseUrl: import.meta.env.MEDPLUM_BASE_URL || undefined,
  clientId: import.meta.env.MEDPLUM_CLIENT_ID || undefined,
  cacheTime: 10000,
});

const router = createBrowserRouter([{ path: '*', element: <App /> }]);

createRoot(document.getElementById('root') as HTMLDivElement).render(
  <StrictMode>
    <MedplumProvider medplum={medplum} navigate={(path) => router.navigate(path)}>
      <MantineProvider theme={theme} defaultColorScheme="light" colorSchemeManager={localStorageColorSchemeManager({ key: 'teleemon-portal-color-scheme' })}>
        <Notifications position="top-center" />
        <PortalSessionProvider>
          <RouterProvider router={router} />
        </PortalSessionProvider>
      </MantineProvider>
    </MedplumProvider>
  </StrictMode>
);
