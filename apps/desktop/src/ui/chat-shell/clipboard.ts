export const writeClipboardText = async (text: string): Promise<void> => {
  const desktopWriter = window.sessionDesktop?.writeClipboardText;
  if (desktopWriter) {
    await desktopWriter(text);
    return;
  }

  if (!navigator.clipboard) {
    throw new Error("Clipboard API is unavailable.");
  }
  await navigator.clipboard.writeText(text);
};

export const writeClipboardImage = async (source: string): Promise<void> => {
  const desktopWriter = window.sessionDesktop?.writeClipboardImage;
  if (desktopWriter) {
    await desktopWriter(source);
    return;
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard API is unavailable.");
  }
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Image request failed (${response.status}).`);
  const blob = await response.blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
};
