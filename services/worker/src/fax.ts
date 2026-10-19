// Fax (P28, decision D-fax vendor pending). Vendor-neutral like e-prescribing: inbound faxes arrive
// on the worker webhook (or the synthetic simulator) and outbound faxes are handed to an adapter.
// The default "log" adapter writes to services/worker/outbox.log and sends nothing.
//
// Inbound: the PDF is stored as a Binary on an unfiled DocumentReference (type inbound-fax, no
// patient) with a patient/category suggestion from the vendor OCR text, plus a front-desk review
// Task. Filing to a patient always needs a person to confirm the match (document-rules Bot).

import type { MedplumClient } from '@medplum/core';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { Communication, DocumentReference, Reference, Task } from '@medplum/fhirtypes';
import {
  CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, DOCUMENT_TYPE_SYSTEM, EXT, FAX_REVIEW_SLA_BUSINESS_DAYS, GENERATED_IDENTIFIER_SYSTEM, addBusinessDays,
  parseDates, suggestFax, teamCoding, searchAll,
} from '@teleemon/core';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InboundFax {
  /** Vendor fax id; makes redelivery of the same fax idempotent. */
  readonly id: string;
  readonly from: string;
  readonly to?: string;
  readonly pages: number;
  /** PDF bytes. */
  readonly pdf: Uint8Array;
  /** OCR text supplied by the vendor, if any. */
  readonly text?: string;
  readonly receivedAt?: string;
}

export interface FaxAdapter {
  readonly mode: string;
  send(to: string, pdf: Uint8Array, cover: string, key: string): Promise<{ id: string }>;
}

const OUTBOX = join(dirname(fileURLToPath(import.meta.url)), '..', 'outbox.log');

export class LogFaxAdapter implements FaxAdapter {
  readonly mode = 'log';
  async send(to: string, pdf: Uint8Array, cover: string, key: string): Promise<{ id: string }> {
    if (to.replace(/\D/g, '') === '0000000000') throw new Error('Log fax adapter: the number did not answer'); // 000-000-0000 simulates failure
    mkdirSync(dirname(OUTBOX), { recursive: true });
    const id = `fax-log-${key}`;
    appendFileSync(OUTBOX, `${JSON.stringify({ at: new Date().toISOString(), id, channel: 'fax', to, bytes: pdf.length, cover })}\n`);
    return { id };
  }
}

export function faxAdapterFromEnv(): FaxAdapter {
  const vendor = process.env.FAX_VENDOR ?? 'log';
  if (vendor !== 'log') throw new Error(`Fax vendor "${vendor}" has no adapter yet. Use FAX_VENDOR=log until the vendor integration is built.`);
  return new LogFaxAdapter();
}

