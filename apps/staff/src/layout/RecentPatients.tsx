import { Avatar, Text } from '@mantine/core';
import type { Patient } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { NavLink, useLocation } from 'react-router';
import { patientName } from '../fhir/patient';
import { recentPatientIds } from '../fhir/patientSearch';
import { useLoader } from '../hooks/useLoader';
import classes from './StaffShell.module.css';

const SHOWN = 4;

/** The last few charts opened on this device, for one-click return. Opaque IDs only in storage. */
export function RecentPatients({ onNavigate }: { readonly onNavigate: () => void }): JSX.Element | null {
  const medplum = useMedplum();
  const location = useLocation();
  const ids = recentPatientIds().slice(0, SHOWN);
  const key = ids.join(',');
  const patients = useLoader<Patient[]>(
    async () => {
      if (!key) return [];
      const list = await medplum.searchResources('Patient', { _id: key, _count: String(SHOWN) }).catch(() => []);
      return list.sort((a, b) => ids.indexOf(a.id as string) - ids.indexOf(b.id as string));
    },
    // Re-read when a different chart is opened (the ID list changes).
    [key, medplum]
  );
  const list = patients.data ?? [];
  if (list.length === 0) return null;

  return (
    <div className={classes.recent}>
      <Text className={classes.recentLabel}>Recent</Text>
      {list.map((p) => {
        const active = location.pathname.startsWith(`/patients/${p.id}`);
        const initials = `${p.name?.[0]?.given?.[0]?.[0] ?? ''}${p.name?.[0]?.family?.[0] ?? ''}`;
        return (
          <NavLink key={p.id} to={`/patients/${p.id}`} onClick={onNavigate} className={`${classes.recentLink} ${active ? classes.recentActive : ''}`}>
            <Avatar size={20} radius="xl" color="brand" variant={active ? 'filled' : 'light'}>
              <span style={{ fontSize: 9 }}>{initials}</span>
            </Avatar>
            <span className={classes.linkLabel}>{patientName(p)}</span>
          </NavLink>
        );
      })}
    </div>
  );
}
