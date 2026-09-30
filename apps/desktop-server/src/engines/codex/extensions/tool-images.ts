import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filePathToFileUri } from "@vermillion/shared";

const dataImagePattern = /^data:image\/([a-z0-9.+-]+);base64,/iu;
const imageExtensions: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  jpg: "jpg",
  gif: "gif",
  webp: "webp",
  "svg+xml": "svg"
};

/**
 * Keeps tool-output images out of transcript text: inline data images are written once
 * under `dir` (named by content hash) and referenced by file URL.
 */
export class CodexToolImageStore {
  public constructor(private readonly dir: string) {}

  /** Returns a loadable image URL, or undefined when the value is not an image reference. */
  public resolve(value: string): string | undefined {
    const source = value.trim();
    const match = dataImagePattern.exec(source);
    if (!match) {
      return /^(?:https?:|file:)/iu.test(source) ? source : undefined;
    }
    const bytes = Buffer.from(source.slice(match[0].length), "base64");
    if (bytes.length === 0) {
      return undefined;
    }
    const extension = imageExtensions[match[1]!.toLowerCase()] ?? "png";
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    const path = join(this.dir, `${hash}.${extension}`);
    try {
      if (!existsSync(path)) {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(path, bytes);
      }
    } catch {
      return undefined;
    }
    return filePathToFileUri(path);
  }
}
