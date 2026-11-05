const { chatCompletionWithFallback } = require("./llm.js");
const { truncate, MAX_OUTPUT_BYTES } = require("./tools.js");

const DEFAULT_MAX_TURNS = 40;

// The findings are staged with separate tools (see `findings.js`) and added to the review when it's posted, so this
// only takes the summary.
const FINALIZE_REVIEW_TOOL = {
  type: "function",
  function: {
    name: "finalize_review",
    description: "Finalize the review with the findings staged so far. The staged findings are posted as they are, together with the summary. This ends the review; call it exactly once when you are done.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Summary of the review in Markdown, without the findings: what the PR does, the overall verdict, and any context used or missing. Don't repeat the staged findings; they are added when the review is posted." },
      },
      required: ["summary"],
    },
  },
};

const NO_TOOL_CALL_PROMPT = "Continue the review using the available tools, then call finalize_review with the summary.";
const TURN_LIMIT_PROMPT = "The turn limit has been reached. Do not gather more context. Call finalize_review now with a summary based on what you have found so far.";

function toToolDefinition({ name, description, parameters }) {
  return { type: "function", function: { name, description, parameters } };
}

function addUsage(total, usage) {
  if (!usage) return;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    total[key] += usage[key] || 0;
  }
}

const MAX_LOGGED_ARGUMENTS = 200;

// One-line summary of a tool call and its result for the progress log; the full output is only logged as debug.
function describeToolCall(call, content) {
  const raw = call.function?.arguments || "";
  const args = raw.length > MAX_LOGGED_ARGUMENTS ? `${raw.slice(0, MAX_LOGGED_ARGUMENTS)}…` : raw;
  const result = content.startsWith("Error:") ? content.split("\n")[0] : `${Buffer.byteLength(content)} bytes`;
  return `${call.function?.name}(${args}) -> ${result}`;
}

function parseArguments(raw) {
  if (raw === undefined || raw === "") return {};
  const args = JSON.parse(raw);
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("arguments must be a JSON object");
  }
  return args;
}

