import { AlignmentType, BorderStyle, Document, Footer, Header, Packer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { NoteData, RenderedSection, SectionKey } from '@teleemon/core';
import { afterVisitSummary } from '@teleemon/core';

// Word (.docx) and print (PDF) exports of a signed note (P24). Generated in the browser so PHI
// never passes through another service. Private psychotherapy notes are never included.

export type ExportKind = 'full' | 'summary' | 'avs';

export const EXPORT_LABELS: Record<ExportKind, string> = {
  full: 'Full clinical note',
  summary: 'Session summary',
  avs: 'After-visit summary (patient copy)',
};

export interface ExportInput {
  readonly practice: { name: string; address?: string; phone?: string; fax?: string };
  readonly patient: { name: string; firstName: string; dob: string; mrn?: string };
  readonly visit: { date: string; time: string; type: string; modality: string; state: string };
  readonly provider: { name: string; credentials?: string };
  readonly note: NoteData;
  readonly sections: RenderedSection[];
  readonly medications: string[];
  readonly signed?: { at: string; by: string; late?: boolean };
  readonly amendments: { title: string; text: string; reason: string; at: string }[];
}

const NAVY = '1E3A5F';
const MUTED = '5B6B80';

const SUMMARY_ORDER: { title: string; keys: SectionKey[] }[] = [
  { title: 'Reason for visit and interval history', keys: ['chiefComplaint', 'intervalHistory'] },
  { title: 'Mental status examination', keys: ['mse'] },
  { title: 'Measures', keys: ['measures'] },
  { title: 'Risk assessment', keys: ['risk'] },
  { title: 'Assessment and diagnoses', keys: ['assessment', 'diagnoses'] },
  { title: 'Plan', keys: ['plan', 'followUp'] },
  { title: 'Psychotherapy', keys: ['psychotherapy'] },
];

interface Block {
  readonly title: string;
  readonly text: string;
}

/** The ordered text blocks for an export kind. The same blocks feed Word and print. */
export function exportBlocks(input: ExportInput, kind: ExportKind): Block[] {
  if (kind === 'avs') {
    const avs = afterVisitSummary(input.note, { firstName: input.patient.firstName, visitDate: input.visit.date, provider: input.provider.name });
    return avs.paragraphs.map((p) => ({ title: p.title, text: p.text }));
  }
  const byKey = new Map(input.sections.map((s) => [s.key, s]));
  const meds = { title: 'Current medications', text: input.medications.length ? input.medications.join('\n') : 'No active medications recorded.' };
  if (kind === 'summary') {
    const blocks: Block[] = [];
    SUMMARY_ORDER.forEach((g, i) => {
      const text = g.keys.map((k) => byKey.get(k)?.text).filter(Boolean).join('\n\n');
      if (text) blocks.push({ title: g.title, text });
      if (i === 0) blocks.push(meds);
    });
    return blocks;
  }
  return [...input.sections.map((s) => ({ title: s.title, text: s.text })), meds];
}

function attestation(input: ExportInput): string {
  if (!input.signed) return 'Draft: not signed.';
  const ai = input.note.aiAssisted ? ' AI-assisted documentation, reviewed and edited by the provider.' : '';
  return `Electronically signed by ${input.signed.by} on ${input.signed.at}.${input.signed.late ? ' Late entry.' : ''}${ai}`;
}

function textRuns(text: string, opts: { size?: number; color?: string; bold?: boolean } = {}): TextRun[] {
  return text.split('\n').map((line, i) => new TextRun({ text: line, break: i > 0 ? 1 : undefined, size: opts.size ?? 21, color: opts.color, bold: opts.bold }));
}

function infoTable(rows: [string, string][]): Table {
  const cell = (text: string, label: boolean): TableCell =>
    new TableCell({
      width: { size: label ? 25 : 75, type: WidthType.PERCENTAGE },
      borders: { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.SINGLE, size: 2, color: 'E3E8EF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } },
      children: [new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text, size: 19, bold: label, color: label ? MUTED : undefined })] })],
    });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: rows.map(([k, v]) => new TableRow({ children: [cell(k, true), cell(v, false)] })) });
}

