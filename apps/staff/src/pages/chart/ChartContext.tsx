import type { Patient } from '@medplum/fhirtypes';
import { createContext, useContext } from 'react';

export interface ChartContextValue {
  readonly patient: Patient;
  /** Re-reads the patient and the header facts after an edit. */
  readonly refresh: () => void;
}

export const ChartContext = createContext<ChartContextValue | undefined>(undefined);

export function useChart(): ChartContextValue {
  const ctx = useContext(ChartContext);
  if (!ctx) throw new Error('useChart must be used inside the patient chart');
  return ctx;
}
