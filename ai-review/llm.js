async function callOpenAi(core, endpoint, apiKey, model, systemPrompt, prompt, schemaName, schema, tools) {
    if (tools !== undefined) core.warning("Tools not supported with open ai api!")
    const { message } = await chatCompletion(core, {
        endpoint,
        apiKey,
        model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
        ],
        responseFormat: {
            type: "json_schema",
            json_schema: { name: schemaName, schema, strict: true },
        },
    });
    return JSON.parse(message.content);
}

async function callGemini(core, endpoint, apiKey, model, systemPrompt, prompt, schemaName, schema, tools) {
  const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    // 1. System Prompt moves to its own dedicated object
    system_instruction: {
      parts: [{ text: systemPrompt }]
    },
    // 2. 'messages' becomes 'contents' and 'parts'
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    // 3. 'response_format' becomes 'generationConfig'
    generationConfig: {
      responseMimeType: "application/json",
      // Notice: The schema goes directly here, no 'type: "json_schema"' wrapper
      responseSchema: schema
    },
    // 4. Grounding tool is now natively recognized
    tools
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body),
  });
  const rawBody = await res.text();
  core.debug(`ai-review: raw response from model "${model}" (${schemaName}, status ${res.status}): ${rawBody}`);

  const data = JSON.parse(rawBody);
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

async function callModel(core, endpoint, apiKey, model, systemPrompt, prompt, schemaName, schema, tools) {
  if (endpoint === "https://generativelanguage.googleapis.com/v1beta/models/") {
      return callGemini(core, endpoint, apiKey, model, systemPrompt, prompt, schemaName, schema, tools);
  } else {
      return callOpenAi(core, endpoint, apiKey, model, systemPrompt, prompt, schemaName, schema, tools)
  }
}

async function callModelWithFallback(core, endpoint, apiKey, model, fallbackModel, systemPrompt, prompt, schemaName, schema, tools) {
  try {
    return await callModel(core, endpoint, apiKey, model, systemPrompt, prompt, schemaName, schema, tools);
  } catch (err) {
    if (!fallbackModel || fallbackModel === model) {
      throw err;
    }
    core.warning(`ai-review: model "${model}" failed (${err.message}); retrying with fallback model "${fallbackModel}".`);
    return callModel(core, endpoint, apiKey, fallbackModel, systemPrompt, prompt, schemaName, schema, tools);
  }
}

// Single chat completions request, optionally with tool definitions or a response format. Returns the raw assistant
// message (including `tool_calls` and provider-specific fields that must be sent back unchanged) and the token usage.
async function chatCompletion(core, { endpoint, apiKey, model, messages, tools, responseFormat }) {
  const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
  const body = { model, messages };
  if (tools && tools.length > 0) body.tools = tools;
  if (responseFormat) body.response_format = responseFormat;
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

module.exports = { callModelWithFallback, chatCompletion, chatCompletionWithFallback };
