/**
 * Extensible tool provider registry for Kip's in-process agent.
 *
 * Built-in coding tools (read, write, edit, bash, grep, find, ls) are provided
 * through the same `ToolProvider` contract that future MCP servers, workspace
 * plugins, or specialized agent tools can register against. Every resolved tool
 * passes through `ToolInterceptor`, so Kip's safety policy applies uniformly.
 */
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { nonInteractiveEnv } from "../system/platform";

export type AnyToolDefinition = ToolDefinition<never, unknown>;

export interface AgentToolContext {
  threadId: string;
  workspaceId: string;
  workspaceRoot: string;
}

export interface ToolProvider {
  readonly id: string;
  createTools(
    context: AgentToolContext,
  ): AnyToolDefinition[] | Promise<AnyToolDefinition[]>;
}

/** Standard cross-platform coding tools backed by Pi's built-in definitions. */
export function createBuiltinToolProvider(): ToolProvider {
  return {
    id: "builtin",
    createTools: ({ workspaceRoot }) => [
      createReadToolDefinition(workspaceRoot) as unknown as AnyToolDefinition,
      createWriteToolDefinition(workspaceRoot) as unknown as AnyToolDefinition,
      createEditToolDefinition(workspaceRoot) as unknown as AnyToolDefinition,
      createBashToolDefinition(workspaceRoot, {
        exposeSessionEnvironment: false,
        spawnHook: (context) => ({
          ...context,
          env: nonInteractiveEnv(context.env),
        }),
      }) as unknown as AnyToolDefinition,
      createGrepToolDefinition(workspaceRoot) as unknown as AnyToolDefinition,
      createFindToolDefinition(workspaceRoot) as unknown as AnyToolDefinition,
      createLsToolDefinition(workspaceRoot) as unknown as AnyToolDefinition,
    ],
  };
}

/**
 * Composes one or more `ToolProvider`s into a deduplicated tool list per
 * session. Later providers override earlier ones if they share a tool name.
 */
export class ToolRegistry {
  private readonly providers = new Map<string, ToolProvider>();

  constructor(initial: ToolProvider[] = [createBuiltinToolProvider()]) {
    for (const provider of initial) {
      this.providers.set(provider.id, provider);
    }
  }

  register(provider: ToolProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: string): void {
    this.providers.delete(providerId);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  async resolveTools(context: AgentToolContext): Promise<AnyToolDefinition[]> {
    const byName = new Map<string, AnyToolDefinition>();
    for (const provider of this.providers.values()) {
      const provided = await provider.createTools(context);
      for (const tool of provided) {
        byName.set(tool.name, tool);
      }
    }
    return [...byName.values()];
  }
}
