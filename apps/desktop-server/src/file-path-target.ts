import { pathToFileURL } from "node:url";
import { toDisplayPath } from "@vermillion/shared";

export type FilePathTarget = {
  rawPath: string;
  displayPath: string;
  fileUrl: string;
};

export const createFilePathTarget = (rawPath: string): FilePathTarget => {
  const displayPath = toDisplayPath(rawPath);
  return {
    rawPath,
    displayPath,
    fileUrl: pathToFileURL(displayPath).href
  };
};
