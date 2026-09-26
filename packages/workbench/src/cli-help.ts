import { z } from "zod";
import { workbenchRpc, type WorkbenchRpcMethod } from "./rpc.js";

const states: Partial<Record<WorkbenchRpcMethod, string>> = {
  "remote.status": "Desktop online; reports the remote entry, tunnel state and number of connected devices.",
  "remote.configure": "Desktop online; omit patch to read the settings, pass patch to change fields and apply them immediately. serverPort defaults to 7000, remotePort to 18080; an empty frpcPath uses frpc from PATH; trustedCaFile is the CA certificate that verifies the frp server, empty by default and required before connecting.",
  "remote.pair": "Remote access enabled; creates a one-time 8-character pairing code and returns code, qrContent and expiresAt, valid for 10 minutes.",
  "remote.device.list": "Desktop online; lists paired devices with pairing time, last connection time and push availability.",
  "remote.device.revoke": "Desktop online; removes the device given by deviceId, closes its connections immediately and revokes its credential.",
  "remote.push.test": "Desktop online; sends a test notification to the device given by deviceId that has registered APNs. Configure apnsKeyPath, apnsKeyId, apnsTeamId and apnsBundleId through remote.configure first. Success means APNs accepted it, not that the phone displayed it.",
  "docs.discardPreview": "Read-only preview: paths optionally names files or directories inside .vermillion/docs; returns the currently changed files.",
  "docs.discard": "Discards staged and unstaged changes of the confirmed files, restoring HEAD; added files are deleted. paths must be the concrete file paths returned by discardPreview; directories are not expanded. Returns the changes actually handled.",
  "docs.rebase": "Use after committing docs in a session tree conflicted with the main branch. Brings the tree's draft onto the main branch; conflicting files stay in the draft with conflict markers, to be resolved with docs.write before docs.commit. Empty files means the draft is in sync.",
  "worktree.list": "Lists the deferred cleanup candidates registered by work items.",
  "worktree.cleanup": "Tries now to clean up candidates no unfinished work item holds, and merged doc drafts; busy directories and drafts with unmerged changes wait for the next call. Takes only workspaceId, never an arbitrary path.",
  "workItem.diagnose": "Any existing work item; read-only and never triggers scheduling.",
  "workItem.list": "Read-only list of the workspace's execution work items (WorkItem), including finished ones; does not return the problems and suggestions in Issues.",
  "work.cancel": "A start-work request in preparation; cancels it and its unexecuted work items, by requestId or the preparation branch sessionId.",
  "work.prepare.complete": "The preparation branch has created every work item of this request. Register the complete workItemIds and doc refs before the preparation turn ends; execution opens after the handoff.",
  "work.diagnose": "Any existing work; read-only summary of the preparation, linked work items, waiting reasons and valid operations.",
  "work.pause": "Unfinished preparation work; pauses its progress and keeps the session and registered work items.",
  "work.resume": "Paused preparation work; resumes automatic progress.",
  "decision.answer": "An unanswered decision; submit key or note only with the user's actual answer.",
  "runtime.info": "Any time; with a desktop connected returns that runtime's build hash, otherwise the CLI's local runtime with schedulerOnline=false.",
  "workItem.start": "A queued work item with nothing blocking it, or a running work item of the same session; respects concurrency and resource limits.",
  "workItem.submit": "The current Worker's running work item; submits real evidence, review and per-item verification results.",
  "workItem.update": "An unfinished work item; adjusts the contract with a note explaining the change. Pass the current sessionId when adjusting your own work item so the workbench does not send the change back to that session.",
  "docs.commit": "workspaceId and a commit message; paths limits the docs committed. With sessionId, commits in the session tree's own draft first, then merges into the main branch; a conflict lists the files and points to docs.rebase. Pass the current sessionId when committing docs in your own work item so the workbench does not send the commit back to that session.",
  "docs.write": "Writes a doc inside .vermillion/docs. With sessionId, writes to that session tree's draft, created on the first write, leaving the main branch and other session trees untouched.",
  "docs.read": "Reads a doc inside .vermillion/docs. With sessionId, reads the session tree's draft; with commit, reads that commit's version regardless of drafts.",
  "docs.list": "Lists the files under .vermillion/docs. With sessionId, lists the session tree's draft, or the main branch when there is no draft.",
  "docs.pending": "Lists the uncommitted doc changes. With sessionId, the session tree's draft is used.",
  "docs.diff": "Shows one doc's changes against the current commit. With sessionId, the session tree's draft is used.",
  "workItem.cancel": "An unfinished work item; cancels the current work.",
  "workItem.pause": "A running Worker session; records the user's pause, used together with the session Stop.",
  "workItem.resume": "A work item the user paused; clears the pause and continues in the original session.",
  "workItem.retry": "A work item waiting after an execution failure; resets the current recovery count and continues from the unfinished action.",
  "workItem.merge.retry": "A work item whose merge failed and was not handed to an Agent; retries the current merge now, as an explicit operation.",
  "workItem.merge.takeover": "A work item whose merge failed and was not handed to an Agent; delivers it to the original Worker with a note.",
  "workItem.merge.complete": "The original Worker that took over a merge; after handling the worktree/rebase, asks the workbench to run the final merge at its serialized boundary.",
  "app.start": "Builds and starts an isolated candidate locally; allocates an instance directory automatically, and takes the dataDir returned earlier on restart. fixture can be session-tree or real-session.",
  "app.stop": "Stops an instance by dataDir, pid and instanceId, removing its directory once the process has exited and the port is free; keepData=true keeps the directory for a restart or evidence.",
  "app.window": "Controls the window of an instance returned by app.start locally: status queries it, minimize minimizes it, restore restores and activates it.",
  "asksource": "The Worker of a running work item; temporarily asks the source Design Partner at the position the work item was created from, and waits for the answer.",
  "steer": "Desktop must be online. Append to an active turn or start a new turn in the target session. sessionId accepts a workbench or engine session ID. CLI detects the sender from VERMILLION_SESSION_ID or CODEX_THREAD_ID; messages identify their source and are not user authorization. Without either variable, the source is CLI (no session).",
  "workItem.rollback": "A merged work item with commits that can be rolled back; give the reason the user asked for the rollback.",
  "search.query": "Read-only; searches work items, docs and Vermillion sessions of registered workspaces and returns matching context. Session results are per message: only the user messages, agent replies and tool call text shown in the message area match; returns the source, turnNumber, messageAt and neighbouring messages.",
  "search.start": "Read-only; starts a streaming search. Hits arrive as search.hits events and search.completed ends it. Starting a new streaming search stops the previous one.",
  "search.cancel": "Stops the streaming search with the given queryId and its scan processes.",
  "issue.discuss": "Desktop online; creates the Issue's Design Partner discussion session, or returns the existing one.",
  "issue.list": "Read-only list of the problem and suggestion records in Issues, filterable by domain and status; does not return execution work items (WorkItem).",
  "issue.update": "Updates an Issue's triage, evidence or result; closing or marking a duplicate needs a resolution reason.",
  "domain.config.set": "The user manages domain patrols and automatic work item authorization; saved per domain.",
  "role.list": "Read-only; lists the roles available in the workspace with their source, customization mode (global follows the global role, append adds to its body, override replaces it) and the resulting modelConfig; fields it omits follow the composer settings.",
  "domain.instruction.write": "Edits the domain's Maintainer developer instruction; saved to the current workspace.",
  "domain.remove": "Deletes the domain definition, its patrol instruction and patrol settings; past Issues and patrol records stay.",
  "workspace.directories": "Read-only; returns the directories of the workspace's Git-tracked files, for choosing trigger directories.",
  "domain.patrol.run": "Queues a real domain patrol manually; the Maintainer session starts once the desktop scheduler is online.",
  "domain.patrol.scan": "Scans directory changes and due schedules; records a skip without starting a model when there is nothing to check.",
  "domain.patrol.complete": "The current Maintainer patrol session records its result and linked Issues.",
  "domain.issue.workItem.create": "The current Maintainer patrol session; creates a linked fix work item only when the domain authorization, pinned requirement ref and evidence are all valid."
};

