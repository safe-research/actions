async function callOpenAi(core, endpoint, apiKey, model, systemPrompt, prompt, schemaName, schema, tools) {
    if (tools !== undefined) core.warning("Tools not supported with open ai api!")
    const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
    const body = {
        model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
        ],
        response_format: {
            type: "json_schema",
            json_schema: { name: schemaName, schema, strict: true },
        }
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
    });
    const rawBody = await res.text();
    core.debug(`ai-review: raw response from model "${model}" (${schemaName}, status ${res.status}): ${rawBody}`);

    const data = JSON.parse(rawBody);
    return JSON.parse(data.choices[0].message.content);
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

module.exports = { callModelWithFallback };
