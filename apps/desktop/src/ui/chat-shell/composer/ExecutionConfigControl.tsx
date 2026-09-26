import { useEffect, useRef, useState, type ReactElement } from "react";
import { ChevronDown } from "lucide-react";
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
    : (defaultReasoningLabel ?? "默认");
  const tierLabel = tierId
    ? (serviceTiers.find((tier) => tier.tierId === tierId)?.displayName ?? tierId)
    : "标准";
  const details = [
    reasoningOptions.length > 0 ? reasoningLabel : undefined,
    serviceTiers.length > 0 ? tierLabel : undefined
  ].filter(Boolean).join(" · ");

  return (
    <div className="awb-execution-config" ref={rootRef}>
      <button
        type="button"
        className="awb-configuration-control awb-execution-config__trigger"
        aria-label="模型配置"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled || loading || models.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="awb-execution-config__model">
          {loading ? "加载模型…" : (model?.displayName ?? "选择模型")}
        </span>
        {!loading && details ? <span className="awb-execution-config__details">{details}</span> : null}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="awb-execution-config__panel" role="dialog" aria-label="模型配置">
          <OptionGroup
            title="模型"
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
              title="推理"
              options={[
                { id: "", label: defaultReasoningLabel ? `默认 (${defaultReasoningLabel})` : "默认" },
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
              title="速度"
              options={[
                { id: "", label: "标准" },
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
