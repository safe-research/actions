const { chatCompletionWithFallback } = require("./llm.js");
const { truncate, MAX_OUTPUT_BYTES } = require("./tools.js");

const DEFAULT_MAX_TURNS = 40;

const SUBMIT_REVIEW_TOOL = {
  type: "function",
  function: {
    name: "submit_review",
    description: "Submit the final review report. This ends the review; call it exactly once when you are done.",
    parameters: {
      type: "object",
      properties: {
        report: { type: "string", description: "The complete review report in Markdown" },
      },
      required: ["report"],
    },
  },
};

const NO_TOOL_CALL_PROMPT = "Continue the review using the available tools, then call submit_review with the report.";
const TURN_LIMIT_PROMPT = "The turn limit has been reached. Do not gather more context. Call submit_review now with your report based on what you have found so far.";

function toToolDefinition({ name, description, parameters }) {
  return { type: "function", function: { name, description, parameters } };
}

function addUsage(total, usage) {
  if (!usage) return;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    total[key] += usage[key] || 0;
  }
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

// Returns the report if the call is a valid `submit_review`, otherwise an error message for the model.
function readSubmission(call) {
  try {
    const { report } = parseArguments(call.function.arguments);
    if (typeof report !== "string" || report.trim() === "") return { error: "Error: report must be a non-empty string" };
    return { report };
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
      core.debug(`ai-review: turn ${turn}: model answered without tool calls; using the text as the report`);
      return message.content;
    }
    messages.push({ role: "user", content: NO_TOOL_CALL_PROMPT });
    return undefined;
  }
  for (const call of calls) {
    let content;
    if (call.function?.name === SUBMIT_REVIEW_TOOL.function.name) {
      const { report, error } = readSubmission(call);
      if (report !== undefined) {
        core.debug(`ai-review: turn ${turn}: review submitted`);
        return report;
      }
      content = error;
    } else {
      content = await runToolCall(call, toolsByName, maxToolOutputBytes);
    }
    core.debug(`ai-review: turn ${turn}: ${call.function?.name}(${call.function?.arguments}) -> ${content}`);
    messages.push({ role: "tool", tool_call_id: call.id, content });
  }
  return undefined;
}

// Runs a tool-calling loop until the model calls `submit_review` (or answers in plain text).
// `tools` are `{ name, description, parameters, run }` objects as returned by `createTools`; `run` receives the
// parsed arguments and returns a string. Tool errors are reported back to the model instead of being thrown.
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
  if (toolsByName.has(SUBMIT_REVIEW_TOOL.function.name)) {
    throw new Error(`tool name "${SUBMIT_REVIEW_TOOL.function.name}" is reserved`);
  }
  const toolDefinitions = [...tools.map(toToolDefinition), SUBMIT_REVIEW_TOOL];
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
      // Turn limit reached: ask once more, offering only `submit_review`.
      core.warning(`ai-review: reached the turn limit (${maxTurns}); asking the model to submit its report.`);
      messages.push({ role: "user", content: TURN_LIMIT_PROMPT });
    }
    const response = await chatCompletionWithFallback(core, {
      endpoint,
      apiKey,
      model: currentModel,
      fallbackModel,
      messages,
      tools: isFinalTurn ? [SUBMIT_REVIEW_TOOL] : toolDefinitions,
    });
    currentModel = response.model;
    addUsage(usage, response.usage);
    const report = await handleMessage(core, { messages, message: response.message, turn, toolsByName, maxToolOutputBytes });
    if (report !== undefined) return { report, turns: turn, model: currentModel, usage };
  }
  throw new Error(`no review was submitted within ${maxTurns} turns`);
}

module.exports = { runAgent, DEFAULT_MAX_TURNS };
