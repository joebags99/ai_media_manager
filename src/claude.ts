// claude.ts: the one place the Anthropic SDK is called. Every call returns strict JSON
// validated against a JSON schema (structured outputs), and the full request/response
// pair so callers can store it on the draft for replay and audit.
//
// Checked against docs.claude.com / @anthropic-ai/sdk 1.x on 2026-10-25:
//   - model: claude-opus-5-5 (current default; thinking always on, effort controls depth)
//   - structured JSON: output_config.format = { type: "json_schema", schema }
//   - images: { type: "image", source: { type: "base64", media_type, data } }
//   - refusals: stop_reason "refusal"; server-side fallbacks via beta
//     "server-side-fallback-2026-07-01" + fallbacks: "default"

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const MODEL = 'claude-opus-5-5';
// $/MTok from the current price list, used for the per-draft cost log.
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

export type Effort = 'low' | 'medium' | 'high';
export type ContentBlock = Anthropic.Beta.BetaContentBlockParam;
export type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface JsonCall {
  system: string;
  messages: MessageParam[];
  schema: Record<string, unknown>;
  effort?: Effort;
  maxTokens?: number;
}

export interface JsonResult<T> {
  data: T;
  /** Exactly what was sent, minus image bytes (replaced by their filename). */
  request: Record<string, unknown>;
  response: Anthropic.Beta.BetaMessage;
  costUsd: number;
  model: string;
}

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  // Organization-level keys (not scoped to one workspace) must name the workspace on
  // every request; workspace-scoped keys ignore the header.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  return (client ??= new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}));
}

/** Turns the SDK's raw error into one line the dashboard can show, with a fix hint where known. */
function explain(err: unknown): Error {
  if (err instanceof Anthropic.APIError) {
    const msg = (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
    if (/anthropic-workspace-id/.test(msg)) {
      return new Error(
        `Claude ${err.status}: this API key is organization-level, so set ANTHROPIC_WORKSPACE_ID in .env to the workspace ID (Console -> Settings -> Workspaces), or create a key inside a workspace.`,
      );
    }
    return new Error(`Claude ${err.status}: ${msg}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function imageBlock(file: string): Promise<ContentBlock> {
  const ext = path.extname(file).slice(1).toLowerCase();
  const media_type = (ext === 'jpg' ? 'image/jpeg' : `image/${ext}`) as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  return { type: 'image', source: { type: 'base64', media_type, data: (await readFile(file)).toString('base64') } };
}

export function estimateCost(usage: Anthropic.Beta.BetaUsage): number {
  const m = 1_000_000;
  return (
    (usage.input_tokens * PRICE.input +
      usage.output_tokens * PRICE.output +
      (usage.cache_read_input_tokens ?? 0) * PRICE.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) /
    m
  );
}

/** Strip base64 image data so the stored request stays small and replayable. */
function redactImages(messages: MessageParam[]): unknown {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string' || !m.content
        ? m.content
        : m.content.map((b) => (b.type === 'image' && b.source.type === 'base64' ? { type: 'image', source: { type: 'base64', media_type: b.source.media_type, data: `<${b.source.data.length} base64 chars>` } } : b)),
  }));
}

// Structured outputs accept only a subset of JSON Schema (types, enum, const, anyOf,
// $ref, additionalProperties:false). Length and range keywords are rejected with a 400,
// so strip them here and enforce those limits in code after parsing.
const UNSUPPORTED = new Set(['minItems', 'maxItems', 'uniqueItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minProperties', 'maxProperties']);
export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (UNSUPPORTED.has(k)) continue;
      out[k] = k === 'enum' || k === 'required' ? v : cleanSchema(v);
    }
    return out;
  }
  return schema;
}

export async function askJson<T>(call: JsonCall): Promise<JsonResult<T>> {
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: MODEL,
    max_tokens: call.maxTokens ?? 4096,
    system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
    messages: call.messages,
    output_config: { effort: call.effort ?? 'medium', format: { type: 'json_schema', schema: cleanSchema(call.schema) as Record<string, unknown> } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await getClient().beta.messages.create(params);
  } catch (err) {
    throw explain(err);
  }
  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('Claude hit max_tokens before finishing the JSON');
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
  }
  const { messages: _m, system: _s, ...rest } = params;
  return {
    data,
    request: { ...rest, system: call.system, messages: redactImages(call.messages) },
    response,
    costUsd: estimateCost(response.usage),
    model: response.model,
  };
}
