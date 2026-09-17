import { filePathToFileUri, fileUriToPath } from "@vermillion/shared";

const windowsDrivePathPattern = /^[A-Za-z]:[\\/]/u;
/** Agents sometimes emit a drive path with one stray leading slash: `/I:/repo/x.ts`. */
const leadingSlashDrivePathPattern = /^\/[A-Za-z]:[\\/]/u;
const locationSuffixPattern = /(?::\d+(?:-\d+)?(?::\d+)?|#L\d+(?:-L?\d+)?)$/iu;

export type LocalFileTarget = {
  /** Filesystem path the host opens. Never carries a line number. */
  path: string;
  /** Location as written by the agent, e.g. `:397`, `#L42-L50`. */
  location?: string;
  /** Target as written, used for the hover title and for copying a location. */
  target: string;
};

/** Markdown parsers URI-encode destinations, so targets arrive encoded and may need decoding. */
const decodeTarget = (target: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(target);
    return leadingSlashDrivePathPattern.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return undefined;
  }
};

/**
 * Splits a local file target into the openable path and an optional location suffix.
 * Only the five shapes the agents actually write are recognised; anything else is one path.
 */
export const parseLocalFileTarget = (target: string): LocalFileTarget | undefined => {
  const decoded = decodeTarget(target);
  if (decoded === undefined || !windowsDrivePathPattern.test(decoded)) {
    return undefined;
  }
  const match = locationSuffixPattern.exec(decoded);
  if (!match) {
    return { path: decoded, target: decoded };
  }
  const path = decoded.slice(0, match.index);
  if (path.length === 0 || path.endsWith(":")) {
    return { path: decoded, target: decoded };
  }
  return { path, location: match[0], target: decoded };
};

/** Markdown parsers URI-encode destinations before passing them to renderers. */
export const localMarkdownFileUrl = (target: string): string | undefined => {
  if (fileUriToPath(target) !== undefined) return target;
  const decoded = decodeTarget(target);
  if (decoded === undefined || !windowsDrivePathPattern.test(decoded)) return undefined;
  return filePathToFileUri(decoded).replace(/#/g, "%23").replace(/\?/g, "%3F");
};
