// E-signed consents (X02). The service records the exact document version and a hash of its text,
// who signed (the signed-in patient or proxy), the typed name and the time, so a signature cannot be
// back-dated or attached to different wording.

import type { MedplumClient } from '@medplum/core';
import type { Consent } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, CONSENT_TYPES, EXT, findConsentDocument, signedPortalConsent } from '@teleemon/core';
import { createHash } from 'node:crypto';
import { HttpError, badRequest } from './http';
import type { PortalSession } from './session';

export async function signConsent(service: MedplumClient, session: PortalSession, body: { type?: string; version?: string; signature?: string; agree?: boolean }, now = new Date()): Promise<Consent> {
  const doc = findConsentDocument(body.type ?? '', body.version);
  if (!doc) throw badRequest('This consent has been updated. Reload the page to read the current version.', 'consent-version');
  if (session.access === 'limited' && !doc.proxyLimitedMaySign) {
    throw new HttpError(403, `Because of ${session.patient.name?.[0]?.given?.[0] ?? 'the patient'}'s age, they sign this consent themselves.`);
  }
  const typed = body.signature?.trim().replace(/\s+/g, ' ') ?? '';
  if (body.agree !== true || typed.length < 2 || typed.length > 120) throw badRequest('Tick the box and type your full name to sign.');

  const existing = await service.searchResources('Consent', { patient: session.patientRef, _count: '100' }, { cache: 'no-cache' });
  const current = signedPortalConsent(existing, doc);
  if (current) return current;

  const display = CONSENT_TYPES.find((t) => t.code === doc.type)?.display ?? doc.title;
  const hash = createHash('sha256').update(doc.body, 'utf8').digest('hex');
  return service.createResource<Consent>({
    resourceType: 'Consent',
    status: 'active',
    scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: doc.type === 'privacy-notice' ? 'patient-privacy' : 'treatment' }] },
    category: [{ coding: [{ system: CODE_SYSTEMS.consentType, code: doc.type, display }] }],
    patient: { reference: session.patientRef },
    dateTime: now.toISOString(),
    performer: [{ reference: session.actor, display: `${typed} (typed signature${session.access === 'self' ? '' : ', parent or guardian'})` }],
    policyRule: { text: `Teleemon ${doc.title}, ${doc.version}` },
    sourceAttachment: { contentType: 'text/plain', title: `${doc.title} (${doc.version})`, data: Buffer.from(doc.body, 'utf8').toString('base64'), hash: createHash('sha1').update(doc.body, 'utf8').digest('base64'), creation: now.toISOString() },
    provision: { type: 'permit', period: { start: now.toISOString() } },
    extension: [
      { url: EXT.consentMethod, valueCode: 'portal-esignature' },
      { url: EXT.consentDocument, valueString: doc.version },
      { url: EXT.consentTextHash, valueString: hash },
    ],
  });
}
