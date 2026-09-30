import { describe, expect, it } from "vitest";
import { loadedPathRange } from "../src/ui/chat-shell/MobileSessionPane.js";

describe("mobile paged path", () => {
  const path = ["a", "b", "c", "d", "e"];
  it("shows the loaded run ending at the newest loaded turn", () => {
    expect(loadedPathRange(path, (id) => ["c", "d", "e"].includes(id))).toEqual({ start: 2, end: 5 });
  });
  it("never shows across a gap, so older loaded turns wait for the missing page", () => {
    expect(loadedPathRange(path, (id) => ["a", "d", "e"].includes(id))).toEqual({ start: 3, end: 5 });
  });
  it("ends at a loaded turn when the newest path turn has not arrived yet", () => {
    expect(loadedPathRange(path, (id) => ["c", "d"].includes(id))).toEqual({ start: 2, end: 4 });
  });
});
