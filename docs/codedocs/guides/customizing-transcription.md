---
title: "Customizing Transcription"
description: "Pass model, language, and formatting options through the WebSocket URL to adapt the starter to different live transcription scenarios."
---

This guide shows how to customize transcription behavior without changing the backend architecture. The Bun server already forwards a curated set of query parameters to Deepgram, so the main task is to construct the right URL on the client side and keep the audio settings honest.

## Problem

Different transcription sessions need different settings. You may want English defaults for one workflow, Spanish transcripts for another, or speaker-aware output for call analysis. Hard-coding everything in `server.ts` turns the starter into a one-off app.

## Solution

Push session-specific options through the `/api/live-transcription` query string and let `buildDeepgramUrl(queryParams)` map them to the upstream Deepgram connection.

<Steps>
<Step>
### Start from the default parameter set

The minimum safe set is the audio contract:

```typescript
const params = new URLSearchParams({
  encoding: "linear16",
  sample_rate: "16000",
  channels: "1",
});
```

That allows the server to inject default values for `model=nova-3`, `language=en`, and `smart_format=true`.

</Step>
<Step>
### Add task-specific options

For clearer transcript output, enable punctuation and keep smart formatting on:

```typescript
const params = new URLSearchParams({
  model: "nova-3",
  language: "en-US",
  encoding: "linear16",
  sample_rate: "16000",
  channels: "1",
  smart_format: "true",
  punctuate: "true",
});
```

For multi-speaker use cases, add diarization:

```typescript
params.set("diarize", "true");
```

</Step>
<Step>
### Open the authenticated socket with the configured query string

```typescript
const { token } = await fetch("http://localhost:8081/api/session").then((res) =>
  res.json() as Promise<{ token: string }>
);

const ws = new WebSocket(
  `ws://localhost:8081/api/live-transcription?${params.toString()}`,
  [`access_token.${token}`]
);
```

The backend will convert those values into a Deepgram `/v1/listen` URL.

</Step>
<Step>
### Keep the audio pipeline aligned

If your recorder changes format, update the query string at the same time. The server does not transcode anything for you.

```typescript
const opusParams = new URLSearchParams({
  model: "nova-3",
  language: "en",
  encoding: "opus",
  sample_rate: "48000",
  channels: "1",
});
```

Only use this if the bytes you send really are Opus at `48000` Hz.

</Step>
</Steps>

## Complete Example

This example lets a caller choose between a default preset and a speaker-aware preset:

```typescript
type Preset = "default" | "speaker-aware";

function buildPreset(preset: Preset) {
  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
  });

  if (preset === "default") {
    params.set("language", "en");
    params.set("smart_format", "true");
    params.set("punctuate", "true");
  }

  if (preset === "speaker-aware") {
    params.set("language", "en-US");
    params.set("smart_format", "true");
    params.set("punctuate", "true");
    params.set("diarize", "true");
    params.set("filler_words", "false");
  }

  return params;
}

async function connect(preset: Preset) {
  const { token } = await fetch("http://localhost:8081/api/session").then(
    (res) => res.json() as Promise<{ token: string }>
  );

  const params = buildPreset(preset);
  const ws = new WebSocket(
    `ws://localhost:8081/api/live-transcription?${params.toString()}`,
    [`access_token.${token}`]
  );

  ws.onmessage = (event) => {
    console.log(`${preset} transcript event`, String(event.data));
  };
}
```

## When To Change The Backend

Stay client-driven when you simply want to vary supported Deepgram settings per session. Change `server.ts` when:

- you need a new option that `buildDeepgramUrl()` does not currently forward,
- you want to reject unsafe combinations up front,
- you need product-level policy such as forcing a specific model or language,
- you want to derive settings from JWT claims rather than client input.

That separation keeps the starter easy to reason about: query strings are for session-level choices, while server edits are for platform-level policy.