const methodGroups = [
  { title: "Remote access", prefixes: ["remote"] },
  { title: "Workspaces (project directories)", prefixes: ["workspace", "settings"] },
  { title: "Sessions and messages", prefixes: ["session", "sessionNavigation", "sessionBrowser", "chatTree", "clipboard", "steer", "asksource"] },
  { title: "Docs", prefixes: ["docs"] },
  { title: "Work (one start of work and its preparation)", prefixes: ["work"] },
  { title: "Execution work items, WorkItem (executed and verified independently)", prefixes: ["workItem", "worktree"] },
  { title: "Issues (triage records of problems and suggestions, not execution work items)", prefixes: ["issue"] },
  { title: "Domains and patrols", prefixes: ["domain"] },
  { title: "Search", prefixes: ["search"] },
  { title: "Roles", prefixes: ["role"] },
  { title: "Decisions and notifications", prefixes: ["decision", "inbox"] },
  { title: "Scheduling and runs", prefixes: ["scheduler", "run", "runtime", "action"] },
  { title: "App and acceptance instances", prefixes: ["app"] }
];

export function globalHelp(methods: string[]): string {
  const groups = new Map(methodGroups.map(({ title }) => [title, [] as string[]]));
  groups.set("Other", []);
  for (const method of methods) {
    const title = methodGroups.find(({ prefixes }) => prefixes.includes(method.split(".")[0]!))?.title ?? "Other";
    groups.get(title)!.push(method);
  }
  return "usage: vermillion [--target <app.start target file>] <method> [json-params]\nMethod help: vermillion <method> --help\n\nmethods:\n"
    + [...groups].filter(([, names]) => names.length).map(([title, names]) => `  ${title}\n${names.map((name) => `    ${name}`).join("\n")}`).join("\n") + "\n";
}

