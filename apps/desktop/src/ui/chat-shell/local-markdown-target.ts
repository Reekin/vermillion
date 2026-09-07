import { filePathToFileUri, fileUriToPath } from "@vermillion/shared";

/** Markdown parsers URI-encode destinations before passing them to renderers. */
export const localMarkdownFileUrl = (target: string): string | undefined => {
  if (fileUriToPath(target) !== undefined) return target;
  try {
    const path = decodeURIComponent(target);
    if (!/^[A-Za-z]:[\\/]/u.test(path)) return undefined;
    return filePathToFileUri(path).replace(/#/g, "%23").replace(/\?/g, "%3F");
  } catch {
    return undefined;
  }
};
