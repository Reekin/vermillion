import type {
  ChatInteractionCapabilitiesRpc,
  ComposerSlashSuggestionRpc
} from "@vermillion/shared";
import type { SlashSuggestionItem } from "./composer-types.js";

const matchesSlashQuery = (label: string, query: string): boolean =>
  label.toLowerCase().includes(`/${query.trim().toLowerCase()}`);

const toSlashSuggestionItem = (
  suggestion: ComposerSlashSuggestionRpc
): SlashSuggestionItem => ({
  id: `slash:${suggestion.id}`,
  kind: "slash",
  label: suggestion.label,
  detail: suggestion.detail,
  replacement: suggestion.replacement
});

export const resolveSlashSuggestionItems = (input: {
  capabilities: ChatInteractionCapabilitiesRpc;
  query: string;
  canResumeSession: boolean;
  canInterrupt: boolean;
}): SlashSuggestionItem[] => {
  const items: SlashSuggestionItem[] = [];
  const seenLabels = new Set<string>();

  const append = (item: SlashSuggestionItem): void => {
    const normalizedLabel = item.label.toLowerCase();
    if (seenLabels.has(normalizedLabel)) {
      return;
    }
    seenLabels.add(normalizedLabel);
    items.push(item);
  };

  if (input.canResumeSession) {
    append({
      id: "slash:resume-session",
      kind: "slash",
      label: "/resume",
      detail: "Reload the current thread window",
      action: "resume-session"
    });
  }

  for (const suggestion of input.capabilities.slashSuggestions) {
    append(toSlashSuggestionItem(suggestion));
  }

  if (input.canInterrupt) {
    append({
      id: "slash:interrupt",
      kind: "slash",
      label: "/interrupt",
      detail: "Interrupt the active turn",
      action: "interrupt"
    });
  }

  return items.filter((item) => matchesSlashQuery(item.label, input.query));
};
