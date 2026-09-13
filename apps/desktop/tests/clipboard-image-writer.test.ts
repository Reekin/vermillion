import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const image = { isEmpty: vi.fn(() => false), getSize: vi.fn(() => ({ width: 16, height: 9 })) };
  return {
    image,
    createFromDataURL: vi.fn(() => image),
    createFromPath: vi.fn(() => image),
    createFromBuffer: vi.fn(() => image)
  };
});

vi.mock("electron", () => ({
  nativeImage: {
    createFromDataURL: mocks.createFromDataURL,
    createFromPath: mocks.createFromPath,
    createFromBuffer: mocks.createFromBuffer
  }
}));

import { writeVerifiedClipboardImage } from "../src/electron/clipboard-image-writer.js";

beforeEach(() => vi.clearAllMocks());

it("writes and verifies a data URL image", async () => {
  const clipboard = { writeImage: vi.fn(), readImage: vi.fn(() => mocks.image) };
  await expect(writeVerifiedClipboardImage(clipboard as never, "data:image/png;base64,AAAA"))
    .resolves.toEqual({ width: 16, height: 9 });
  expect(mocks.createFromDataURL).toHaveBeenCalledOnce();
  expect(clipboard.writeImage).toHaveBeenCalledWith(mocks.image);
});

it("loads a file URL without its cache query", async () => {
  const clipboard = { writeImage: vi.fn(), readImage: vi.fn(() => mocks.image) };
  await writeVerifiedClipboardImage(clipboard as never, "file:///C:/images/example.png?awb_image_cache=1");
  expect(mocks.createFromPath).toHaveBeenCalledWith("C:\\images\\example.png");
});