/** Stores an inbound fax for review. Returns the existing document when the fax was already received. */
export async function receiveFax(medplum: MedplumClient, fax: InboundFax): Promise<DocumentReference> {
  if (!fax.id?.trim() || !fax.from?.trim() || !Number.isInteger(fax.pages) || fax.pages < 1 || fax.pages > 1000 || fax.pdf.length > 20 * 1024 * 1024 || !new TextDecoder().decode(fax.pdf.slice(0, 5)).startsWith('%PDF-')) throw new Error('A fax requires an ID, sender, page count and a PDF no larger than 20 MB.');
  if (fax.receivedAt && !Number.isFinite(Date.parse(fax.receivedAt))) throw new Error('Invalid fax receipt date.');
  const identifier = { system: `${GENERATED_IDENTIFIER_SYSTEM}/fax`, value: fax.id };
  const existing = await medplum.searchOne('DocumentReference', { identifier: `${identifier.system}|${identifier.value}` }, { cache: 'no-cache' });

  const text = (fax.text ?? '').slice(0, 20000);
  const dates = parseDates(text);
  const candidates = dates.length ? await medplum.searchResources('Patient', { birthdate: dates.join(','), _count: '50' }, { cache: 'no-cache' }) : [];
  const suggestion = suggestFax(text, candidates);
  const received = fax.receivedAt ?? new Date().toISOString();

  let doc = existing ?? await medplum.createResourceIfNoneExist<DocumentReference>({
    resourceType: 'DocumentReference',
    identifier: [identifier],
    status: 'current',
    docStatus: 'preliminary',
    type: { coding: [{ system: DOCUMENT_TYPE_SYSTEM, code: 'inbound-fax', display: 'Received fax' }] },
    date: received,
    description: `Fax from ${fax.from} (${fax.pages} page${fax.pages === 1 ? '' : 's'})`,
    extension: [
      { url: EXT.inboundFrom, valueString: fax.from },
      ...(text ? [{ url: EXT.faxText, valueString: text }] : []),
      { url: EXT.faxSuggestion, valueString: JSON.stringify(suggestion) },
    ],
    content: [{ attachment: { contentType: 'application/pdf', title: `Fax ${fax.from} ${received.slice(0, 10)}` } }],
  }, new URLSearchParams({ identifier: `${identifier.system}|${identifier.value}` }).toString());
  // Retry resumes a partially stored fax rather than returning an empty document forever.
  if (!doc.content[0]?.attachment.url) {
    const attachment = await medplum.createAttachment({ data: new Blob([new Uint8Array(fax.pdf)], { type: 'application/pdf' }), contentType: 'application/pdf', filename: `fax-${fax.id}.pdf`, securityContext: createReference(doc) });
    doc = await medplum.updateResource<DocumentReference>({ ...doc, docStatus: 'final', content: [{ attachment: { ...attachment, title: doc.content[0].attachment.title, size: fax.pdf.length } }] }, { headers: { 'If-Match': `W/"${doc.meta?.versionId}"` } });
  }

  const key = `fax-review-${doc.id}`;
  await medplum.createResourceIfNoneExist<Task>(
    {
      resourceType: 'Task',
      identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: key }],
      status: 'requested',
      intent: 'order',
      priority: 'routine',
      code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'fax-review' }], text: 'File fax' },
      description: `File fax from ${fax.from}`,
      focus: createReference(doc),
      performerType: teamCoding('frontdesk'),
      authoredOn: received,
      restriction: { period: { end: addBusinessDays(new Date(received), FAX_REVIEW_SLA_BUSINESS_DAYS).toISOString() } },
    },
    new URLSearchParams({ identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${key}` }).toString()
  );
  return doc;
}

/** Sends queued outbound faxes (Communication, category fax-outbound, status preparation). */
export async function sendQueuedFaxes(medplum: MedplumClient, adapter: FaxAdapter, only?: (c: Communication) => boolean): Promise<{ sent: number; failed: number }> {
  const report = { sent: 0, failed: 0 };
  const queued = await searchAll(medplum, 'Communication', { status: 'preparation,in-progress', category: `${CODE_SYSTEMS.communicationCategory}|fax-outbound`, _count: '100' });
  for (const listed of only ? queued.filter(only) : queued) {
    let msg = await medplum.readResource('Communication', listed.id!, { cache: 'no-cache' });
    if (!['preparation', 'in-progress'].includes(msg.status)) continue;
    const dispatchAt = `${EXT.faxTo}/dispatch-at`;
    const started = Date.parse(msg.extension?.find((e) => e.url === dispatchAt)?.valueInstant ?? '');
    if (msg.status === 'in-progress' && Date.now() - started < 5 * 60000) continue;
    // Compare-and-swap claim prevents overlapping worker passes from sending the same fax.
    try {
      msg = await medplum.updateResource({ ...msg, status: 'in-progress', extension: [...(msg.extension ?? []).filter((e) => e.url !== dispatchAt), { url: dispatchAt, valueInstant: new Date().toISOString() }] }, { headers: { 'If-Match': `W/"${msg.meta?.versionId}"` } });
    } catch { continue; }
    const to = msg.extension?.find((e) => e.url === EXT.faxTo)?.valueString ?? '';
    try {
      const docRef = msg.payload?.find((p) => p.contentReference)?.contentReference as Reference<DocumentReference> | undefined;
      const doc = docRef ? await medplum.readReference(docRef) : undefined;
      const url = doc?.content?.[0]?.attachment?.url;
      if (!doc || !url) throw new Error('The document to fax has no file');
      if (doc.status !== 'current' || doc.subject?.reference !== msg.subject?.reference) throw new Error('The fax document must be current and belong to the selected patient.');
      if (doc.category?.some((c) => c.coding?.some((x) => x.system === CODE_SYSTEMS.documentCategory && ['private-psychotherapy', 'transcript'].includes(x.code ?? '')))) throw new Error('Private notes and transcripts cannot be faxed through this workflow.');
      const binaryUrl = new URL(url, medplum.getBaseUrl());
      if (binaryUrl.origin !== new URL(medplum.getBaseUrl()).origin || !(/\/Binary\/[A-Za-z0-9.-]+$/.test(binaryUrl.pathname) || binaryUrl.pathname.startsWith('/storage/'))) throw new Error('The fax must use a file hosted by the clinical server.');
      const pdf = new Uint8Array(await (await medplum.download(url)).arrayBuffer());
      if (!new TextDecoder().decode(pdf.slice(0, 5)).startsWith('%PDF-')) throw new Error('Only PDF documents can be faxed; convert this image to PDF first.');
      const cover = msg.payload?.find((p) => p.contentString)?.contentString ?? '';
      const { id } = await adapter.send(to, pdf, cover, msg.id as string);
      await medplum.updateResource<Communication>({ ...msg, status: 'completed', sent: new Date().toISOString(), identifier: [...(msg.identifier ?? []), { system: `${GENERATED_IDENTIFIER_SYSTEM}/fax-out`, value: id }] }, { headers: { 'If-Match': `W/"${msg.meta?.versionId}"` } });
      report.sent++;
    } catch (err) {
      const message = normalizeErrorString(err);
      await medplum.updateResource<Communication>({ ...msg, status: 'stopped', statusReason: { text: message } }).catch(() => undefined);
      const key = `fax-failure-${msg.id}`;
      await medplum.createResourceIfNoneExist<Task>(
        {
          resourceType: 'Task',
          identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: key }],
          status: 'requested',
          intent: 'order',
          priority: 'urgent',
          code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'fax-failure' }], text: 'Fax not sent' },
          description: `Fax to ${to} was not sent: ${message}`,
          for: msg.subject as Task['for'],
          focus: { reference: `Communication/${msg.id}` },
          owner: msg.sender as Task['owner'],
          performerType: teamCoding('frontdesk'),
          authoredOn: new Date().toISOString(),
        },
        new URLSearchParams({ identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${key}` }).toString()
      );
      report.failed++;
    }
  }
  return report;
}

/** A one-page PDF of text lines (synthetic faxes and tests only). */
export function textPdf(lines: string[]): Uint8Array {
  const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');
  const stream = `BT /F1 11 Tf 56 760 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

