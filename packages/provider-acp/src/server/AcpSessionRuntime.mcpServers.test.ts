import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { selectSessionMcpServers } from "./AcpSessionRuntime.ts";

const http: EffectAcpSchema.McpServer = {
  type: "http",
  name: "t3-code",
  url: "http://host.docker.internal:17773/mcp",
  headers: [],
};
const stdio: EffectAcpSchema.McpServer = { name: "t3-code", command: "t3", args: [], env: [] };
const acp = [{ type: "acp", name: "t3-code", serverId: "t3-code" }] as never;
const agent = (mcpCapabilities: { http?: boolean; acp?: boolean }) =>
  ({
    protocolVersion: 1,
    agentCapabilities: { mcpCapabilities },
  }) as EffectAcpSchema.InitializeResponse;

describe("session MCP servers", () => {
  it("sends an agent only the transports it advertises", () => {
    expect(selectSessionMcpServers(agent({ http: true }), [http], acp)).toEqual([http]);
    expect(selectSessionMcpServers(agent({}), [http], acp)).toEqual([]);
    expect(selectSessionMcpServers(agent({}), [stdio], acp)).toEqual([stdio]);
    expect(selectSessionMcpServers(agent({ acp: true }), [http], acp)).toEqual(acp);
  });
});
