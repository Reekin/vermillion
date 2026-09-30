import { useEffect, useState } from "react";

const localFileImageProtocols = new Set(["file:"]);

export const buildLocalImagePreviewSrc = (
  src: string | undefined,
  cacheKey: string
): string | undefined => {
  if (!src) {
    return src;
  }

  try {
    const url = new URL(src);
    if (!localFileImageProtocols.has(url.protocol)) {
      return src;
    }
    url.searchParams.set("awb_image_cache", cacheKey);
    return url.toString();
  } catch {
    return src;
  }
};

/** Loads a desktop file image where the page cannot read `file:` URLs itself, returning a displayable URL. */
export type LocalImageLoader = (fileUrl: string) => Promise<string>;

let loader: LocalImageLoader | undefined;
const loaded = new Map<string, Promise<string>>();

/** Set by a host that cannot open `file:` URLs, such as the phone page reading images through the desktop. */
export const setLocalImageLoader = (next: LocalImageLoader | undefined): void => {
  loader = next;
  loaded.clear();
};

/** The src to render for an image: file images go through the host's loader when one is set. */
export const useLocalImageSrc = (src: string | undefined, cacheKey: string): string | undefined => {
  const current = loader;
  const remote = Boolean(current && src?.startsWith("file:"));
  const [resolved, setResolved] = useState<{ src: string; url: string }>();
  useEffect(() => {
    if (!remote || !src || !current) return;
    let active = true;
    let pending = loaded.get(src);
    if (!pending) {
      pending = current(src);
      loaded.set(src, pending);
      pending.catch(() => loaded.delete(src));
    }
    pending.then((url) => { if (active) setResolved({ src, url }); }, () => undefined);
    return () => { active = false; };
  }, [current, remote, src]);
  if (!remote) return buildLocalImagePreviewSrc(src, cacheKey);
  return resolved && resolved.src === src ? resolved.url : undefined;
};
