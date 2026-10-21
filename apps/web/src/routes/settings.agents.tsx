import { createFileRoute } from "@tanstack/react-router";

import { AgentRolesSettings } from "../components/settings/AgentRolesSettings";

export const Route = createFileRoute("/settings/agents")({ component: AgentRolesSettings });
