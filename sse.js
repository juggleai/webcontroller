export const DEFAULT_MAX_SSE_RECORD_BYTES = 540 * 1024;

export class SSELimitError extends Error {
  constructor(message = "SSE record exceeds the configured limit") {
    super(message);
    this.name = "SSELimitError";
  }
}

export function createSSEParser({ maxRecordBytes = DEFAULT_MAX_SSE_RECORD_BYTES } = {}) {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) throw new TypeError("maxRecordBytes must be a positive integer");
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let text = "";
  let data = [];
  let event = "";
  let lastEventId = "";
  let recordBytes = 0;

  function resetRecord() {
    data = [];
    event = "";
    recordBytes = 0;
  }

  function dispatch(output) {
    if (data.length === 0) {
      resetRecord();
      return;
    }
    output.push({ type: event || "message", data: data.join("\n"), id: lastEventId });
    resetRecord();
  }

  function line(value, output) {
    if (value === "") {
      dispatch(output);
      return;
    }
    recordBytes += encoder.encode(value).byteLength + 1;
    if (recordBytes > maxRecordBytes) throw new SSELimitError();
    if (value[0] === ":") return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let fieldValue = colon < 0 ? "" : value.slice(colon + 1);
    if (fieldValue[0] === " ") fieldValue = fieldValue.slice(1);
    if (field === "data") data.push(fieldValue);
    else if (field === "event") event = fieldValue;
    else if (field === "id" && !fieldValue.includes("\0")) lastEventId = fieldValue;
  }

  function process(final) {
    const output = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code !== 10 && code !== 13) continue;
      if (code === 13 && index + 1 === text.length && !final) break;
      line(text.slice(start, index), output);
      if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
      start = index + 1;
    }
    text = text.slice(start);
    if (encoder.encode(text).byteLength + recordBytes > maxRecordBytes) throw new SSELimitError();
    if (final) {
      if (text !== "") line(text, output);
      text = "";
      dispatch(output);
    }
    return output;
  }

  return {
    push(chunk) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError("SSE chunks must be Uint8Array values");
      text += decoder.decode(chunk, { stream: true });
      return process(false);
    },
    finish() {
      text += decoder.decode();
      return process(true);
    },
  };
}

export async function consumeSSEStream(readable, onRecord, options) {
  if (!readable?.getReader || typeof onRecord !== "function") throw new TypeError("A readable byte stream and callback are required");
  const parser = createSSEParser(options);
  const reader = readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      const records = done ? parser.finish() : parser.push(value);
      for (const record of records) await onRecord(record);
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
