import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Patient, ServiceRequest, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, EXT } from '@teleemon/core';
import { patientsByRef } from './shared';
import { collectResources } from './shared';

export interface LabQueueResult {
  readonly document: DocumentReference;
  readonly patient?: Patient;
  readonly order?: ServiceRequest;
  readonly reviewTask?: Task;
  readonly review?: { readonly by?: string; readonly at?: string; readonly abnormal?: boolean; readonly comment?: string };
  readonly reviewed: boolean;
  readonly abnormal?: boolean;
}

export interface LabQueueOrder {
  readonly order: ServiceRequest;
  readonly patient?: Patient;
  readonly results: readonly LabQueueResult[];
}

export interface LabMonitoringRow {
  readonly task: Task;
  readonly patient?: Patient;
}

export interface LabQueueData {
  readonly orders: readonly LabQueueOrder[];
  readonly unlinkedResults: readonly DocumentReference[];
  readonly monitoring: readonly LabMonitoringRow[];
}

export type LabQueue = LabQueueData;

export async function loadLabQueue(medplum: MedplumClient): Promise<LabQueueData> {
  const [orders, documents, reviewTasks, monitoringTasks] = await Promise.all([
    collectResources<ServiceRequest>(medplum, 'ServiceRequest', new URLSearchParams([['status', 'active,on-hold,completed'], ['category', 'http://snomed.info/sct|108252007'], ['_sort', '-authored']])),
    collectResources<DocumentReference>(medplum, 'DocumentReference', new URLSearchParams([['category', `${CODE_SYSTEMS.documentCategory}|lab-report`], ['status', 'current'], ['_sort', '-date']])),
    collectResources<Task>(medplum, 'Task', new URLSearchParams([['code', `${CODE_SYSTEMS.taskCode}|result-review`], ['status', 'requested,ready,in-progress'], ['_sort', '-authored-on']])),
    collectResources<Task>(medplum, 'Task', new URLSearchParams([['code', `${CODE_SYSTEMS.taskCode}|lab-monitoring`], ['status', 'requested,ready,in-progress'], ['_sort', '-authored-on']])),
  ]);
  const orderByRef = new Map<string, ServiceRequest>(orders.flatMap((order) => order.id ? [[`ServiceRequest/${order.id}`, order] as const] : []));
  const reviewByDocument = new Map<string, Task>(reviewTasks.flatMap((task) => task.focus?.reference ? [[task.focus.reference, task] as const] : []));
  const patientRefs = [
    ...orders.map((order) => order.subject?.reference),
    ...documents.map((doc) => doc.subject?.reference),
    ...monitoringTasks.map((task) => task.for?.reference),
  ];
  const patients = await patientsByRef(medplum, patientRefs);
  const mapped = documents.map((document): LabQueueResult => {
    const orderRef = document.context?.related?.find((related) => related.reference?.startsWith('ServiceRequest/'))?.reference;
    const resultReview = document.extension?.find((extension) => extension.url === EXT.resultReview);
    const abnormal = resultReview?.extension?.find((item) => item.url === 'abnormal')?.valueBoolean;
    const review = resultReview ? {
      by: resultReview.extension?.find((item) => item.url === 'by')?.valueReference?.reference,
      at: resultReview.extension?.find((item) => item.url === 'at')?.valueDateTime,
      abnormal,
      comment: resultReview.extension?.find((item) => item.url === 'comment')?.valueString,
    } : undefined;
    const reviewed = !!resultReview;
    const patientRef = document.subject?.reference;
    return { document, patient: patientRef ? patients.get(patientRef) : undefined, order: orderRef ? orderByRef.get(orderRef) : undefined, reviewTask: document.id ? reviewByDocument.get(`DocumentReference/${document.id}`) : undefined, review, reviewed, abnormal };
  });
  const resultsByOrder = new Map<string, LabQueueResult[]>();
  const resultsWithoutOrder: DocumentReference[] = [];
  for (const result of mapped) {
    const ref = result.document.context?.related?.find((related) => related.reference?.startsWith('ServiceRequest/'))?.reference;
    if (ref && orderByRef.has(ref)) resultsByOrder.set(ref, [...(resultsByOrder.get(ref) ?? []), result]);
    else resultsWithoutOrder.push(result.document);
  }
  return {
    orders: orders.map((order) => ({ order, patient: order.subject?.reference ? patients.get(order.subject.reference) : undefined, results: order.id ? resultsByOrder.get(`ServiceRequest/${order.id}`) ?? [] : [] })),
    unlinkedResults: resultsWithoutOrder,
    monitoring: monitoringTasks.map((task) => ({ task, patient: task.for?.reference ? patients.get(task.for.reference) : undefined })),
  };
}