export function buildDocx(input: ExportInput, kind: ExportKind): Document {
  const isAvs = kind === 'avs';
  const header = new Header({
    children: [
      new Paragraph({ children: [new TextRun({ text: input.practice.name, bold: true, size: 24, color: NAVY })] }),
      new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: '2A9D8F', space: 4 } },
        children: [new TextRun({ text: [input.practice.address, input.practice.phone && `Phone ${input.practice.phone}`, input.practice.fax && `Fax ${input.practice.fax}`].filter(Boolean).join(' · '), size: 17, color: MUTED })],
      }),
    ],
  });
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: isAvs ? 'In a crisis call or text 988, or call 911. ' : 'Confidential health information. Redisclosure may be prohibited by law. ', size: 15, color: MUTED }),
          new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 15, color: MUTED }),
        ],
      }),
    ],
  });

  const details: [string, string][] = isAvs
    ? [
        ['Patient', input.patient.name],
        ['Visit', `${input.visit.date} at ${input.visit.time}`],
        ['Clinician', [input.provider.name, input.provider.credentials].filter(Boolean).join(', ')],
      ]
    : [
        ['Patient', input.patient.name],
        ['Date of birth', input.patient.dob],
        ...(input.patient.mrn ? ([['Chart number', input.patient.mrn]] as [string, string][]) : []),
        ['Visit', `${input.visit.date} at ${input.visit.time} · ${input.visit.type}`],
        ['Provider', [input.provider.name, input.provider.credentials].filter(Boolean).join(', ')],
        ['Patient location', `${input.visit.state} (at time of visit)`],
        ['Modality', input.visit.modality],
      ];

  const body: (Paragraph | Table)[] = [
    new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: EXPORT_LABELS[kind], bold: true, size: 32, color: NAVY })] }),
    infoTable(details),
  ];
  for (const b of exportBlocks(input, kind)) {
    body.push(new Paragraph({ spacing: { before: 280, after: 80 }, children: [new TextRun({ text: b.title, bold: true, size: 23, color: NAVY })] }));
    body.push(new Paragraph({ spacing: { after: 60, line: 300 }, children: textRuns(b.text) }));
  }
  if (!isAvs) {
    for (const a of input.amendments) {
      body.push(new Paragraph({ spacing: { before: 280, after: 80 }, children: [new TextRun({ text: `${a.title} (${a.at})`, bold: true, size: 23, color: NAVY })] }));
      body.push(new Paragraph({ children: textRuns(`Reason: ${a.reason}`, { color: MUTED, size: 19 }) }));
      body.push(new Paragraph({ children: textRuns(a.text) }));
    }
    body.push(
      new Paragraph({
        spacing: { before: 360 },
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'E3E8EF', space: 8 } },
        children: textRuns(attestation(input), { size: 19, color: MUTED }),
      })
    );
  }
  return new Document({
    creator: input.practice.name,
    title: `${EXPORT_LABELS[kind]} · ${input.patient.name} · ${input.visit.date}`,
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{ properties: { page: { margin: { top: 1300, bottom: 1100, left: 1100, right: 1100 } } }, headers: { default: header }, footers: { default: footer }, children: body }],
  });
}

export function docxBlob(input: ExportInput, kind: ExportKind): Promise<Blob> {
  return Packer.toBlob(buildDocx(input, kind));
}

export function exportFileName(input: ExportInput, kind: ExportKind): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${safe(input.patient.name)}_${input.visit.date.replace(/\//g, '-')}_${kind === 'avs' ? 'after-visit-summary' : kind === 'summary' ? 'session-summary' : 'visit-note'}.docx`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Print-ready HTML (the PDF route: the browser's "Save as PDF"). */
export function printHtml(input: ExportInput, kind: ExportKind): string {
  const rows = kind === 'avs' ? [['Patient', input.patient.name], ['Visit', `${input.visit.date} at ${input.visit.time}`], ['Clinician', input.provider.name]] : [
    ['Patient', input.patient.name],
    ['Date of birth', input.patient.dob],
    ['Visit', `${input.visit.date} at ${input.visit.time} · ${input.visit.type}`],
    ['Provider', [input.provider.name, input.provider.credentials].filter(Boolean).join(', ')],
    ['Patient location', `${input.visit.state} (at time of visit)`],
    ['Modality', input.visit.modality],
  ];
  const blocks = exportBlocks(input, kind)
    .map((b) => `<h2>${esc(b.title)}</h2><p>${esc(b.text).replace(/\n/g, '<br/>')}</p>`)
    .join('');
  const amendments = kind === 'avs' ? '' : input.amendments.map((a) => `<h2>${esc(a.title)} (${esc(a.at)})</h2><p class="muted">Reason: ${esc(a.reason)}</p><p>${esc(a.text).replace(/\n/g, '<br/>')}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(EXPORT_LABELS[kind])} · ${esc(input.patient.name)}</title>
<style>
  @page { margin: 18mm 16mm; }
  body { font: 11pt/1.5 Calibri, 'Segoe UI', Arial, sans-serif; color: #1a2433; margin: 0; }
  .letterhead { border-bottom: 2px solid #3953A4; padding-bottom: 6px; margin-bottom: 14px; }
  .letterhead b { color: #1F2D5C; font-size: 13pt; }
  .muted { color: #5B6B80; font-size: 9.5pt; }
  h1 { color: #1F2D5C; font-size: 16pt; margin: 0 0 8px; }
  h2 { color: #1F2D5C; font-size: 11.5pt; margin: 16px 0 4px; }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; }
  td { padding: 3px 6px; border-bottom: 1px solid #E3E8EF; vertical-align: top; }
  td:first-child { width: 25%; color: #5B6B80; font-weight: 600; }
  .attest { margin-top: 22px; border-top: 1px solid #E3E8EF; padding-top: 8px; }
  footer { margin-top: 24px; text-align: center; }
</style></head><body>
<div class="letterhead"><b>${esc(input.practice.name)}</b><br/><span class="muted">${esc([input.practice.address, input.practice.phone && `Phone ${input.practice.phone}`].filter(Boolean).join(' · '))}</span></div>
<h1>${esc(EXPORT_LABELS[kind])}</h1>
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${blocks}${amendments}
${kind === 'avs' ? '' : `<p class="attest muted">${esc(attestation(input))}</p>`}
<footer class="muted">${kind === 'avs' ? 'In a crisis call or text 988, or call 911.' : 'Confidential health information. Redisclosure may be prohibited by law.'}</footer>
</body></html>`;
}