async function runToolCall(call, toolsByName, maxToolOutputBytes) {
  const name = call.function?.name;
  const tool = toolsByName.get(name);
  if (!tool) return `Error: unknown tool "${name}"`;
  try {
    const output = await tool.run(parseArguments(call.function.arguments));
    return truncate(String(output), maxToolOutputBytes);
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// Returns the summary if the call is a valid `finalize_review`, otherwise an error message for the model.
function readSummary(call) {
  try {
    const { summary } = parseArguments(call.function.arguments);
    if (typeof summary !== "string" || summary.trim() === "") return { error: "Error: summary must be a non-empty string" };
    return { summary };
  } catch (err) {
    return { error: `Error: ${err.message}` };
  }
}

// Appends the assistant message and the resulting tool messages to `messages`.
// Returns the report if the conversation is finished, otherwise `undefined`.
async function handleMessage(core, { messages, message, turn, toolsByName, maxToolOutputBytes }) {
  messages.push(message);
  const calls = message.tool_calls || [];
  if (calls.length === 0) {
    if (typeof message.content === "string" && message.content.trim() !== "") {
      core.info(`ai-review: turn ${turn}: model answered without tool calls; using the text as the report`);
      return message.content;
    }
    core.info(`ai-review: turn ${turn}: empty answer without tool calls; asking the model to continue`);
    messages.push({ role: "user", content: NO_TOOL_CALL_PROMPT });
    return undefined;
  }
  if (typeof message.content === "string" && message.content.trim() !== "") {
    core.debug(`ai-review: turn ${turn}: model text: ${message.content}`);
  }
  for (const [index, call] of calls.entries()) {
    let content;
    if (call.function?.name === FINALIZE_REVIEW_TOOL.function.name) {
      const { summary, error } = readSummary(call);
      if (summary !== undefined) {
        core.info(`ai-review: turn ${turn}: review finalized (summary ${Buffer.byteLength(summary)} bytes)`);
        // The prompt asks for finalize_review as the last call; calls after it (e.g. a late add_finding) are lost.
        const skipped = calls.slice(index + 1).map((later) => later.function?.name);
        if (skipped.length > 0) {
          core.warning(`ai-review: turn ${turn}: ${skipped.length} tool call(s) after finalize_review were not run: ${skipped.join(", ")}`);
        }
        return summary;
      }
      content = error;
    } else {
      content = await runToolCall(call, toolsByName, maxToolOutputBytes);
    }
    core.info(`ai-review: turn ${turn}: ${describeToolCall(call, content)}`);
    // Extends the info line above with the full output, unless that line already shows all of it (a one-line error).
    if (!(content.startsWith("Error:") && !content.includes("\n"))) core.debug(content);
    messages.push({ role: "tool", tool_call_id: call.id, content });
  }
  return undefined;
}

// Runs a tool-calling loop until the model calls `finalize_review` (or answers in plain text). The returned `report`
// is the summary from `finalize_review` (or the plain-text answer).
// `tools` are `{ name, description, parameters, run }` objects as returned by `createTools`; `run` receives the
// parsed arguments and returns a string. Tool errors are reported back to the model instead of being thrown.
// Progress (turns, tool calls, token usage) is logged with `core.info`; details (tool output, raw model responses)
// with `core.debug`.
// If nothing is submitted after the turn limit, it returns `report: undefined` and the caller decides how to proceed
// (e.g. post the findings staged so far).
async function runAgent(core, {
  endpoint,
  apiKey,
  model,
  fallbackModel,
  systemPrompt,
  userPrompt,
  tools,
  maxTurns = DEFAULT_MAX_TURNS,
  maxToolOutputBytes = MAX_OUTPUT_BYTES,
}) {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  if (toolsByName.has(FINALIZE_REVIEW_TOOL.function.name)) {
    throw new Error(`tool name "${FINALIZE_REVIEW_TOOL.function.name}" is reserved`);
  }
  const toolDefinitions = [...tools.map(toToolDefinition), FINALIZE_REVIEW_TOOL];
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  // Once the primary model fails, the rest of the conversation continues on the fallback model.
  let currentModel = model;

  for (let turn = 1; turn <= maxTurns + 1; turn++) {
    const isFinalTurn = turn > maxTurns;
    if (isFinalTurn) {
      // Turn limit reached: ask once more, offering only `finalize_review`.
      core.warning(`ai-review: reached the turn limit (${maxTurns}); asking the model to submit its report.`);
      messages.push({ role: "user", content: TURN_LIMIT_PROMPT });
    }
    const response = await chatCompletionWithFallback(core, {
      endpoint,
      apiKey,
      model: currentModel,
      fallbackModel,
      messages,
      tools: isFinalTurn ? [FINALIZE_REVIEW_TOOL] : toolDefinitions,
    });
    currentModel = response.model;
    addUsage(usage, response.usage);
    const toolCalls = response.message.tool_calls?.length || 0;
    core.info(
      `ai-review: turn ${turn}/${maxTurns} (${currentModel}): ${toolCalls} tool call(s), ` +
      `${response.usage?.prompt_tokens ?? "?"} prompt + ${response.usage?.completion_tokens ?? "?"} completion tokens ` +
      `(${usage.total_tokens} total so far)`,
    );
    const report = await handleMessage(core, { messages, message: response.message, turn, toolsByName, maxToolOutputBytes });
    if (report !== undefined) return { report, turns: turn, model: currentModel, usage };
  }
  core.warning(`ai-review: no review was submitted within ${maxTurns} turns; finishing without a report.`);
  return { report: undefined, turns: maxTurns + 1, model: currentModel, usage };
}

module.exports = { runAgent, DEFAULT_MAX_TURNS };
