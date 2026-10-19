// Letter templates for the Documents tab (P17): school note, work note and records-release
// authorization. The text is a starting point the user edits; the saved letter is stored in the
// chart as a document (and so is audited like any other file) and opened for printing.
// School and work notes never state a diagnosis: they only confirm care and dates.

import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Organization, Patient } from '@medplum/fhirtypes';
import type { DocumentCategoryCode } from '@teleemon/core';
import { PRACTICE_ORG_TYPE } from '@teleemon/core';
import { uploadDocument } from '../../fhir/documents';

export type LetterKind = 'school' | 'work' | 'records-release';

export const LETTER_TEMPLATES: { kind: LetterKind; label: string; category: DocumentCategoryCode }[] = [
  { kind: 'school', label: 'School note', category: 'school-work' },
  { kind: 'work', label: 'Work note', category: 'school-work' },
  { kind: 'records-release', label: 'Records release authorization', category: 'letter' },
];

const personName = (p: Patient | undefined): string => [p?.name?.[0]?.given?.join(' '), p?.name?.[0]?.family].filter(Boolean).join(' ');

/** The editable starting text for a template. Dates are filled in; nothing clinical is added. */
export function letterText(kind: LetterKind, patient: Patient, signer: string, today: string): string {
  const name = personName(patient) || 'The patient';
  switch (kind) {
    case 'school':
      return `To whom it may concern,\n\n${name} (date of birth ${patient.birthDate ?? '—'}) is under our care and had an appointment on ${today}. Please excuse their absence for this appointment.\n\nThey may return to school on [date]. Please contact our office with any questions.\n\nSincerely,\n${signer}`;
    case 'work':
      return `To whom it may concern,\n\n${name} is under our care and had an appointment on ${today}. Please excuse their absence from work for this appointment.\n\nThey may return to work on [date]. No further details are shared without the patient's written permission.\n\nSincerely,\n${signer}`;
    case 'records-release':
      return `Authorization to release health information\n\nI, ${name} (date of birth ${patient.birthDate ?? '—'}), authorize Teleemon Behavioral Health to release my records to:\n\nName: [recipient]\nAddress or fax: [address or fax]\n\nRecords to release: [for example, visit notes from date to date]\nPurpose: [for example, continuity of care]\nThis authorization expires on: [date]\n\nI understand I may revoke this authorization in writing at any time, except for records already released. Psychotherapy notes are not included unless I list them separately.\n\nPatient or legal representative signature: ____________________   Date: __________`;
  }
}

function letterHtml(org: Organization | undefined, today: string, body: string): string {
  const esc = (s: string | undefined): string => (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  const a = org?.address?.[0];
  const addr = a ? [a.line?.join(', '), [a.city, a.state, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).map(esc).join('<br>') : '';
  const paras = body.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Letter</title><style>body{font-family:Arial,sans-serif;max-width:680px;margin:40px auto;color:#111;font-size:14px;line-height:1.5}.head{border-bottom:2px solid #1f2d5c;padding-bottom:12px;margin-bottom:28px}.org{font-size:18px;font-weight:bold;color:#1f2d5c}</style></head><body><div class="head"><div class="org">${esc(org?.name ?? 'Teleemon Behavioral Health')}</div><div>${addr}</div></div><p>${esc(today)}</p>${paras}<script>window.onload=function(){window.print()}</script></body></html>`;
}

/** Saves the letter to the patient's chart as a document and returns it. */
export async function saveLetter(medplum: MedplumClient, patient: Patient, kind: LetterKind, body: string): Promise<{ doc: DocumentReference; html: string }> {
  const template = LETTER_TEMPLATES.find((t) => t.kind === kind) ?? LETTER_TEMPLATES[0];
  const org = (await medplum.searchOne('Organization', { type: PRACTICE_ORG_TYPE, active: 'true' })) ?? undefined;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const html = letterHtml(org, today, body);
  const file = new File([html], `${template.label.toLowerCase().replace(/\s+/g, '-')}.html`, { type: 'text/html' });
  const doc = await uploadDocument(medplum, { patient, file, category: template.category, title: template.label });
  return { doc, html };
}
