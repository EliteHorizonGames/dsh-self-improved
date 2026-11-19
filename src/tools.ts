/**
 * 记忆工具模块（M1/M4）：memory_search / conversation_search / memory_correct / memory_forget。
 * 返回注销函数（运行时开关工具组用）。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { MemoryStore } from "./storage.js";

export function registerMemoryTools(ctx: Context, store: MemoryStore, defaultLimit: number): () => void {
  const disposers: Array<() => void> = [];
  disposers.push(ctx.tools.register(defineTool({
    name: "memory_search",
    description:
      "Search structured long-term memories (facts, preferences, events, instructions). Use to recall cross-session context, preferences and past decisions.",
    parameters: {
      query: { type: "string", description: "Keywords or a one-sentence description", required: true },
      kind: {
        type: "string",
        description: "Optional type filter: fact / preference / event / instruction",
      },
      limit: { type: "integer", description: "Maximum number of results" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          hits: {
            type: "array",
            items: { type: "json" },
            required: true,
          },
        },
      },
      render: (_args, value) => renderMemoryHits(value),
    },
    async execute(args) {
      const limit = typeof args.limit === "number" ? args.limit : defaultLimit;
      const hits = store.searchMemories(String(args.query), { limit });
      if (typeof args.kind === "string" && args.kind) {
        return {
          hits: hits
            .filter((h) => h.kind === args.kind)
            .map((h) => ({ id: h.id, kind: h.kind, content: h.content, importance: h.importance })),
        };
      }
      return { hits: hits.map((h) => ({ id: h.id, kind: h.kind, content: h.content, importance: h.importance })) };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "conversation_search",
    description:
      "Search original text of past conversations using DSH full-text search. Use to find the original wording or details of a discussion.",
    parameters: {
      query: { type: "string", description: "Full-text search keywords", required: true },
      limit: { type: "integer", description: "Maximum number of results" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          hits: {
            type: "array",
            items: { type: "json" },
            required: true,
          },
        },
      },
      render: (_args, value) => renderConversationHits(value),
    },
    async execute(args) {
      const limit = typeof args.limit === "number" ? args.limit : defaultLimit;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessionQuery: any = (ctx as any).sessionQuery;
        const page = await sessionQuery.searchSessions({
          query: String(args.query),
          limit,
        });
        const items: unknown[] = page?.items ?? [];
        return {
          hits: items.map((hit) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const h = hit as any;
            return {
              sessionId: String(h.id ?? h.sessionId ?? ""),
              title: h.title ? String(h.title) : "",
              snippet: h.snippet ? String(h.snippet) : "",
            };
          }),
        };
      } catch (error) {
        return { hits: [], error: String(error) };
      }
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "memory_correct",
    description:
      "Correct a memory: insert new content pointing to the superseded memory, and mark the old memory as corrected. Use only when the user explicitly corrects a memory.",
    parameters: {
      memory_id: { type: "string", description: "ID of the memory to correct", required: true },
      new_content: { type: "string", description: "Corrected content (one sentence)", required: true },
      kind: { type: "string", description: "New memory type (optional; defaults to the original)" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { new_id: { type: "string" }, error: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: value.new_id ? `Memory corrected; new ID: ${value.new_id}` : `Correction failed: ${value.error}` }],
    },
    async execute(args) {
      const old = store.getMemory(String(args.memory_id));
      if (!old) return { error: "Memory not found" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kind = (args.kind as any) || old.kind;
      const record = store.insertMemory({
        kind,
        content: String(args.new_content),
        importance: old.importance,
        supersedes: old.id,
      });
      store.setMemoryStatus(old.id, "corrected");
      return { new_id: record.id };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "memory_forget",
    description: "Forget a memory by marking it forgotten and excluding it from retrieval and injection.",
    parameters: {
      memory_id: { type: "string", description: "ID of the memory to forget", required: true },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" } },
      },
      render: (_args, value) => [{ type: "text", text: value.ok ? "Memory forgotten" : "Memory not found" }],
    },
    async execute(args) {
      return { ok: store.forgetMemory(String(args.memory_id)) };
    },
  })));
  return () => { for (const d of disposers) d(); };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMemoryHits(value: any): Array<{ type: "text"; text: string }> {
  const hits = value?.hits ?? [];
  if (hits.length === 0) return [{ type: "text", text: "(No matching memories.)" }];
  const lines = hits.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h: any, i: number) =>
      `${i + 1}. [${h.kind}] ${h.content} (importance ${h.importance}/10 , ID: ${h.id}）`,
  );
  return [{ type: "text", text: lines.join("\n") }];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderConversationHits(value: any): Array<{ type: "text"; text: string }> {
  const hits = value?.hits ?? [];
  if (hits.length === 0) return [{ type: "text", text: "(No matching conversations.)" }];
  const lines = hits.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h: any, i: number) => `${i + 1}. [Session ${h.sessionId}] ${h.title ? h.title + " — " : ""}${h.snippet}`,
  );
  return [{ type: "text", text: lines.join("\n") }];
}
