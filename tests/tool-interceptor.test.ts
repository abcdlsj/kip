import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolApprovalPayload } from "../src/shared/types";
import { ToolInterceptor } from "../src/bun/agent/tool-interceptor";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kip-tools-"));
  roots.push(root);
  return root;
}

function fakeTool(
  name: string,
  execute: (params: Record<string, unknown>) => Promise<unknown> = async () => ({
    content: [{ type: "text", text: "ok" }],
    details: {},
  }),
): ToolDefinition<never, unknown> {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object" } as never,
    execute: (async (_id: string, params: Record<string, unknown>) => execute(params)) as never,
  } as ToolDefinition<never, unknown>;
}

function interceptor(
  root: string,
  approvals: ToolApprovalPayload[],
  policy: "read-only-auto" | "full-auto" | "strict" = "read-only-auto",
): ToolInterceptor {
  return new ToolInterceptor({
    workspaceRoot: root,
    threadId: "th_test",
    policy,
    requestApproval: (payload) => approvals.push(payload),
  });
}

describe("tool interceptor", () => {
  test("auto-runs safe bash commands", async () => {
    const root = workspace();
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals);
    const tool = guard.wrap(fakeTool("bash"));
    const result = await tool.execute("call_1", { command: "ls -la" } as never, undefined, undefined, {} as never);
    expect(approvals).toHaveLength(0);
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }], details: {} });
  });

  test("suspends mutating bash until approved", async () => {
    const root = workspace();
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals);
    const tool = guard.wrap(fakeTool("bash"));
    const running = tool.execute("call_2", { command: "bun test" } as never, undefined, undefined, {} as never);
    await Bun.sleep(5);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.risk).toBe("standard");
    guard.resolveApproval("call_2", true);
    await expect(running).resolves.toBeDefined();
  });

  test("rejects when the user denies", async () => {
    const root = workspace();
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals);
    const tool = guard.wrap(fakeTool("bash"));
    const running = tool.execute("call_3", { command: "rm -rf dist" } as never, undefined, undefined, {} as never);
    await Bun.sleep(5);
    expect(approvals[0]?.risk).toBe("high-risk");
    guard.resolveApproval("call_3", false);
    await expect(running).rejects.toThrow(/denied/i);
  });

  test("builds an edit preview before asking", async () => {
    const root = workspace();
    writeFileSync(join(root, "a.ts"), "const one = 1;\n");
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals);
    const tool = guard.wrap(fakeTool("edit"));
    const running = tool.execute(
      "call_4",
      { path: "a.ts", edits: [{ oldText: "const one = 1;", newText: "const one = 2;" }] } as never,
      undefined,
      undefined,
      {} as never,
    );
    await Bun.sleep(5);
    expect(approvals[0]?.previewDiff?.before).toBe("const one = 1;\n");
    expect(approvals[0]?.previewDiff?.after).toBe("const one = 2;\n");
    expect(approvals[0]?.summaryLabel).toBe("Edited a.ts (+1 -1)");
    guard.resolveApproval("call_4", true);
    await running;
  });

  test("forces approval outside the workspace even in full auto", async () => {
    const root = workspace();
    mkdirSync(join(root, "src"));
    const outside = join(tmpdir(), `kip-outside-${Date.now()}.txt`);
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals, "full-auto");
    const tool = guard.wrap(fakeTool("read"));
    const running = tool.execute("call_5", { path: outside } as never, undefined, undefined, {} as never);
    await Bun.sleep(5);
    expect(approvals[0]?.outsideWorkspace).toBe(true);
    guard.resolveApproval("call_5", false);
    await expect(running).rejects.toThrow(/denied/i);
  });

  test("blocks credential paths immediately", async () => {
    const root = workspace();
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals);
    const tool = guard.wrap(fakeTool("read"));
    await expect(
      tool.execute("call_6", { path: join(homedir(), ".ssh", "id_rsa") } as never, undefined, undefined, {} as never),
    ).rejects.toThrow(/denied|blocked/i);
    expect(approvals).toHaveLength(0);
  });

  test("remembered commands are scoped to program and subcommand", async () => {
    const root = workspace();
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals);
    const tool = guard.wrap(fakeTool("bash"));
    const run = (id: string, command: string) =>
      tool.execute(id, { command } as never, undefined, undefined, {} as never);

    const first = run("r1", "git commit -m wip");
    await Bun.sleep(5);
    guard.resolveApproval("r1", true, true);
    await first;

    await run("r2", "git commit --amend");
    expect(approvals).toHaveLength(1);

    const push = run("r3", "git push origin main");
    await Bun.sleep(5);
    expect(approvals).toHaveLength(2);
    guard.resolveApproval("r3", false);
    await expect(push).rejects.toThrow(/denied/i);
  });

  test("remembered commands never cover high-risk segments", async () => {
    const root = workspace();
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals);
    const tool = guard.wrap(fakeTool("bash"));
    const first = tool.execute("h1", { command: "npm test" } as never, undefined, undefined, {} as never);
    await Bun.sleep(5);
    guard.resolveApproval("h1", true, true);
    await first;

    const risky = tool.execute(
      "h2",
      { command: "npm test && rm -rf build" } as never,
      undefined,
      undefined,
      {} as never,
    );
    await Bun.sleep(5);
    expect(approvals).toHaveLength(2);
    expect(approvals[1]?.risk).toBe("high-risk");
    guard.resolveApproval("h2", false);
    await expect(risky).rejects.toThrow(/denied/i);
  });

  test("reads the approval policy on every call", async () => {
    const root = workspace();
    const approvals: ToolApprovalPayload[] = [];
    let policy: "full-auto" | "strict" = "full-auto";
    const guard = new ToolInterceptor({
      workspaceRoot: root,
      threadId: "th_test",
      policy: () => policy,
      requestApproval: (payload) => approvals.push(payload),
    });
    const tool = guard.wrap(fakeTool("bash"));
    await tool.execute("p1", { command: "npm test" } as never, undefined, undefined, {} as never);
    expect(approvals).toHaveLength(0);
    policy = "strict";
    const second = tool.execute("p2", { command: "ls" } as never, undefined, undefined, {} as never);
    await Bun.sleep(5);
    expect(approvals).toHaveLength(1);
    guard.resolveApproval("p2", true);
    await second;
  });

  test("asks before shell reads outside the workspace", async () => {
    const root = workspace();
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals, "full-auto");
    const tool = guard.wrap(fakeTool("bash"));
    await tool.execute("o1", { command: "cat src/a.ts 2>/dev/null" } as never, undefined, undefined, {} as never);
    expect(approvals).toHaveLength(0);
    const running = tool.execute("o2", { command: "cat ~/.netrc" } as never, undefined, undefined, {} as never);
    await Bun.sleep(5);
    expect(approvals[0]?.outsideWorkspace).toBe(true);
    guard.resolveApproval("o2", false);
    await expect(running).rejects.toThrow(/denied/i);
  });

  test("edit preview keeps dollar patterns literal", async () => {
    const root = workspace();
    writeFileSync(join(root, "a.ts"), "const x = 1;\n");
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals);
    const tool = guard.wrap(fakeTool("edit"));
    const running = tool.execute(
      "d1",
      { path: "a.ts", edits: [{ oldText: "1", newText: "'$&$1'" }] } as never,
      undefined,
      undefined,
      {} as never,
    );
    await Bun.sleep(5);
    expect(approvals[0]?.previewDiff?.after).toBe("const x = '$&$1';\n");
    guard.resolveApproval("d1", false);
    await expect(running).rejects.toThrow(/denied/i);
  });

  test("passes the denial reason back to the model", async () => {
    const root = workspace();
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals);
    const tool = guard.wrap(fakeTool("bash"));
    const running = tool.execute("call_r", { command: "bun test" } as never, undefined, undefined, {} as never);
    await Bun.sleep(5);
    guard.resolveApproval("call_r", false, false, "  run only the db tests  ");
    await expect(running).rejects.toThrow("Their reason: run only the db tests");
  });

  test("remembers file approvals per file only", async () => {
    const root = workspace();
    writeFileSync(join(root, "a.ts"), "a\n");
    writeFileSync(join(root, "b.ts"), "b\n");
    const approvals: ToolApprovalPayload[] = [];
    const guard = interceptor(root, approvals);
    const tool = guard.wrap(fakeTool("write"));
    const first = tool.execute("w1", { path: "a.ts", content: "x\n" } as never, undefined, undefined, {} as never);
    await Bun.sleep(5);
    guard.resolveApproval("w1", true, true);
    await first;
    await tool.execute("w2", { path: "a.ts", content: "y\n" } as never, undefined, undefined, {} as never);
    expect(approvals).toHaveLength(1);
    const other = tool.execute("w3", { path: "b.ts", content: "z\n" } as never, undefined, undefined, {} as never);
    await Bun.sleep(5);
    expect(approvals).toHaveLength(2);
    guard.resolveApproval("w3", true);
    await other;
  });
});
