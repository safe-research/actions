const { chatCompletion } = require("./llm.js");
const { truncate } = require("./tools.js");

// Responses up to this size are returned as they are, even with a question.
const EXTRACT_THRESHOLD_BYTES = 8 * 1024;
// Cap of the extracted lines returned to the review model.
const EXTRACT_MAX_BYTES = 8 * 1024;
// Size of the part of the text sent to the support model in one request; small enough for an 8k context window.
const CHUNK_BYTES = 16 * 1024;
// Only this much of a response is searched, so a huge document doesn't turn into dozens of requests.
const MAX_INPUT_BYTES = 256 * 1024;
// Long lines (e.g. minified code) are cut in the prompt; the extract still contains the full line.
const MAX_PROMPT_LINE_CHARS = 500;
// Lines added around each selected range: small models are often off by a line or two.
const CONTEXT_LINES = 2;
// Lines shown when nothing matched, usually the title and the table of contents.
const PREVIEW_LINES = 30;

// The model only answers with line numbers. The action copies the lines, so the extract can't contain anything that
// isn't in the document, and the answer stays short, which keeps small models fast.
const EXTRACT_SYSTEM_PROMPT = `You help a code reviewer find information in a long document. You get a question and one part of the document with numbered lines. Select the lines that answer the question, plus the lines needed to understand them (e.g. the heading, signature or table header they belong to). Don't answer the question and don't copy any text.

Answer with exactly one line: the line numbers or ranges, e.g. \`12-30, 41, 55-57\`, or \`NONE\` if no line in this part is relevant.`;

