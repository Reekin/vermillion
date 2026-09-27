import type {
  AgentParticipant,
  ParticipantRole
} from "@vermillion/shared";
import { t } from "../../i18n/index.js";

export type ActorRefLike =
  | {
      participantId?: string;
      engineId?: string;
    }
  | undefined;

export type ParticipantIdentity = {
  label: string;
  detail: string;
  kind: "participant" | "engine" | "role" | "unknown";
  participantId?: string;
  engineId?: string;
  role?: ParticipantRole;
  capabilities: string[];
};

export type ParticipantDirectory = {
  byParticipantId: Record<string, AgentParticipant>;
  byEngineId: Record<string, AgentParticipant[]>;
};

const unique = (items: readonly string[]): string[] => [...new Set(items)];

const formatCapabilities = (capabilities: readonly string[]): string =>
  capabilities.length > 0 ? capabilities.join(t("common.listSeparator")) : t("session.noDeclaredCapabilities");

const formatRoleDetail = (role: ParticipantRole | undefined, fallback: string): string =>
  role ? `${role} · ${fallback}` : fallback;

export const buildParticipantDirectory = (
  participants: AgentParticipant[]
): ParticipantDirectory => {
  const byParticipantId: Record<string, AgentParticipant> = {};
  const byEngineId: Record<string, AgentParticipant[]> = {};

  for (const participant of participants) {
    byParticipantId[participant.participantId] = participant;
    const existing = byEngineId[participant.engineId] ?? [];
    byEngineId[participant.engineId] = [...existing, participant];
  }

  return {
    byParticipantId,
    byEngineId
  };
};

export const resolveParticipantIdentity = (
  directory: ParticipantDirectory,
  actor: ActorRefLike,
  fallbackLabel = t("session.unknownActor")
): ParticipantIdentity => {
  if (actor?.participantId) {
    const participant = directory.byParticipantId[actor.participantId];
    if (participant) {
      return {
        label: participant.engineId,
        detail: formatRoleDetail(
          participant.role,
          formatCapabilities(unique(participant.capabilities))
        ),
        kind: "participant",
        participantId: participant.participantId,
        engineId: participant.engineId,
        role: participant.role,
        capabilities: unique(participant.capabilities)
      };
    }
  }

  if (actor?.engineId) {
    const candidates = directory.byEngineId[actor.engineId] ?? [];
    const participant = candidates[0];
    if (participant) {
      return {
        label: participant.engineId,
        detail: formatRoleDetail(
          participant.role,
          formatCapabilities(unique(participant.capabilities))
        ),
        kind: "participant",
        participantId: participant.participantId,
        engineId: participant.engineId,
        role: participant.role,
        capabilities: unique(participant.capabilities)
      };
    }

    return {
      label: actor.engineId,
      detail: t("session.engineIdentityOnly"),
      kind: "engine",
      engineId: actor.engineId,
      capabilities: []
    };
  }

  if (fallbackLabel.trim()) {
    return {
      label: fallbackLabel,
      detail: t("session.roleFallback"),
      kind: "role",
      capabilities: []
    };
  }

  return {
    label: t("session.unknownActor"),
    detail: t("session.identityUnavailable"),
    kind: "unknown",
    capabilities: []
  };
};

export const summarizeParticipant = (
  participant: AgentParticipant
): ParticipantIdentity => ({
  label: participant.engineId,
  detail: formatRoleDetail(
    participant.role,
    formatCapabilities(unique(participant.capabilities))
  ),
  kind: "participant",
  participantId: participant.participantId,
  engineId: participant.engineId,
  role: participant.role,
  capabilities: unique(participant.capabilities)
});
