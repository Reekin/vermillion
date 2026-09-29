import { z } from "zod";

type TextParams = Record<string, string | number>;

/**
 * English wording of every reason, failure and event the workbench states itself. Records store the
 * code and its parameters; the CLI prints this wording and the desktop translates each code. Text an
 * agent, the engine or Git wrote stays plain text.
 */
export const serviceMessages = {
  "dispatch.paused": "The work is paused or stopped by the user.",
  "dispatch.notDispatchable": "This work cannot be dispatched in its current state.",
  "dispatch.schedulerOff": "Automatic progress is off.",
  "dispatch.parentStopped": "The parent work is paused, stopped or cancelled.",
  "dispatch.blocked": "The work item still waits on dependencies or decisions.",
  "dispatch.awaitingMerge": "The work item is waiting to be merged.",
  "dispatch.pendingDecision": "The preparation has unanswered decisions.",
  "dispatch.concurrency": "No free execution slot yet.",
  "dispatch.resource": "A shared resource is still in use.",
  "dispatch.delivering": "The dispatch is being delivered.",
  "dispatch.unconfirmed": "The dispatch result is not confirmed yet.",
  "dispatch.previousDelivered": "The previous dispatch was confirmed; this answer is still waiting to be delivered.",
  "dispatch.sessionChanged": "The fixed execution session changed.",
  "dispatch.controlChanged": "Execution control changed; nothing was sent.",
  "dispatch.rejected": "The engine did not accept the dispatch.",
  "dispatch.acceptanceUnknown": "Whether the engine accepted the dispatch is not confirmed.",

  "turn.preparationFailed": "The preparation turn failed.",
  "turn.userStopped": "The user stopped the current turn.",
  "turn.preparationNoHandoff": "The preparation turn ended without a complete handoff.",
  "turn.executionFailed": "The execution turn failed.",
  "turn.endedUndelivered": "The turn ended without a delivery.",
  "turn.ended": "The turn ended.",

  "work.pausedByUser": "The user paused this work.",
  "work.cancelledByUser": "The user cancelled this work.",
  "workItem.pausedByUser": "The user paused this work item.",
  "workItem.closedAs": (p: { status: string }) => `The work item moved to ${p.status}.`,
  "preparation.handoffMismatch": "The handoff list does not match the actual work items; waiting for a fix.",

  "history.workerPaused": "The user paused the Worker.",
  "history.continueRequested": "Continuation was requested explicitly.",
  "history.docsCommitted": (p: { commit: string; refs: string }) => `Referenced docs committed ${p.commit}: ${p.refs}`,
  "history.verifyRecord": (p: { revision: number; record: string }) => `Verification record for contract revision ${p.revision}:\n${p.record}`,
  "history.mergeRetried": "The user retried the merge.",
  "history.mergeHandedOver": "Handed the merge to the original Worker.",
  "history.agentMergeRequested": "The Agent requested the final merge.",
  "history.agentMergeStarted": "The Agent started the merge.",
  "history.workbenchMergeStarted": "The workbench started the merge.",

  "merge.awaiting": "Verification passed; waiting to merge.",
  "merge.rollback": (p: { reason: string }) => `User rollback: ${p.reason}`,
  "merge.voided": (p: { current: number; basis: number }) =>
    `Merge voided: the contract is now at revision ${p.current}, but the result is based on revision ${p.basis}. Review against the current contract and submit again.`,

  "rejection.stale": (p: { current: number; received: number }) =>
    `The submission is out of date: the contract is at revision ${p.current}, but revision ${p.received} was submitted. Re-read the work item and update only the affected results.`,
  "rejection.verifyFailed": (p: { details: string }) => `Verification did not pass:\n${p.details}`,
  "rejection.verifyIncomplete": "Verification did not pass: the report does not cover every item.",
  "rejection.verifyRework": "Verification did not pass: the report asks for rework.",

  "decision.dependencyCancelled": "A prerequisite was cancelled. How should this continue?",
  "decision.dependencyCancelledContext": "A prerequisite of this work was cancelled. Adjust the dependencies or cancel this work item.",
  "decision.adjustDependencies": "Adjust dependencies",
  "decision.cancel": "Cancel",

  "issue.createdByUser": "The user created the Issue",
  "issue.createdByMaintainer": "The Maintainer created the Issue",
  "issue.createdByLiaison": "The Liaison created the Issue",
  "issue.linkedPatrol": "Linked to a domain patrol",
  "issue.evidenceAdded": (p: { count: number }) => `Added ${p.count} ${p.count === 1 ? "piece" : "pieces"} of evidence`,
  "issue.statusChanged": (p: { status: string }) => `Status changed to ${p.status}`,
  "issue.updated": "Updated the Issue",
  "issue.discussionCreated": "Created a design discussion session",
  "issue.workItemByOwner": "The Owner created a work item under the domain authorization",
  "issue.workItemLinked": "Linked a work item",
  "patrol.skipped": "No new changes or Issues to re-check; skipped.",

  "diagnosis.userPaused": "Paused by the user",
  "diagnosis.dependency": (p: { workItemId: string; status: string }) => `Prerequisite ${p.workItemId}: ${p.status}`,
  "next.workerMerge": "The original Worker handles the merge and records the result through the work item commands.",
  "next.awaitResume": "Wait for the user to resume.",
  "next.decide": "Check the blocking reason; the user or the Supervisor decides how to proceed.",
  "next.proceed": "Proceeds under the current conditions.",
  "next.adjustDependency": "The user adjusts the dependencies or cancels.",
  "next.awaitDependency": "Wait for the prerequisite to close.",
  "next.answerDecision": "The user answers with decision.answer.",
  "waiting.turnUnknown": "Waiting to confirm the execution turn status.",
  "waiting.preparing": "Waiting for the preparation turn to register work items and directories.",
  "waiting.offline": "The desktop scheduler is offline; saved records are not dispatched until it starts.",
  "waiting.schedulerOff": "The scheduler is off; waiting for it to be enabled.",
  "waiting.concurrency": (p: { occupied: number; max: number }) => `Waiting for a free Worker slot (${p.occupied}/${p.max}).`,
  "waiting.resources": (p: { names: string }) => `Waiting for shared resources: ${p.names}`,
  "waiting.scheduler": "Waiting for the scheduler to pick up the queued action.",
  "waiting.dispatchUnconfirmed": "Dispatch acceptance is unconfirmed; the next operation checks the original receipt first.",
  "waiting.invalidRef": (p: { ref: string; reason: string }) => `Reference no longer resolves: ${p.ref} (${p.reason})`,
  "waiting.autoProgressOff": "Automatic progress is off.",
  "condition.diagnoseItem": "Any time, to read the current state.",
  "condition.answerDecision": "After the user actually answers: retry, cancel or give specific instructions.",
  "condition.resumeItem": "To continue, resuming the original session.",
  "condition.retryItem": "After checking the current conditions, to continue the original Worker.",
  "condition.updateItem": "To adjust the contract or dependsOn; explain the change in note.",
  "condition.cancelItem": "To cancel this work.",
  "condition.retryMerge": "To retry the current merge now.",
  "condition.takeoverMerge": "To hand the merge to the original Worker with a note.",
  "condition.diagnoseWork": "Any time, to read the current work.",
  "condition.resumeWork": "To resume automatic progress for this work.",
  "condition.pauseWork": "To pause preparation, retries and further automatic progress.",
  "condition.retryWork": "After the failure is handled, to start again.",
  "condition.cancelWork": "To cancel the preparation and its unfinished work items.",

  "error.supervisorCannotResume": "The Supervisor cannot lift a pause or stop set by the user.",
  "error.supervisorSchedulerOff": "Automatic progress is off, so the Supervisor cannot start execution.",
  "error.preparationNotRetryable": "This preparation cannot be retried.",
  "error.workPaused": "This work is paused. Resume it first.",
  "error.preparationUnconfirmed": "The preparation dispatch is not confirmed yet, so it is not dispatched again.",
  "error.workNotPausable": "This work cannot be paused.",
  "error.workNotResumable": "This work is not paused or stopped.",
  "error.resumePartial": (p: { failures: string }) => `The work resumed, but some dispatches did not finish:\n${p.failures}`,
  "error.workItemPaused": "This work item is paused. Resume it first.",
  "error.workItemStopped": "The user paused or stopped this work item. Resume it first.",
  "error.noRetryableMerge": "This work item has no failed merge to retry.",
  "error.mergeUnfinished": "The merge is still not finished.",
  "error.deliveryUnconfirmed": "The delivery result is not confirmed yet. Retry explicitly and check again.",
  "error.noMergeToHandOver": "This work item has no merge to hand to the original Worker.",
  "error.mergeNotFailed": "The merge has not failed.",
  "error.schedulerOffline": "The execution scheduler is offline.",
  "error.handoverUndelivered": "The merge request has not been confirmed as delivered to the Worker.",
  "error.rollbackReasonRequired": "Enter a reason for the rollback.",
  "error.cancelMerged": "This work item is already merged. Use rollback instead of cancelling the merged result.",
  "error.workItemNotResumable": "This work item is not paused or stopped.",
  "error.workItemEnded": "This work item has ended.",
  "error.executionUnconfirmed": "Whether the engine accepted the execution request is not confirmed.",
  "error.executionNotStarted": "The execution request was not confirmed to start. Read the current work item state.",
  "error.decisionWithdrawn": "The decision was withdrawn.",
  "error.decisionAnswered": "The decision is already answered and the answer cannot change.",
  "error.noDecisionSession": "There is no fixed execution session to deliver the answer to yet.",
  "error.answerUnconfirmed": "Delivery of the answer is not confirmed yet.",
  "error.answerRejected": "The session did not accept the decision answer.",
  "error.answerUndelivered": "The decision answer is not delivered yet.",
  "error.patrolActive": (p: { domain: string; patrolRunId: string }) => `Domain ${p.domain} already has a patrol queued or running: ${p.patrolRunId}`,
  "result.worktreeUncommitted": "Worker must commit its worktree before integration.",
  "result.rootPathsMissing": "Code results at the workspace root must list their paths in scope.allowedPaths.",
  "result.rootUncommitted": "Uncommitted results remain within the scope at the workspace root. Commit them, then record evidence.commit.",
  "result.rootNoBase": "Execution at the workspace root has no base commit, so the result range cannot be determined.",
  "result.rootCommitMissing": "Code results at the workspace root must record their last commit in evidence.commit.",
  "result.rootMixedCommit": (p: { commit: string }) => `A commit mixes this work item's changes with changes outside its scope, so a rollback cannot be recorded safely: ${p.commit}`,
  "result.rootEmpty": "The commit range has no code results of this work item.",
  "error.docsConflict": (p: { files: string }) =>
    `The doc draft conflicts with the main branch: ${p.files}. Run docs.rebase to bring this session's draft onto the main branch, resolve the conflict markers, save with docs.write and run docs.commit again.`,

  "remote.frpcNotFound": "No executable frpc was found; choose the program path.",
  "remote.caRequired": "Choose the frp server CA certificate that verifies the VPS.",
  "remote.frpcExited": (p: { code: string }) => `frpc exited (${p.code}).`,
  "remote.tunnelFailed": "The tunnel failed to start.",
  "remote.addressRequired": "Enter the VPS address and the frp token.",
  "remote.publicUrlInvalid": "The public address must be an HTTPS origin.",
  "remote.startFailed": "Remote access failed to start.",
  "remote.notConfigured": "Enable and configure remote access first.",
  "remote.notEnabled": "Enable remote access first.",
  "remote.pushNotRegistered": "The device has not registered for push, or it was removed.",
  "remote.apnsRejected": (p: { status: number; reason: string }) => `APNs ${p.status}: ${p.reason}`,
  "remote.pushFailed": "The push failed.",
  "remote.apnsTimeout": "The APNs request timed out.",
  "remote.apnsClosed": "The APNs connection closed.",
  "remote.apnsInvalidRequest": "The APNs request is invalid.",
  "remote.apnsResponseTooLarge": "The APNs response is too large.",
  "remote.apnsInvalidResponse": "APNs returned an invalid response.",
  "remote.apnsKeyInvalid": "The APNs key must be a P-256 EC private key.",
  "remote.apnsNotConfigured": "Configure the APNs key path, Key ID, Team ID and App Bundle ID.",
  "remote.apnsTooLarge": "The APNs notification exceeds 4096 bytes.",
  "remote.deviceRemoved": "The device was removed; pair it again.",
  "remote.pairCodeInvalid": "The pairing code is invalid or expired.",
  "remote.deviceNameInvalid": "Enter a device name of at most 100 characters."
} satisfies Record<string, string | ((params: never) => string)>;

