import { rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { git, setup } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    // Drafts live beside the workspace so a session's edits stay out of the repository until commit.
    await rm(join(dirname(f.root), basename(f.root) + "-docs-drafts"), { recursive: true, force: true, maxRetries: 5 });
    await f.cleanup();
  }
});

const DOC = ".vermillion/docs/A.md";
const draftsDir = (root: string) => join(dirname(root), basename(root) + "-docs-drafts");

async function fixture() {
  const f = await setup();
  fixtures.push(f);
  // Each session is its own conversation tree here; a real tree joins a designer, its preparation branch and its workers.
  f.service.setSessionTreeResolver(async (sessionId) => sessionId);
  // Draft worktrees check files out, so line endings must not depend on this machine's Git defaults.
  await git(f.root, "config", "core.autocrlf", "false");
  return f;
}

it("shares one draft between the sessions of the same conversation tree", async () => {
  const { service, workspaceId, root } = await fixture();
  // A preparation branch forks the design session, so the conversation index reports one tree for both.
  service.setSessionTreeResolver(async (sessionId) => sessionId.startsWith("prep-") ? "design" : sessionId);
  await service.writeDoc(workspaceId, DOC, "on main\n");
  await service.commitDocs(workspaceId, { message: "Main" });
  await service.writeDoc(workspaceId, DOC, "design draft\n", "design");

  expect(await service.readDoc(workspaceId, DOC, undefined, "prep-1")).toBe("design draft\n");
  expect(await service.pendingDocChanges(workspaceId, "prep-1")).toEqual([{ path: DOC, status: "modified" }]);
  const published = await service.commitDocs(workspaceId, { message: "From the preparation branch", sessionId: "prep-1" });
  expect(await git(root, "show", published.commit + ":" + DOC)).toBe("design draft");
}, 20000);

it("moves a draft whose own commits did not reach the main branch onto the current main branch", async () => {
  const { service, workspaceId, root } = await fixture();
  await service.writeDoc(workspaceId, DOC, "base\n", "tree-a");
  await service.commitDocs(workspaceId, { message: "Base", sessionId: "tree-a" });
  // Another tree publishes a change to a different file while this draft holds an uncommitted edit.
  await service.writeDoc(workspaceId, ".vermillion/docs/other.md", "other\n", "tree-b");
  await service.commitDocs(workspaceId, { message: "Other tree", sessionId: "tree-b" });
  await service.writeDoc(workspaceId, DOC, "local edit\n", "tree-a");

  // The draft follows the main branch, so its changes are measured against the current main commit.
  expect(await service.docDiff(workspaceId, ".vermillion/docs/other.md", "tree-a")).toBe("");
  expect(await service.readDoc(workspaceId, ".vermillion/docs/other.md", undefined, "tree-a")).toBe("other\n");
  expect(await service.readDoc(workspaceId, DOC, undefined, "tree-a")).toBe("local edit\n");
  expect(await service.docDiff(workspaceId, DOC, "tree-a")).toContain("+local edit");
  expect(await git(root, "show", "HEAD:" + DOC)).toBe("base");
}, 20000);

it("re-submits a draft that already carries its commit after the main branch blocked the merge", async () => {
  const { service, workspaceId, root } = await fixture();
  await service.writeDoc(workspaceId, DOC, "base\n");
  await service.commitDocs(workspaceId, { message: "Base" });
  await service.writeDoc(workspaceId, DOC, "from a\n", "tree-a");
  // An uncommitted edit of the same document on the main branch refuses the merge.
  await writeFile(join(root, DOC), "hand edit\n");
  await expect(service.commitDocs(workspaceId, { message: "From a", sessionId: "tree-a" })).rejects.toThrow();

  await git(root, "checkout", "--", DOC);
  const published = await service.commitDocs(workspaceId, { message: "From a", sessionId: "tree-a" });
  expect(await git(root, "show", published.commit + ":" + DOC)).toBe("from a");
}, 20000);

it("keeps one session's document edits out of the main branch and other sessions", async () => {
  const { service, workspaceId, root } = await fixture();
  await service.writeDoc(workspaceId, DOC, "base\n", "tree-a");
  await service.commitDocs(workspaceId, { message: "Base", sessionId: "tree-a" });

  await service.writeDoc(workspaceId, DOC, "from a\n", "tree-a");
  await service.writeDoc(workspaceId, DOC, "from b\n", "tree-b");

  expect(await service.readDoc(workspaceId, DOC, undefined, "tree-a")).toBe("from a\n");
  expect(await service.readDoc(workspaceId, DOC, undefined, "tree-b")).toBe("from b\n");
  expect(await service.readDoc(workspaceId, DOC)).toBe("base\n");
  expect(await git(root, "status", "--porcelain")).toBe("");
  expect(await service.pendingDocChanges(workspaceId)).toEqual([]);
}, 20000);

