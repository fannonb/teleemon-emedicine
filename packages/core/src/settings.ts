// Practice settings stored as one Basic resource per settings group (P38, P42). Read by the staff
// app, Bots and the worker, so a change in Settings applies everywhere without a deploy.

import type { MedplumClient } from '@medplum/core';
import type { Basic } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, EXT } from './fhir';
import type { Hours } from './scheduling';
import { DEFAULT_HOURS } from './scheduling';
import type { MessagingSettings } from './reminders';
import type { SectionKey, TemplateCode } from './notes';
import { DEFAULT_MESSAGING } from './reminders';
import type { BillingSettings } from './billing';
import { DEFAULT_BILLING } from './billing';

export interface PracticeSettings {
  readonly hours: Hours;
  /** Practice closed (holidays), YYYY-MM-DD with a label. */
  readonly closures: { date: string; label: string }[];
}

export const DEFAULT_PRACTICE: PracticeSettings = { hours: DEFAULT_HOURS, closures: [] };

/** Note templates and smart phrases (P41). Changes apply to new notes only: notes copy text when created. */
export interface TemplateSettings {
  readonly phrases: { trigger: string; text: string }[];
  /** Per-template default text by section, overriding the built-in defaults. */
  readonly defaults: Partial<Record<TemplateCode, Partial<Record<SectionKey, string>>>>;
}

export const DEFAULT_TEMPLATES: TemplateSettings = {
  phrases: [
    { trigger: '.cc-fu', text: 'Follow-up for medication management.' },
    { trigger: '.ros-neg', text: 'Denies changes in sleep, appetite, energy or concentration. No manic or psychotic symptoms reported.' },
    { trigger: '.sub-none', text: 'Denies alcohol, cannabis, tobacco or other substance use.' },
    { trigger: '.plan-cont', text: 'Continue current medications at current doses. Reviewed benefits, risks and side effects; patient agrees with plan.' },
    { trigger: '.fu4', text: 'Return in 4 weeks, sooner if needed.' },
    { trigger: '.crisis', text: 'Crisis resources reviewed: call or text 988, call 911 or go to the nearest emergency department if in danger.' },
  ],
  defaults: {},
};

export interface SettingsMap {
  readonly messaging: MessagingSettings;
  readonly practice: PracticeSettings;
  readonly templates: TemplateSettings;
  /** Payers, fee schedule, billing policy and scrub rules (P40). */
  readonly billing: BillingSettings;
}

const DEFAULTS: SettingsMap = { messaging: DEFAULT_MESSAGING, practice: DEFAULT_PRACTICE, templates: DEFAULT_TEMPLATES, billing: DEFAULT_BILLING };

export async function readSettings<K extends keyof SettingsMap>(medplum: MedplumClient, key: K): Promise<SettingsMap[K]> {
  return (await readSettingsSnapshot(medplum, key)).value;
}

export interface SettingsSnapshot<K extends keyof SettingsMap> {
  readonly value: SettingsMap[K];
  readonly resource: Basic | null;
}

/** Keep the version the editor actually loaded, not a newer version fetched while saving. */
export async function readSettingsSnapshot<K extends keyof SettingsMap>(medplum: MedplumClient, key: K): Promise<SettingsSnapshot<K>> {
  const basic = await medplum.searchOne('Basic', { identifier: `${CODE_SYSTEMS.settings}|${key}` }, { cache: 'no-cache' });
  const json = basic?.extension?.find((e) => e.url === EXT.settingsJson)?.valueString;
  return { value: json ? { ...DEFAULTS[key], ...(JSON.parse(json) as Partial<SettingsMap[K]>) } : DEFAULTS[key], resource: basic ?? null };
}

export async function writeSettings<K extends keyof SettingsMap>(medplum: MedplumClient, key: K, value: SettingsMap[K], expected?: Basic | null): Promise<Basic> {
  const existing = expected === undefined ? await medplum.searchOne('Basic', { identifier: `${CODE_SYSTEMS.settings}|${key}` }, { cache: 'no-cache' }) : expected;
  const resource: Basic = {
    resourceType: 'Basic',
    identifier: [{ system: CODE_SYSTEMS.settings, value: key }],
    code: { coding: [{ system: CODE_SYSTEMS.settings, code: key }], text: `Teleemon ${key} settings` },
    extension: [{ url: EXT.settingsJson, valueString: JSON.stringify(value) }],
  };
  if (existing) {
    if (!existing.meta?.versionId) throw new Error('Settings version is missing. Reload before saving.');
    return medplum.updateResource({ ...existing, ...resource }, { headers: { 'If-Match': `W/"${existing.meta.versionId}"` } });
  }
  const created = await medplum.createResourceIfNoneExist(resource, new URLSearchParams({ identifier: `${CODE_SYSTEMS.settings}|${key}` }).toString());
  if (created.extension?.find((e) => e.url === EXT.settingsJson)?.valueString !== JSON.stringify(value)) throw new Error('Another person saved these settings. Reload and review their changes before saving.');
  return created;
}