export type ServiceMessages = typeof serviceMessages;
export type ServiceCode = keyof ServiceMessages;
type ParamsOf<C extends ServiceCode> = ServiceMessages[C] extends (params: infer P) => string ? P : never;
type ParamsArg<C extends ServiceCode> = ServiceMessages[C] extends (params: infer P) => string ? [params: P] : [];

export type CodedText = { code: string; params?: TextParams };
/** A reason or event: the workbench's own wording as a code, or text written by an agent, the engine or Git. */
export type ServiceText = string | CodedText;

export const zServiceText = z.union([
  z.string(),
  z.object({ code: z.string().min(1), params: z.record(z.union([z.string(), z.number()])).optional() }).strict()
]);

export const text = <C extends ServiceCode>(code: C, ...[params]: ParamsArg<C>): CodedText =>
  params ? { code, params: params as ParamsOf<C> & TextParams } : { code };

export const isCodedText = (value: unknown): value is CodedText =>
  typeof value === "object" && value !== null && typeof (value as CodedText).code === "string" &&
  Object.keys(value).every((key) => key === "code" || key === "params") && Object.hasOwn(serviceMessages, (value as CodedText).code);

/** The English wording; plain text is returned as written. */
export const renderServiceText = (value: ServiceText): string => {
  if (typeof value === "string") return value;
  const message = (serviceMessages as unknown as Record<string, string | ((params: TextParams) => string)>)[value.code];
  if (message === undefined) return value.code;
  return typeof message === "function" ? message(value.params ?? {}) : message;
};

/** Replaces every coded text inside a result with its English wording, for output read by people and agents on the CLI. */
export const renderServiceTexts = (value: unknown): unknown => {
  if (isCodedText(value)) return renderServiceText(value);
  if (Array.isArray(value)) return value.map(renderServiceTexts);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderServiceTexts(entry)]));
  return value;
};

/** A failure the user can act on; the message is the English wording and the code travels to the desktop. */
export class ServiceError extends Error {
  constructor(readonly text: CodedText) {
    super(renderServiceText(text));
  }
}

export const serviceError = <C extends ServiceCode>(code: C, ...params: ParamsArg<C>): ServiceError => new ServiceError(text(code, ...params));

/** Raises a stored reason again as the error of an operation. */
export const textError = (value: ServiceText): Error => typeof value === "string" ? new Error(value) : new ServiceError(value);

/** What a caught failure says, keeping the code of the workbench's own failures. */
export const failureText = (error: unknown): ServiceText =>
  error instanceof ServiceError ? error.text : error instanceof Error ? error.message : String(error);
