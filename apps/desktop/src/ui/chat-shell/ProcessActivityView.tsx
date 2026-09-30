import { useState, type ReactElement } from "react";
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
import { DiffHunks, DiffStat } from "./DiffView.js";
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

type ProcessImage = { alt: string; src: string };

/** A whole output line of the form `![alt](src)`; the src may itself contain parentheses. */
const parseImageLine = (line: string): ProcessImage | undefined => {
  const value = line.trim();
  if (!value.startsWith("![") || !value.endsWith(")")) {
    return undefined;
  }
  const altEnd = value.indexOf("](");
  if (altEnd < 0) {
    return undefined;
  }
  const rawSrc = value.slice(altEnd + 2, -1).trim();
  const src =
    rawSrc.startsWith("<") && rawSrc.endsWith(">")
      ? rawSrc.slice(1, -1).trim()
      : rawSrc;
  if (!src) {
    return undefined;
  }
  return {
    alt: value.slice(2, altEnd).trim() || t("session.imagePreview"),
    src
  };
};

const splitProcessImageOutput = (
  value: string
): { images: ProcessImage[]; text?: string } => {
  const images: ProcessImage[] = [];
  const textLines: string[] = [];
  for (const line of value.split("\n")) {
    const image = parseImageLine(line);
    if (image) {
      images.push(image);
    } else {
      textLines.push(line);
    }
  }
  const text = textLines.join("\n").trim();
  return { images, text: text.length > 0 ? text : undefined };
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

const ProcessStepImage = ({
  image,
  cacheKey,
  onPreviewImage
}: {
  image: ProcessImage;
  cacheKey: string;
  onPreviewImage?: (input: ImageLightboxState) => void;
}): ReactElement => {
  const src = useLocalImageSrc(image.src, cacheKey);
  return onPreviewImage ? (
    <button
      type="button"
      className="awb-inline-image-button"
      onClick={() => onPreviewImage({ src: src ?? image.src, alt: image.alt })}
    >
      <img src={src} alt={image.alt} loading="lazy" />
    </button>
  ) : (
    <img className="awb-process-step__image" src={src} alt={image.alt} loading="lazy" />
  );
};

const ProcessStepBody = ({
  entryId,
  inputText,
  outputText,
  diff,
  onPreviewImage
}: {
  entryId: string;
  inputText?: string;
  outputText?: string;
  /** The output is the patch an edit applied; it already names the files. */
  diff: boolean;
  onPreviewImage?: (input: ImageLightboxState) => void;
}): ReactElement => {
  if (diff && outputText) {
    return (
      <div className="awb-process-step__body">
        <div className="awb-process-step__diff">
          <DiffHunks diff={outputText} showPaths />
        </div>
      </div>
    );
  }
  const output = outputText ? splitProcessImageOutput(outputText) : undefined;
  const images = output?.images ?? [];
  const text = images.length > 0 && output?.text === `path: ${inputText}` ? undefined : output?.text;
  return (
    <div className="awb-process-step__body">
      {inputText ? <code className="awb-process-step__input">{inputText}</code> : null}
      {images.length > 0 ? (
        <div className="awb-process-step__media-output">
          {images.map((image, index) => (
            <ProcessStepImage key={index} image={image} cacheKey={entryId} onPreviewImage={onPreviewImage} />
          ))}
          {text ? <pre className="awb-process-step__output">{text}</pre> : null}
        </div>
      ) : text ? (
        <pre className="awb-process-step__output">{text}</pre>
      ) : null}
    </div>
  );
};

export const ProcessActivityItemView = ({
  entry,
  onPreviewImage
}: {
  entry: ProcessActivityEntry;
  onPreviewImage?: (input: ImageLightboxState) => void;
}): ReactElement => {
  useT();
  const [open, setOpen] = useState(false);
  const { step } = entry;
  const words = toolStepWords(step);
  const Icon = stepIcons[step.kind];
  const rawOutputText = entry.outputText?.trim();
  const inputText = entry.inputText?.trim();
  const outputText = rawOutputText && rawOutputText !== inputText ? rawOutputText : undefined;
  const diffResult = step.result?.kind === "diff" ? step.result : undefined;
  const row = (
    <>
      <Icon className="awb-process-step__icon" size={14} aria-hidden="true" />
      <span className="awb-process-step__verb">{words.verb}</span>
      <span className="awb-process-step__object">{words.object}</span>
      <span className="awb-process-step__result">
        {step.running ? <span className="awb-process-step__spinner" aria-hidden="true" /> : null}
        {diffResult ? <DiffStat added={diffResult.added} deleted={diffResult.deleted} /> : words.result}
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
    <details
      className="awb-process-step"
      data-kind={step.kind}
      data-failed={step.failed || undefined}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="awb-process-step__row">{row}</summary>
      {open ? (
        <ProcessStepBody
          entryId={entry.id}
          inputText={inputText}
          outputText={outputText}
          diff={Boolean(diffResult)}
          onPreviewImage={onPreviewImage}
        />
      ) : null}
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
