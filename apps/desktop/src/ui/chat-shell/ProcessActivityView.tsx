import type { ReactElement } from "react";
import {
  Archive,
  Bot,
  Eye,
  Globe,
  Image as ImageIcon,
  ImagePlus,
  Lightbulb,
  List,
  Pencil,
  Search,
  Terminal,
  Wrench,
  type LucideIcon
} from "lucide-react";
import {
  describeToolStep,
  type TerminalStream,
  type ToolCall,
  type Turn,
  type ToolStep,
  type ToolStepKind
} from "@vermillion/shared";
import type { ImageLightboxState } from "./ImageLightbox.js";
import { compareTranscriptItems } from "./transcript-order.js";
import { useLocalImageSrc } from "./local-image-preview.js";
import { normalizeTerminalOutput } from "./terminal-output.js";
import { t } from "../../i18n/index.js";
import { useT } from "../../i18n/react.js";
import { toolStepWords } from "../../i18n/tool-steps.js";

export type ProcessActivityViewProps = {
  turn?: Turn;
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
  onPreviewImage?: (input: ImageLightboxState) => void;
};

export type ProcessActivityEntry = {
  id: string;
  startedAt?: string;
  step: ToolStep;
  inputText?: string;
  outputText?: string;
};

const stepIcons: Record<ToolStepKind, LucideIcon> = {
  think: Lightbulb,
  read: Eye,
  list: List,
  search: Search,
  edit: Pencil,
  run: Terminal,
  web: Globe,
  view: ImageIcon,
  generate: ImagePlus,
  compact: Archive,
  agent: Bot,
  other: Wrench
};

const compareIsoDateAsc = (left?: string, right?: string): number => {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  if (Number.isNaN(leftDate) || Number.isNaN(rightDate)) {
    return left.localeCompare(right);
  }
  return leftDate - rightDate;
};

const splitProcessImageOutput = (
  value: string | undefined
): { alt: string; src: string; text?: string } | undefined => {
  if (!value) {
    return undefined;
  }
  const imageStart = value.indexOf("![");
  if (imageStart < 0) {
    return undefined;
  }
  const altEnd = value.indexOf("](", imageStart + 2);
  if (altEnd < 0) {
    return undefined;
  }
  const srcStart = altEnd + 2;
  const lineEnd = value.indexOf("\n", srcStart);
  const searchEnd = lineEnd >= 0 ? lineEnd : value.length;
  const closeIndex = value.lastIndexOf(")", searchEnd);
  if (closeIndex < srcStart) {
    return undefined;
  }
  const rawSrc = value.slice(srcStart, closeIndex).trim();
  const src =
    rawSrc.startsWith("<") && rawSrc.endsWith(">")
      ? rawSrc.slice(1, -1).trim()
      : rawSrc;
  if (!src) {
    return undefined;
  }
  const text = `${value.slice(0, imageStart)}${value.slice(closeIndex + 1)}`.trim();
  return {
    alt: value.slice(imageStart + 2, altEnd).trim() || t("session.imagePreview"),
    src,
    text: text.length > 0 ? text : undefined
  };
};

const lastExitCode = (streams: TerminalStream[]): number | undefined =>
  streams
    .map((stream) => stream.exitCode)
    .filter((exitCode): exitCode is number => typeof exitCode === "number")
    .at(-1);

const withTerminalStatus = (toolCall: ToolCall, streams: TerminalStream[]): ToolCall => {
  if (streams.some((stream) => stream.status === "failed")) {
    return { ...toolCall, status: "failed" };
  }
  if (streams.some((stream) => stream.status === "running")) {
    return { ...toolCall, status: "running" };
  }
  return toolCall;
};

const terminalStep = (stream: TerminalStream, output: string): ToolStep => {
  const lines = output.split(/\r?\n/).filter((line) => line.trim()).length;
  const running = stream.status === "running";
  const failed = stream.status === "failed" || (typeof stream.exitCode === "number" && stream.exitCode !== 0);
  return {
    kind: "run",
    object: { kind: "terminal" },
    result: running ? { kind: "running" } : failed ? { kind: "failed" } : { kind: "output", lines },
    failed,
    running,
    targets: []
  };
};

