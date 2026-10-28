# API HNQ — OpenAI-compatible gateway

Use this gateway with OpenAI-compatible clients and agents.

## Connection

- Base URL: `https://apihnq.hnquan.com/v1`
- Authentication: `Authorization: Bearer <API_HNQ_KEY>`
- Content type for POST requests: `application/json`
- Request bodies: Chat Completions and Responses accept up to 16 MiB; larger requests receive HTTP 413.
- Obtain a client API key from the gateway administrator. Never use the Cockpit upstream key.

## Supported endpoints

### `GET /v1/models`

Returns the models currently exposed by Cockpit, filtered by the caller's key policy.

### `POST /v1/chat/completions`

Supports standard OpenAI Chat Completions requests, tool calls, structured output, JSON responses, and SSE streaming with `"stream": true`. Streaming ends with `data: [DONE]`.

### `POST /v1/responses`

Supports the OpenAI Responses request format, tool calls, JSON responses, and named SSE events with `"stream": true`. A successful stream ends with `response.completed`.

Other OpenAI endpoints are not currently advertised. Do not assume support for files, audio, images, embeddings, realtime, batches, fine-tuning, or stored response retrieval.

## Discover models before selecting one

Do not hard-code the model inventory. Query it at startup or when a model is rejected:

```bash
curl https://apihnq.hnquan.com/v1/models \
  -H "Authorization: Bearer $API_HNQ_KEY"
```

Model aliases and mapping are reserved for a future version. At present, send the exact model ID returned by `/v1/models`.

## Python OpenAI SDK

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://apihnq.hnquan.com/v1",
    api_key=os.environ["API_HNQ_KEY"],
)

models = client.models.list()
model = models.data[0].id

response = client.responses.create(
    model=model,
    input="Reply with exactly: connected",
)
print(response.output_text)
```

## JavaScript OpenAI SDK

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://apihnq.hnquan.com/v1",
  apiKey: process.env.API_HNQ_KEY,
});

const models = await client.models.list();
const model = models.data[0].id;

const response = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Reply with exactly: connected" }],
});

console.log(response.choices[0].message.content);
```

## Streaming example

```python
stream = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "Count from 1 to 3."}],
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

## Errors and limits

Errors use the OpenAI-style envelope:

```json
{
  "error": {
    "message": "Human-readable message",
    "type": "invalid_request_error",
    "param": null,
    "code": "model_not_allowed"
  }
}
```

Common status codes:

- `400`: malformed request or JSON.
- `401`: missing, invalid, expired, or revoked API key.
- `403`: the API key cannot use the requested model.
- `413`: request body too large.
- `415`: unsupported content type.
- `429`: request or concurrency limit reached. Respect `Retry-After`.
- `502`: Cockpit is unavailable or returned an invalid response.
- `504`: upstream timeout.

Requests that generate content are not automatically retried after reaching Cockpit. Client agents should only retry when their own idempotency and duplicate-generation policy permits it.

## Operational notes for agents

- Treat API keys as secrets. Do not place them in prompts, logs, URLs, source code, or this document.
- The gateway may be unavailable when the Windows host or local Cockpit tool is offline.
- Cancel the HTTP request when abandoning a generation; the gateway will cancel the upstream request.
- Usage fields are passed through when Cockpit provides them and may be absent on interrupted streams.
- The public health endpoint is `https://apihnq.hnquan.com/healthz`.

Document URL: `https://apihnq.hnquan.com/api.md`