/** Parameters and examples come from the RPC schema rather than a second parameter registry. */
function describe(schema: z.ZodTypeAny, sample = false, key = "value"): unknown {
  if (schema instanceof z.ZodOptional) return sample ? undefined : { optional: describe(schema.unwrap()) };
  if (schema instanceof z.ZodDefault) return sample ? schema._def.defaultValue() : { default: schema._def.defaultValue(), type: describe(schema.removeDefault()) };
  if (schema instanceof z.ZodNullable) return sample ? null : { nullable: describe(schema.unwrap()) };
  if (schema instanceof z.ZodEffects) return describe(schema.innerType(), sample, key);
  if (schema instanceof z.ZodObject) return Object.fromEntries(Object.entries(schema.shape).map(([name, value]) => [name, describe(value as z.ZodTypeAny, sample, name)]).filter(([, value]) => value !== undefined));
  if (schema instanceof z.ZodArray) return sample ? Array.from({ length: Math.max(1, schema._def.minLength?.value ?? 0) }, () => describe(schema.element, true, key)) : { array: describe(schema.element), minLength: schema._def.minLength?.value };
  if (schema instanceof z.ZodEnum) return sample ? schema.options[0] : { enum: schema.options };
  if (schema instanceof z.ZodLiteral) return schema.value;
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) return sample ? describe([...schema.options][0], true, key) : { oneOf: [...schema.options].map((s) => describe(s)) };
  if (schema instanceof z.ZodBoolean) return sample ? true : "boolean";
  if (schema instanceof z.ZodNumber) return sample ? schema.minValue ?? 1 : { type: "number", checks: schema._def.checks };
  if (schema instanceof z.ZodString) return sample ? `<${key}>` : { type: "string", checks: schema._def.checks };
  if (schema instanceof z.ZodRecord) return sample ? {} : { values: describe(schema.valueSchema) };
  return sample ? null : schema._def.typeName;
}

