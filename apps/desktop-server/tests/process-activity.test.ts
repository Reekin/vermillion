import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  summarizeCodexFunctionOutputBody,
  summarizeCodexImageGenerationOutput,
  summarizeCodexImageViewOutput,
  summarizeCodexMcpToolCall
} from "../src/engines/codex/extensions/process-activity.js";
import { CodexToolImageStore } from "../src/engines/codex/extensions/tool-images.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-process-activity-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("codex process activity image summaries", () => {
  it("versions imageView file URLs with modified time and size", async () => {
    const dir = await createTempDir();
    const imagePath = join(dir, "same-size.png");
    await writeFile(imagePath, "AAAA");
    await utimes(imagePath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));

    const firstSummary = summarizeCodexImageViewOutput({
      type: "imageView",
      id: "image-1",
      path: imagePath
    });

    await writeFile(imagePath, "BBBB");
    await utimes(imagePath, new Date("2026-01-01T01:00:00.000Z"), new Date("2026-01-01T01:00:00.000Z"));

    const secondSummary = summarizeCodexImageViewOutput({
      type: "imageView",
      id: "image-1",
      path: imagePath
    });

    expect(firstSummary).toContain("![Viewed image](file:");
    expect(firstSummary).toContain("awb_file_mtime=");
    expect(firstSummary).toContain("awb_file_size=4");
    expect(firstSummary).toContain(`path: ${imagePath}`);
    expect(secondSummary).toContain("awb_file_size=4");
    expect(secondSummary).toContain(`path: ${imagePath}`);
    expect(firstSummary).not.toBe(secondSummary);
  });

  it("versions imageGeneration savedPath file URLs", async () => {
    const dir = await createTempDir();
    const imagePath = join(dir, "generated.png");
    await writeFile(imagePath, "PNG!");
    await utimes(imagePath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));

    const summary = summarizeCodexImageGenerationOutput({
      type: "imageGeneration",
      id: "image-generation-1",
      status: "completed",
      revisedPrompt: "A dashboard",
      result: "",
      savedPath: imagePath
    });

    expect(summary).toContain("![Generated image](file:");
    expect(summary).toContain("awb_file_mtime=");
    expect(summary).toContain("awb_file_size=4");
    expect(summary).toContain(`path: ${imagePath}`);
  });

  it("stores inline tool-output images as files and references them by URL", async () => {
    const dir = await createTempDir();
    const images = new CodexToolImageStore(join(dir, "tool-images"));
    const png = Buffer.from("fake png bytes").toString("base64");

    const summary = summarizeCodexFunctionOutputBody([
      { type: "input_text", text: "Script completed" },
      { type: "input_image", image_url: `data:image/png;base64,${png}` },
      { type: "input_image", image_url: `data:image/png;base64,${png}` }
    ], images)!;

    expect(summary).not.toContain(png);
    const lines = summary.split("\n");
    expect(lines[0]).toBe("Script completed");
    expect(lines[1]).toMatch(/^!\[Tool image\]\(file:.+\.png\)$/u);
    expect(lines[2]).toBe(lines[1]);
    const stored = await readdir(join(dir, "tool-images"));
    expect(stored).toHaveLength(1);
    const src = lines[1]!.slice("![Tool image](".length, -1);
    expect((await readFile(fileURLToPath(src))).toString()).toBe("fake png bytes");
  });

  it("stores MCP image content instead of serializing its data", async () => {
    const dir = await createTempDir();
    const images = new CodexToolImageStore(dir);
    const data = Buffer.from("jpeg bytes").toString("base64");

    const summary = summarizeCodexMcpToolCall({
      type: "mcpToolCall",
      id: "mcp-1",
      server: "blender",
      tool: "get_viewport_screenshot",
      status: "completed",
      arguments: {},
      result: { content: [{ type: "image", data, mimeType: "image/jpeg" }], structuredContent: null },
      error: null,
      durationMs: 1
    } as unknown as Parameters<typeof summarizeCodexMcpToolCall>[0], images);

    expect(summary.outputSummary).toMatch(/^!\[Tool image\]\(file:.+\.jpg\)$/u);
    expect(summary.outputSummary).not.toContain(data);
  });
});
