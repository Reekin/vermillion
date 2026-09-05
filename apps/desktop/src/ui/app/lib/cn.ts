import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Our font-size scale uses role names; teach tailwind-merge so they don't collide with text colors. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "caption", "label", "body", "title-sm", "title"] }]
    }
  }
});

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