export function methodHelp(method: string): string | undefined {
  if (method === "app.start") return [
    "app.start",
    "When to use: builds and starts an isolated acceptance candidate with an explicit identity locally. A source checkout needs expectedRevision and a clean working tree; a release directory needs expectedBuildId. On success returns the actual buildId, instanceId, logs, the full isolated environment and the targeted CLI command.",
    "Source example:",
    "vermillion app.start '{\"targetPath\":\"X:/project-worktree\",\"expectedRevision\":\"<full-commit>\",\"port\":14961,\"fixture\":\"session-tree\"}'",
    "Release example:",
    "vermillion app.start '{\"targetPath\":\"X:/release/vermillion\",\"expectedBuildId\":\"sha256:<hash>\",\"port\":14961}'",
    "The first start allocates dataDir automatically; pass keepData=true when stopping to keep the directory, and pass the returned dataDir to app.start to restart. The returned cli.executable and cli.args are bound to this instance; a restart does not rewrite the old instance's target descriptor.",
    ""
  ].join("\n");
  const desktopHelp: Record<string, { params: string; state: string; example: object }> = {
    "file.runAction": { params: "path: non-empty absolute path; action: \"open\" | \"reveal\"", state: "Desktop online; opens a file or directory with its default application, or reveals it in the file manager. Returns the host action result, including any error.", example: { path: "C:/project", action: "open" } },
    "settings.get": { params: "none", state: "Desktop online; returns the global settings, each engine's program resolution, and engineConfigWarningsByEngineId: configuration warnings (summary, details, path) reported by each engine's current process; engines without warnings are omitted.", example: {} },
    "settings.update": { params: "locale?: \"zh\" | \"en\"; defaultNewSessionEngineId?: string; titleGenerationModelId?: string | null", state: "Desktop online; updates global settings and returns the saved settings. A locale change switches the interface language immediately, without a restart.", example: { locale: "en" } },
    "sessionBrowser.list": { params: "workspaceId: string; kind?: user | agent", state: "Desktop online; returns every row of the workspace's session list and the current revision at once.", example: { workspaceId: "<workspaceId>" } },
    "sessionBrowser.changes": { params: "workspaceId: string; revision: string; kind?: user | agent", state: "Desktop online; returns the rows changed since that revision and the identifiers of removed rows; returns full-required when the revision is unavailable.", example: { workspaceId: "<workspaceId>", revision: "<revision>" } },
    "sessionBrowser.open": { params: "sessionId: string; forceProviderHydration?: boolean; includeWindow?: boolean; readId?: string", state: "Desktop online; enters the session and checks its current history. includeWindow=false only opens it without returning the body window; read the body by version with chatTree.get. readId identifies this read so chatTree.cancelRead can cancel it.", example: { sessionId: "<sessionId>" } },
    "sessionBrowser.rename": { params: "sessionId: string, title: non-empty string", state: "Desktop online; renames the session and returns the saved title. Works for every session in the list; for unloaded past sessions it changes their index record.", example: { sessionId: "<sessionId>", title: "New title" } },
    "chatTree.get": { params: "sessionId: string; scope?: \"tree\" | \"path\"; knownWindows?: Record<string, { revision: string; cursor?: string }>; readId?: string", state: "Desktop online; reads the full tree structure by default. scope=path returns the current path; knownWindows declares the member history versions already held in full and the applied event cursor, and the service omits the covered bodies (omission does not mean deletion). Without knownWindows every body on the path is returned. readId identifies this read so chatTree.cancelRead can cancel it.", example: { sessionId: "<sessionId>" } },
    "chatTree.cancelRead": { params: "readId: string", state: "Desktop online; cancels the active read and returns cancelled. Each request gets its own readId; finished or cancelled reads return false.", example: { readId: "<readId>" } },
    "chatTree.readProgress": { params: "readId: string", state: "Queries the live stage of a read and how many members of the current path are done; returns progress:null once the read ended or does not exist.", example: { readId: "<readId>" } },
    "chatTree.nodeAction": { params: "sessionId: string, nodeId: string, action: copy_session_id | copy_awb_session_id | open_rollout | hide_node", state: "Desktop online; copy actions return copiedText, open_rollout returns the file of the node's session, hide_node hides any non-root node together with all nodes after it in the tree, without archiving engine sessions or changing rollouts.", example: { sessionId: "<sessionId>", nodeId: "<nodeId>", action: "copy_session_id" } },
    "clipboard.writeImage": { params: "source: non-empty data:, file:, http: or https: image URL", state: "Desktop online; writes the image to the system clipboard and returns its actual size.", example: { source: "file:///C:/path/image.png" } },
    "chatTree.markRead": { params: "sessionId: string, nodeId: string", state: "Desktop online; marks completed turns on the displayed node's ancestor path read. Returns readNodeIds.", example: { sessionId: "<sessionId>", nodeId: "<nodeId>" } },
    "chatTree.submit": { params: "sessionId: string, nodeId: string, content: string; attachments?: Attachment[], execution?: TurnExecutionOptions", state: "Desktop online; sessionId and nodeId point to an existing session node.", example: { sessionId: "<sessionId>", nodeId: "<nodeId>", content: "Continue" } },
    "chatTree.retry": { params: "operationId: non-empty string", state: "Desktop online; operationId points to a failed send operation.", example: { operationId: "<operationId>" } },
    "chatTree.cancel": { params: "operationId: non-empty string", state: "Desktop online; operationId points to a pending operation that is being created or sent.", example: { operationId: "<operationId>" } },
    "chatTree.remove": { params: "operationId: non-empty string", state: "Desktop online; operationId points to a failed pending operation or one waiting for cleanup before a retry.", example: { operationId: "<operationId>" } },
    "chatTree.operations": { params: "sessionId: non-empty string", state: "Desktop online; read-only list of the session's send operations.", example: { sessionId: "<sessionId>" } }
  };
  const desktop = desktopHelp[method];
  if (desktop) return `${method}\nWhen to use: ${desktop.state}\nParameters: ${desktop.params}\nExample:\nvermillion ${method} '${JSON.stringify(desktop.example)}'\n`;
  if (!Object.hasOwn(workbenchRpc, method)) return undefined;
  const spec = workbenchRpc[method as WorkbenchRpcMethod];
  const state = states[method as WorkbenchRpcMethod] ?? (/(?:\.get|\.list|\.read|\.diff|\.pending|\.resolve)$/.test(method)
    ? "Read-only; workspaceId and the referenced objects must exist."
    : "Parameters must satisfy the RPC constraints below; referenced objects must exist. The runtime checks the business state; when it refuses, handle the returned reason before calling again.");
  return `${method}\nWhen to use: ${state}\nParameters (optional ones can be omitted; replace <...> with actual values):\n${JSON.stringify(describe(spec.params), null, 2)}\nExample:\nvermillion ${method} '${JSON.stringify(describe(spec.params, true))}'\n`;
}