it("publishes a session's commit to the main branch, which another session reads over its own draft", async () => {
  const { service, workspaceId, root } = await fixture();
  await service.writeDoc(workspaceId, ".vermillion/docs/B.md", "other\n", "tree-b");
  await service.commitDocs(workspaceId, { message: "Base", sessionId: "tree-b" });
  await service.writeDoc(workspaceId, DOC, "kept by b\n", "tree-b");

  await service.writeDoc(workspaceId, DOC, "from a\n", "tree-a");
  const published = await service.commitDocs(workspaceId, { message: "Change from a", sessionId: "tree-a" });

  expect(await git(root, "show", published.commit + ":" + DOC)).toBe("from a");
  expect(await service.readDoc(workspaceId, DOC, published.commit, "tree-b")).toBe("from a\n");
  expect(await service.readDoc(workspaceId, DOC, undefined, "tree-b")).toBe("kept by b\n");
  expect(await service.readDoc(workspaceId, DOC, undefined, "tree-a")).toBe("from a\n");
}, 20000);

it("reports a merge conflict, keeps the main branch intact, and finishes after the session rebases", async () => {
  const { service, workspaceId, root } = await fixture();
  await service.writeDoc(workspaceId, DOC, "base\n", "tree-a");
  await service.commitDocs(workspaceId, { message: "Base", sessionId: "tree-a" });
  await service.writeDoc(workspaceId, DOC, "earlier\n", "tree-a");
  await service.writeDoc(workspaceId, DOC, "later\n", "tree-b");
  await service.writeDoc(workspaceId, DOC, "from a\n", "tree-a");
  await service.commitDocs(workspaceId, { message: "From a", sessionId: "tree-a" });
  const published = await git(root, "rev-parse", "HEAD");

  await expect(service.commitDocs(workspaceId, { message: "From b", sessionId: "tree-b" })).rejects.toThrow(DOC);
  expect(await git(root, "rev-parse", "HEAD")).toBe(published);
  expect(await git(root, "show", "HEAD:" + DOC)).toBe("from a");
  // The draft still holds work the main branch does not, so the explorer keeps showing it.
  expect(await service.pendingDocChanges(workspaceId, "tree-b")).toEqual([{ path: DOC, status: "modified" }]);
  expect(await service.docDiff(workspaceId, DOC, "tree-b")).toContain("+later");

  expect(await service.rebaseDocDraft(workspaceId, "tree-b")).toEqual({ files: [DOC] });
  expect(await service.readDoc(workspaceId, DOC, undefined, "tree-b")).toContain("<<<<<<<");

  await service.writeDoc(workspaceId, DOC, "merged\n", "tree-b");
  // The commit dialog always names its files, so a draft that is only committed but unmerged must still publish.
  const merged = await service.commitDocs(workspaceId, { message: "From b", paths: [DOC], sessionId: "tree-b" });
  expect(await git(root, "show", merged.commit + ":" + DOC)).toBe("merged");
  expect(await git(root, "log", "-1", "--format=%s", merged.commit)).toBe("From b");
}, 20000);

it("writes and commits on the main branch when the call names no session", async () => {
  const { service, workspaceId, root } = await fixture();
  await service.writeDoc(workspaceId, DOC, "plain\n");
  const committed = await service.commitDocs(workspaceId, { message: "Plain" });

  expect(await git(root, "show", committed.commit + ":" + DOC)).toBe("plain");
  expect(await service.readDoc(workspaceId, DOC)).toBe("plain\n");
  await expect(stat(draftsDir(root))).rejects.toThrow();
  expect(await git(root, "branch", "--list", "docs/*")).toBe("");
}, 20000);

it("reads the main branch until a session writes, then that session's own draft", async () => {
  const { service, workspaceId } = await fixture();
  await service.writeDoc(workspaceId, DOC, "on main\n");
  await service.commitDocs(workspaceId, { message: "Main" });

  expect(await service.readDoc(workspaceId, DOC, undefined, "tree-a")).toBe("on main\n");
  await service.writeDoc(workspaceId, DOC, "in a's draft\n", "tree-a");
  expect(await service.readDoc(workspaceId, DOC, undefined, "tree-a")).toBe("in a's draft\n");
  expect(await service.readDoc(workspaceId, DOC)).toBe("on main\n");
}, 20000);

it("recycles a merged draft and keeps one that still holds edits", async () => {
  const { service, workspaceId } = await fixture();
  await service.writeDoc(workspaceId, ".vermillion/docs/shared.md", "seed\n");
  await service.commitDocs(workspaceId, { message: "Seed" });
  await service.writeDoc(workspaceId, DOC, "from a\n", "tree-a");
  await service.commitDocs(workspaceId, { message: "From a", sessionId: "tree-a" });
  await service.writeDoc(workspaceId, DOC, "unmerged\n", "tree-b");

  const cleanup = await service.cleanupWorktrees(workspaceId);
  const removed = cleanup.removed.join("|");

  expect(removed).toContain("tree-a");
  expect(removed).not.toContain("tree-b");
  expect(cleanup.retained.some((entry) => entry.worktreePath.includes("tree-b") && entry.reason.includes("未合入"))).toBe(true);
}, 20000);
