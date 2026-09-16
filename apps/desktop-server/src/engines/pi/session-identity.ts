export const piEngineId = "pi";
export const piProviderKind = "pi-session";

/** 会话开始时由随包扩展写入的轮次标记；标记条目 id 就是引擎轮次 id。 */
export const piTurnEntryType = "vermillion.turn";

/** 由工作台扩展补写的用户消息标记，携带工作台分配的消息 id。 */
export const piMessageEntryType = "vermillion.message";

export const discoveredPiSessionId = (piSessionId: string): string =>
  `${piProviderKind}:${piSessionId}`;

/**
 * pi 会话 id 必须只含字母数字、`-`、`_`、`.`，并且首尾为字母数字。
 * 工作台会话 id 本身合法时直接沿用，这样重启后无需任何内存状态就能定位会话文件。
 */
export const piSessionIdForSession = (sessionId: string): string => {
  const prefix = `${piProviderKind}:`;
  if (sessionId.startsWith(prefix)) {
    return sessionId.slice(prefix.length);
  }
  const sanitized = sessionId
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .replace(/[^A-Za-z0-9]+$/u, "");
  if (sanitized.length > 0) {
    return sanitized;
  }
  return `pi-${stableHash(sessionId)}`;
};

/** 兜底 id 只要求确定且合法，不要求可读。 */
const stableHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};
