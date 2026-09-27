import { useEffect, useRef, useState, type ReactElement } from "react";
import { ChevronDown } from "lucide-react";
import { useT } from "../../../i18n/react.js";
import type {
  EngineModelRpc,
  EngineReasoningOptionRpc,
  EngineServiceTierRpc
} from "@vermillion/shared";
import type { ComposerExecutionSelection } from "./composer-types.js";

type Option = { id: string; label: string; description?: string };

export type ExecutionConfigControlProps = {
  models: EngineModelRpc[];
  reasoningOptions: EngineReasoningOptionRpc[];
  serviceTiers: EngineServiceTierRpc[];
  selectedExecution?: ComposerExecutionSelection;
  defaultReasoningLabel?: string;
  loading: boolean;
  disabled: boolean;
  onModelChange: (modelId: string) => void;
  onReasoningOptionChange: (reasoningOptionId: string) => void;
  onServiceTierChange: (serviceTierId: string) => void;
};

const OptionGroup = ({
  title,
  options,
  selectedId,
  onSelect
}: {
  title: string;
  options: Option[];
  selectedId: string;
  onSelect: (id: string) => void;
}): ReactElement => (
  <div className="awb-execution-config__group" role="group" aria-label={title}>
    <span className="awb-execution-config__group-title">{title}</span>
    {options.map((option) => (
      <button
        key={option.id || "default"}
        type="button"
        className="awb-execution-config__option"
        aria-pressed={option.id === selectedId}
        title={option.description}
        onClick={() => onSelect(option.id)}
      >
        {option.label}
      </button>
    ))}
  </div>
);

/**
 * One composer control for model, reasoning and speed: the button reads "模型名 推理 · 速度",
 * the panel above it picks each part. The panel stays open so several parts can change in turn.
 */
export const ExecutionConfigControl = ({
  models,
  reasoningOptions,
  serviceTiers,
  selectedExecution,
  defaultReasoningLabel,
  loading,
  disabled,
  onModelChange,
  onReasoningOptionChange,
  onServiceTierChange
}: ExecutionConfigControlProps): ReactElement => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const model = models.find((candidate) => candidate.modelId === selectedExecution?.modelId);
  const reasoningId = selectedExecution?.reasoningOptionId ?? "";
  const tierId = selectedExecution?.serviceTierId ?? "";
  const reasoningLabel = reasoningId
    ? (reasoningOptions.find((option) => option.optionId === reasoningId)?.displayName ?? reasoningId)
    : (defaultReasoningLabel ?? t("session.configDefault"));
  const tierLabel = tierId
    ? (serviceTiers.find((tier) => tier.tierId === tierId)?.displayName ?? tierId)
    : t("session.configStandardTier");
  const details = [
    reasoningOptions.length > 0 ? reasoningLabel : undefined,
    serviceTiers.length > 0 ? tierLabel : undefined
  ].filter(Boolean).join(" · ");

  return (
    <div className="awb-execution-config" ref={rootRef}>
      <button
        type="button"
        className="awb-configuration-control awb-execution-config__trigger"
        aria-label={t("session.modelConfig")}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled || loading || models.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="awb-execution-config__model">
          {loading ? t("session.loadingModels") : (model?.displayName ?? t("session.selectModel"))}
        </span>
        {!loading && details ? <span className="awb-execution-config__details">{details}</span> : null}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="awb-execution-config__panel" role="dialog" aria-label={t("session.modelConfig")}>
          <OptionGroup
            title={t("session.configModel")}
            options={models.map((candidate) => ({
              id: candidate.modelId,
              label: candidate.displayName,
              ...(candidate.description ? { description: candidate.description } : {})
            }))}
            selectedId={selectedExecution?.modelId ?? ""}
            onSelect={onModelChange}
          />
          {reasoningOptions.length > 0 ? (
            <OptionGroup
              title={t("session.configReasoning")}
              options={[
                { id: "", label: defaultReasoningLabel ? t("session.configDefaultWith", { label: defaultReasoningLabel }) : t("session.configDefault") },
                ...reasoningOptions.map((option) => ({
                  id: option.optionId,
                  label: option.displayName,
                  ...(option.description ? { description: option.description } : {})
                }))
              ]}
              selectedId={reasoningId}
              onSelect={onReasoningOptionChange}
            />
          ) : null}
          {serviceTiers.length > 0 ? (
            <OptionGroup
              title={t("session.configSpeed")}
              options={[
                { id: "", label: t("session.configStandardTier") },
                ...serviceTiers.map((tier) => ({
                  id: tier.tierId,
                  label: tier.displayName,
                  ...(tier.description ? { description: tier.description } : {})
                }))
              ]}
              selectedId={tierId}
              onSelect={onServiceTierChange}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
