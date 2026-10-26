// buffer.ts: thin GraphQL client for the current Buffer API.
//
// Source: live schema introspection on 2026-10-25 (buffer.com/developers was not
// reachable from the build environment; the MCP connector exposes the same schema).
//   - Transport: a single GraphQL endpoint (BUFFER_API_URL, default https://api.buffer.com),
//     POST {query, variables}, Authorization: Bearer <access token from
//     publish.buffer.com/settings/api>.
//   - Media: there is NO upload endpoint. Images are given as public https URLs in
//     CreatePostInput.assets[].image.url and Buffer downloads them. Renders therefore
//     have to be served from PUBLIC_BASE_URL (see publish.ts).
//   - Create: mutation createPost(input: CreatePostInput!) -> PostActionPayload
//       { channelId, text, assets, mode: customScheduled, dueAt, schedulingType: automatic,
//         metadata.{facebook|instagram|google|linkedin} }
//   - Delete: mutation deletePost(input: { id }) -> DeletePostSuccess | VoidMutationError
//   - Errors come back as union members implementing MutationError { message }.
// If Buffer moves the endpoint, set BUFFER_API_URL; nothing else needs to change.

export interface BufferConfig {
  token: string;
  url: string;
  fetch?: typeof fetch;
}

export function bufferConfig(): BufferConfig {
  const token = process.env.BUFFER_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('BUFFER_ACCESS_TOKEN is not set');
  return { token, url: process.env.BUFFER_API_URL?.trim() || 'https://api.buffer.com' };
}

export async function gql<T>(cfg: BufferConfig, query: string, variables: Record<string, unknown>): Promise<T> {
  const f = cfg.fetch ?? fetch;
  const res = await f(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Buffer ${res.status} at ${cfg.url}: ${text.slice(0, 300)}`);
  let body: { data?: T; errors?: { message: string }[] };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`Buffer returned non-JSON from ${cfg.url}: ${text.slice(0, 200)}`);
  }
  if (body.errors?.length) throw new Error(`Buffer: ${body.errors.map((e) => e.message).join('; ')}`);
  if (!body.data) throw new Error('Buffer returned no data');
  return body.data;
}

export interface BufferAccount {
  id: string;
  email: string;
  timezone: string | null;
  organizations: { id: string; name: string }[];
}

export async function getAccount(cfg: BufferConfig): Promise<BufferAccount> {
  const d = await gql<{ account: BufferAccount }>(cfg, `query { account { id email timezone organizations { id name } } }`, {});
  return d.account;
}

export interface BufferChannel {
  id: string;
  service: string;
  name: string;
  timezone: string;
  isDisconnected: boolean;
}

export async function listChannels(cfg: BufferConfig, organizationId: string): Promise<BufferChannel[]> {
  const d = await gql<{ channels: BufferChannel[] }>(
    cfg,
    `query ($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id service name timezone isDisconnected } }`,
    { organizationId },
  );
  return d.channels;
}

export interface CreatePostInput {
  channelId: string;
  text: string;
  assets: { image: { url: string; metadata: { altText: string } } }[];
  mode: 'customScheduled';
  dueAt: string;
  schedulingType: 'automatic';
  metadata?: Record<string, unknown>;
  source?: string;
}

export interface CreatedPost {
  id: string;
  status: string;
  dueAt: string | null;
}

const CREATE_POST = `mutation ($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status dueAt } }
    ... on MutationError { message }
  }
}`;

export async function createPost(cfg: BufferConfig, input: CreatePostInput): Promise<CreatedPost> {
  const d = await gql<{ createPost: { __typename: string; post?: CreatedPost; message?: string } }>(cfg, CREATE_POST, { input });
  const r = d.createPost;
  if (r.__typename !== 'PostActionSuccess' || !r.post) throw new Error(`createPost ${r.__typename}: ${r.message ?? 'unknown error'}`);
  return r.post;
}

const DELETE_POST = `mutation ($input: DeletePostInput!) {
  deletePost(input: $input) {
    __typename
    ... on DeletePostSuccess { id }
    ... on MutationError { message }
  }
}`;

export async function deletePost(cfg: BufferConfig, id: string): Promise<void> {
  const d = await gql<{ deletePost: { __typename: string; id?: string; message?: string } }>(cfg, DELETE_POST, { input: { id } });
  if (d.deletePost.__typename !== 'DeletePostSuccess') throw new Error(`deletePost ${id}: ${d.deletePost.message ?? 'unknown error'}`);
}

// ---- Metrics -------------------------------------------------------------------------
// Post { status, sentAt, externalLink, metrics: [PostMetric { type, value, unit }], metricsUpdatedAt }
export interface PostMetrics {
  id: string;
  status: string;
  sentAt: string | null;
  externalLink: string | null;
  metricsUpdatedAt: string | null;
  /** metric type -> value, e.g. impressions, reach, likes, comments, shares, clicks */
  values: Record<string, number>;
}

const POST_METRICS = `query ($input: PostInput!) {
  post(input: $input) { id status sentAt externalLink metricsUpdatedAt metrics { type value unit } }
}`;

export async function getPostMetrics(cfg: BufferConfig, id: string): Promise<PostMetrics> {
  const d = await gql<{ post: { id: string; status: string; sentAt: string | null; externalLink: string | null; metricsUpdatedAt: string | null; metrics: { type: string; value: number; unit: string }[] | null } }>(cfg, POST_METRICS, { input: { id } });
  const p = d.post;
  const values: Record<string, number> = {};
  for (const m of p.metrics ?? []) values[m.type] = m.value;
  return { id: p.id, status: p.status, sentAt: p.sentAt, externalLink: p.externalLink, metricsUpdatedAt: p.metricsUpdatedAt, values };
}