// Cuts `text` to at most `maxBytes`, at the end of the last complete line.
function cutAtLine(text, maxBytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  const end = buffer.lastIndexOf(0x0a, maxBytes);
  return buffer.subarray(0, end > 0 ? end : maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

function lineRange(start, end) {
  return start === end ? String(start) : `${start}-${end}`;
}

// Pretty-prints JSON, so that minified documents (e.g. npm packuments) have lines to select. Returns the lines.
function prepareLines(text, contentType) {
  let prepared = text;
  if (/json/i.test(contentType || "") || /^\s*[[{]/.test(text)) {
    try {
      prepared = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // not JSON after all
    }
  }
  const lines = prepared.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

// Splits lines into chunks of at most `maxBytes` (a longer single line is a chunk of its own). Returns 1-based
// inclusive `[start, end]` line ranges.
function chunkLines(lines, maxBytes = CHUNK_BYTES) {
  const chunks = [];
  let start = 1;
  let size = 0;
  lines.forEach((line, i) => {
    const bytes = Math.min(Buffer.byteLength(line), MAX_PROMPT_LINE_CHARS * 4) + 8;
    if (size > 0 && size + bytes > maxBytes) {
      chunks.push([start, i]);
      start = i + 1;
      size = 0;
    }
    size += bytes;
  });
  if (lines.length > 0) chunks.push([start, lines.length]);
  return chunks;
}

function buildExtractPrompt(question, lines, [start, end]) {
  const numbered = lines.slice(start - 1, end).map((line, i) => {
    const shown = line.length > MAX_PROMPT_LINE_CHARS ? `${line.slice(0, MAX_PROMPT_LINE_CHARS)}…` : line;
    return `${start + i}\t${shown}`;
  });
  return `Question: ${question}\n\nLines ${start}-${end} of the document:\n\n${numbered.join("\n")}`;
}

// Parses an answer like `12-30, 41` (tolerating Markdown, "lines", en dashes and surrounding text) into ranges
// clamped to `[first, last]`. Returns `[]` for `NONE` and `undefined` if the answer contains neither.
function parseRanges(content, [first, last]) {
  const text = String(content ?? "");
  const ranges = [];
  for (const match of text.matchAll(/(\d+)(?:\s*(?:-|–|—|to|\.\.)\s*(\d+))?/g)) {
    let start = Number(match[1]);
    let end = Number(match[2] ?? match[1]);
    if (start > end) [start, end] = [end, start];
    if (end < first || start > last) continue;
    ranges.push([Math.max(start, first), Math.min(end, last)]);
  }
  if (ranges.length > 0) return ranges;
  if (/\bNONE\b/i.test(text)) return [];
  // Numbers that were all outside the chunk count as "nothing selected" rather than as an unparseable answer.
  if (/\d/.test(text)) return [];
  return undefined;
}

// Adds `context` lines around each range, then sorts and merges overlapping or adjacent ranges.
function mergeRanges(ranges, totalLines, context = CONTEXT_LINES) {
  const padded = ranges
    .map(([start, end]) => [Math.max(1, start - context), Math.min(totalLines, end + context)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of padded) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

// Copies the lines of the ranges with their line numbers, separated by `…` where lines are skipped.
function renderRanges(lines, ranges) {
  return ranges
    .map(([start, end]) => lines.slice(start - 1, end).map((line, i) => `${start + i}\t${line}`).join("\n"))
    .join("\n…\n");
}

// Creates `extract({ text, contentType, question, url })`, which returns the lines of `text` that answer `question`,
// selected by `model` (one request per chunk, sent one after the other) and copied verbatim with their line numbers.
// It returns `undefined` if any request fails or gives no parseable answer, so the caller can fall back to the plain
// text. `usage` sums the token usage of all requests.
function createExtractor(core, { endpoint, apiKey, model, maxBytes = EXTRACT_MAX_BYTES, chunkBytes = CHUNK_BYTES, maxInputBytes = MAX_INPUT_BYTES }) {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  async function selectRanges(question, lines, chunk) {
    const response = await chatCompletion(core, {
      endpoint,
      apiKey,
      model,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: buildExtractPrompt(question, lines, chunk) },
      ],
    });
    for (const key of Object.keys(usage)) usage[key] += response.usage?.[key] || 0;
    const ranges = parseRanges(response.message.content, chunk);
    if (!ranges) throw new Error(`no line ranges in the answer for lines ${lineRange(...chunk)}: ${String(response.message.content).slice(0, 200)}`);
    return ranges;
  }

  async function extract({ text, contentType, question, url }) {
    const label = `${url} "${question}"`;
    const searched = cutAtLine(text, maxInputBytes);
    const lines = prepareLines(searched, contentType);
    const chunks = chunkLines(lines, chunkBytes);
    let selected;
    try {
      // One request at a time: self-hosted servers may not queue concurrent requests, and the review model waits
      // for the result anyway.
      selected = [];
      for (const chunk of chunks) selected.push(...(await selectRanges(question, lines, chunk)));
    } catch (err) {
      core.warning(`ai-review: extract: ${label} failed (${err.message}); returning the text from the start.`);
      return undefined;
    }
    const partial = searched !== text ? ` Only the first ${maxInputBytes} bytes of the response were searched.` : "";
    const size = `${lines.length} lines, ${Buffer.byteLength(text)} bytes`;
    if (selected.length === 0) {
      core.info(`ai-review: extract: ${label}: nothing selected in ${chunks.length} chunk(s)`);
      const preview = renderRanges(lines, [[1, Math.min(PREVIEW_LINES, lines.length)]]);
      return truncate(`No lines matched the question "${question}" (${size}).${partial} Ask a different question, or fetch a more specific URL. The first lines:\n\n${preview}`, maxBytes);
    }
    const ranges = mergeRanges(selected, lines.length);
    const output = truncate(
      `Extract for the question "${question}": lines ${ranges.map((range) => lineRange(...range)).join(", ")} of ${size}, selected by a smaller model.${partial} If something is missing, ask a more specific question.\n\n${renderRanges(lines, ranges)}`,
      maxBytes,
    );
    core.info(`ai-review: extract: ${label}: lines ${ranges.map((range) => lineRange(...range)).join(", ")} of ${lines.length} (${Buffer.byteLength(text)} -> ${Buffer.byteLength(output)} bytes)`);
    return output;
  }

  return { extract, usage };
}

module.exports = {
  EXTRACT_THRESHOLD_BYTES,
  EXTRACT_SYSTEM_PROMPT,
  createExtractor,
  prepareLines,
  chunkLines,
  buildExtractPrompt,
  parseRanges,
  mergeRanges,
  renderRanges,
};
