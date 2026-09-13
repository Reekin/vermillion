import type { Clipboard, NativeImage } from "electron";
import { nativeImage } from "electron";
import { fileURLToPath } from "node:url";

const loadClipboardImage = async (source: string): Promise<NativeImage> => {
  const url = new URL(source);
  if (url.protocol === "data:") return nativeImage.createFromDataURL(source);
  if (url.protocol === "file:") return nativeImage.createFromPath(fileURLToPath(url));
  if (url.protocol === "http:" || url.protocol === "https:") {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Image request failed (${response.status}).`);
    return nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
  }
  throw new Error(`Unsupported image source: ${url.protocol}`);
};

export const writeVerifiedClipboardImage = async (
  clipboard: Pick<Clipboard, "writeImage" | "readImage">,
  source: string
): Promise<{ width: number; height: number }> => {
  const image = await loadClipboardImage(source);
  if (image.isEmpty()) throw new Error("The image could not be decoded.");
  clipboard.writeImage(image);
  const copied = clipboard.readImage();
  if (copied.isEmpty()) throw new Error("The clipboard did not retain the image.");
  return copied.getSize();
};