/** Tool calls and their terminal output in time order, each described as one readable step. */
export const buildProcessActivityEntries = (
  toolCalls: ToolCall[],
  terminalStreams: TerminalStream[]
): ProcessActivityEntry[] => {
  const streamsByToolCallId = new Map<string, TerminalStream[]>();
  const standaloneStreams: TerminalStream[] = [];

  for (const stream of terminalStreams) {
    if (stream.toolCallId) {
      const group = streamsByToolCallId.get(stream.toolCallId) ?? [];
      group.push(stream);
      streamsByToolCallId.set(stream.toolCallId, group);
      continue;
    }
    standaloneStreams.push(stream);
  }

  const toolIds = new Set(toolCalls.map((toolCall) => toolCall.toolCallId));
  const toolEntries = toolCalls.map((toolCall): ProcessActivityEntry => {
    const linkedStreams = streamsByToolCallId.get(toolCall.toolCallId) ?? [];
    const terminalOutput = linkedStreams
      .map((stream) => normalizeTerminalOutput(stream.outputText))
      .filter((value) => value.length > 0)
      .join("\n\n");
    const outputText = terminalOutput || toolCall.outputSummary;
    const exitCode = lastExitCode(linkedStreams);
    return {
      id: `tool:${toolCall.toolCallId}`,
      startedAt: toolCall.startedAt,
      step: describeToolStep(withTerminalStatus(toolCall, linkedStreams), {
        ...(outputText !== undefined ? { text: outputText } : {}),
        ...(exitCode !== undefined ? { exitCode } : {})
      }),
      ...(toolCall.inputSummary !== undefined ? { inputText: toolCall.inputSummary } : {}),
      ...(outputText !== undefined ? { outputText } : {})
    };
  });

  const orphanLinkedStreams = Array.from(streamsByToolCallId.entries())
    .filter(([toolCallId]) => !toolIds.has(toolCallId))
    .flatMap(([, streams]) => streams);
  const terminalEntries = [...standaloneStreams, ...orphanLinkedStreams].map(
    (stream): ProcessActivityEntry => {
      const outputText = normalizeTerminalOutput(stream.outputText);
      return {
        id: `terminal:${stream.terminalId}`,
        startedAt: stream.startedAt,
        step: terminalStep(stream, outputText),
        outputText
      };
    }
  );

  return [...toolEntries, ...terminalEntries].sort((left, right) => {
    const byDate = compareIsoDateAsc(left.startedAt, right.startedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return left.id.localeCompare(right.id);
  });
};

export const ProcessActivityItemView = ({
  entry,
  onPreviewImage
}: {
  entry: ProcessActivityEntry;
  onPreviewImage?: (input: ImageLightboxState) => void;
}): ReactElement => {
  useT();
  const { step } = entry;
  const words = toolStepWords(step);
  const Icon = stepIcons[step.kind];
  const rawOutputText = entry.outputText?.trim();
  const inputText = entry.inputText?.trim();
  const outputText = rawOutputText && rawOutputText !== inputText ? rawOutputText : undefined;
  const imageOutput = splitProcessImageOutput(outputText);
  const imagePreviewSrc = useLocalImageSrc(imageOutput?.src, entry.id);
  const imageText =
    imageOutput?.text === `path: ${inputText}` ? undefined : imageOutput?.text;
  const row = (
    <>
      <Icon className="awb-process-step__icon" size={14} aria-hidden="true" />
      <span className="awb-process-step__verb">{words.verb}</span>
      <span className="awb-process-step__object">{words.object}</span>
      <span className="awb-process-step__result">
        {step.running ? <span className="awb-process-step__spinner" aria-hidden="true" /> : null}
        {words.result}
      </span>
    </>
  );
  if (!inputText && !outputText) {
    return (
      <div className="awb-process-step" data-kind={step.kind} data-failed={step.failed || undefined}>
        <div className="awb-process-step__row">{row}</div>
      </div>
    );
  }
  return (
    <details className="awb-process-step" data-kind={step.kind} data-failed={step.failed || undefined}>
      <summary className="awb-process-step__row">{row}</summary>
      <div className="awb-process-step__body">
        {inputText ? <code className="awb-process-step__input">{inputText}</code> : null}
        {imageOutput ? (
          <div className="awb-process-step__media-output">
            {onPreviewImage ? (
              <button
                type="button"
                className="awb-inline-image-button"
                onClick={() =>
                  onPreviewImage({
                    src: imagePreviewSrc ?? imageOutput.src,
                    alt: imageOutput.alt
                  })
                }
              >
                <img src={imagePreviewSrc} alt={imageOutput.alt} />
              </button>
            ) : (
              <img className="awb-process-step__image" src={imagePreviewSrc} alt={imageOutput.alt} />
            )}
            {imageText ? <pre className="awb-process-step__output">{imageText}</pre> : null}
          </div>
        ) : outputText ? (
          <pre className="awb-process-step__output">{outputText}</pre>
        ) : null}
      </div>
    </details>
  );
};

export const ProcessActivityView = ({
  turn,
  toolCalls,
  terminalStreams,
  onPreviewImage
}: ProcessActivityViewProps): ReactElement => {
  const t = useT();
  const entries = buildProcessActivityEntries(toolCalls, terminalStreams);
  if (turn) entries.sort(compareTranscriptItems(turn));

  if (entries.length === 0) {
    return <p className="awb-detail__empty">{t("session.noProcessSteps")}</p>;
  }

  return (
    <div className="awb-process-steps">
      {entries.map((entry) => (
        <ProcessActivityItemView key={entry.id} entry={entry} onPreviewImage={onPreviewImage} />
      ))}
    </div>
  );
};
