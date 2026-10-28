// Single chat completions request, optionally with tool definitions. Returns the raw assistant
// message (including `tool_calls` and provider-specific fields that must be sent back unchanged) and the token usage.
async function chatCompletion(core, { endpoint, apiKey, model, messages, tools }) {
  const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
  const body = { model, messages };
  if (tools && tools.length > 0) body.tools = tools;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
  });
  const rawBody = await res.text();
  core.debug(`ai-review: raw response from model "${model}" (status ${res.status}): ${rawBody}`);
  if (!res.ok) {
    throw new Error(`request failed with status ${res.status}: ${rawBody.slice(0, 500)}`);
  }

  const data = JSON.parse(rawBody);
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("response contains no message");
  return { message, usage: data.usage };
}

// Sends the conversation to `model`. If that fails, retries once with `fallbackModel`. Returns the model that
// answered so the caller can continue the rest of the conversation on it.
async function chatCompletionWithFallback(core, { endpoint, apiKey, model, fallbackModel, messages, tools }) {
  try {
    return { model, ...(await chatCompletion(core, { endpoint, apiKey, model, messages, tools })) };
  } catch (err) {
    if (!fallbackModel || fallbackModel === model) throw err;
    core.warning(`ai-review: model "${model}" failed (${err.message}); continuing with fallback model "${fallbackModel}".`);
    return { model: fallbackModel, ...(await chatCompletion(core, { endpoint, apiKey, model: fallbackModel, messages, tools })) };
  }
}

module.exports = { chatCompletion, chatCompletionWithFallback };
