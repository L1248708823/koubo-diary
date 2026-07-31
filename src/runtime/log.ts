export type LogFields = Record<string, unknown>;

export function logInfo(event: string, fields: LogFields = {}): void {
  writeLog("INFO", event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
  writeLog("ERROR", event, fields);
}

function writeLog(level: "INFO" | "ERROR", event: string, fields: LogFields): void {
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    level,
    event,
    ...fields,
  };
  const line = `[koubo] ${JSON.stringify(payload)}`;
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function logAgentOutput(
  provider: string,
  channel: "stdout" | "stderr",
  chunk: Buffer,
): void {
  if (process.env.LOG_AGENT_OUTPUT !== "1") return;
  const text = chunk.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const payload = {
      ts: new Date().toISOString(),
      pid: process.pid,
      level: channel === "stderr" ? "ERROR" : "INFO",
      event: "agent.output",
      provider,
      channel,
      message: line,
    };
    const rendered = `[koubo] ${JSON.stringify(payload)}`;
    if (channel === "stderr") console.error(rendered);
    else console.log(rendered);
  }
}
