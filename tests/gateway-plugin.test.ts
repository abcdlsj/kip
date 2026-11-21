import { describe, expect, test } from "bun:test";
import { gemini2apiPlugin } from "../src/bun/plugins/gemini2api";

interface GatewayOptions {
  server?: string;
  keyRequired?: boolean;
  acceptedKey?: string;
  models?: number;
  /** The server lists its own `-temp` entries, as gemini2api does. */
  temporaryVariant?: boolean;
}

function fakeGateway(options: GatewayOptions = {}) {
  const minted: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const authorized = () => {
        if (options.keyRequired !== true) return true;
        const header = request.headers.get("authorization") ?? "";
        return header.replace(/^Bearer /, "") === options.acceptedKey;
      };
      if (url.pathname === "/health") {
        return Response.json({
          server: options.server ?? "gemini2api",
          version: "0.1.0",
          key_required: options.keyRequired === true,
          api: {
            supports_vision: false,
            supports_reasoning: true,
            context_window: 225_000,
          },
          accounts: { ultra: { signed_in: true, status: "AVAILABLE" } },
          chats: 0,
          closed: 0,
        });
      }
      if (url.pathname === "/v1/models") {
        if (!authorized()) return new Response("{}", { status: 401 });
        const count = options.models ?? 2;
        return Response.json({
          object: "list",
          data: Array.from({ length: count }, (_, index) => ({
            id: options.temporaryVariant
              ? `gemini-model-${index + 1}-temp`
              : `gemini-model-${index + 1}`,
            context_window: 225_000,
            supports_vision: false,
            supports_reasoning: true,
            gemini: {
              display_name: `Model ${index + 1}`,
              advanced_only: true,
              temporary: options.temporaryVariant === true,
            },
          })),
        });
      }
      if (url.pathname === "/v1/keys" && request.method === "POST") {
        if (!authorized()) return new Response("{}", { status: 401 });
        const key = `g2k-minted-${minted.length + 1}`;
        minted.push(key);
        return Response.json(
          {
            id: "k1",
            label: "kip",
            prefix: key.slice(0, 12),
            created_at: 1,
            key,
          },
          { status: 201 },
        );
      }
      return new Response("{}", { status: 404 });
    },
  });
  return { server, port: String(server.port), minted };
}

describe("gemini2api gateway plugin", () => {
  test("a server without auth registers models and needs no key", async () => {
    const gateway = fakeGateway();
    try {
      const result = await gemini2apiPlugin.probe({ port: gateway.port }, {});
      expect(result.ok).toBe(true);
      expect(result.proposal?.baseUrl).toBe(
        `http://127.0.0.1:${gateway.port}/v1`,
      );
      expect(result.proposal?.protocol).toBe("openai-completions");
      // Each model is offered twice: as-is, and temporary. Only the storage differs.
      expect(result.proposal?.models).toHaveLength(4);
      expect(result.proposal?.models[0]).toMatchObject({
        id: "gemini-model-1",
        displayName: "Model 1",
        contextWindow: 225_000,
        supportsVision: false,
        supportsReasoning: true,
      });
      expect(result.proposal?.models[1]).toMatchObject({
        id: "gemini-model-1-temp",
        displayName: "Model 1 (temporary)",
      });
      expect(result.proposal?.apiKey).toBeUndefined();
      expect(gateway.minted).toHaveLength(0);
    } finally {
      gateway.server.stop(true);
    }
  });

  test("a server that wants a key is asked for one rather than guessing", async () => {
    const gateway = fakeGateway({ keyRequired: true, acceptedKey: "operator" });
    try {
      const result = await gemini2apiPlugin.probe({ port: gateway.port }, {});
      expect(result.ok).toBe(false);
      expect(result.missing?.[0]?.field).toBe("operatorKey");
    } finally {
      gateway.server.stop(true);
    }
  });

  test("the operator key is traded for one of Kip's own", async () => {
    const gateway = fakeGateway({ keyRequired: true, acceptedKey: "operator" });
    try {
      const result = await gemini2apiPlugin.probe(
        { port: gateway.port, operatorKey: "operator" },
        {},
      );
      expect(result.ok).toBe(true);
      expect(result.proposal?.apiKey).toBe("g2k-minted-1");
      expect(gateway.minted).toHaveLength(1);
    } finally {
      gateway.server.stop(true);
    }
  });

  test("a key Kip already holds is reused, not minted again", async () => {
    const gateway = fakeGateway({
      keyRequired: true,
      acceptedKey: "g2k-existing",
    });
    try {
      const result = await gemini2apiPlugin.probe(
        { port: gateway.port },
        { storedApiKey: "g2k-existing" },
      );
      expect(result.ok).toBe(true);
      expect(result.proposal?.apiKey).toBeUndefined();
      expect(gateway.minted).toHaveLength(0);
    } finally {
      gateway.server.stop(true);
    }
  });

  test("a rejected key asks for the right one", async () => {
    const gateway = fakeGateway({ keyRequired: true, acceptedKey: "operator" });
    try {
      const result = await gemini2apiPlugin.probe(
        { port: gateway.port, operatorKey: "wrong" },
        {},
      );
      expect(result.ok).toBe(false);
      expect(result.missing?.[0]?.field).toBe("operatorKey");
    } finally {
      gateway.server.stop(true);
    }
  });

  test("another service on the port is reported as such", async () => {
    const gateway = fakeGateway({ server: "something-else" });
    try {
      const result = await gemini2apiPlugin.probe({ port: gateway.port }, {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not gemini2api");
    } finally {
      gateway.server.stop(true);
    }
  });

  test("a bad port is refused before any request", async () => {
    const result = await gemini2apiPlugin.probe({ port: "eighty" }, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Port");
  });
});

describe("gemini2api temporary chats", () => {
  test("the toggle defaults models to keeping their chats", async () => {
    const gateway = fakeGateway();
    try {
      const result = await gemini2apiPlugin.probe({ port: gateway.port }, {});
      expect(result.proposal?.models.map((model) => model.id)).toEqual([
        "gemini-model-1",
        "gemini-model-1-temp",
        "gemini-model-2",
        "gemini-model-2-temp",
      ]);
    } finally {
      gateway.server.stop(true);
    }
  });

  test("a server that already lists temporary models is not doubled", async () => {
    const gateway = fakeGateway({ temporaryVariant: true });
    try {
      const result = await gemini2apiPlugin.probe({ port: gateway.port }, {});
      const ids = result.proposal?.models.map((model) => model.id) ?? [];
      // Two models were offered and both are already temporary: no duplicates were minted.
      expect(ids).toEqual(["gemini-model-1-temp", "gemini-model-2-temp"]);
    } finally {
      gateway.server.stop(true);
    }
  });
});
