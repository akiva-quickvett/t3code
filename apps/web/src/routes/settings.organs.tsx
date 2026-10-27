import { createFileRoute } from "@tanstack/react-router";

import { OrganPresetsSettings } from "../components/settings/OrganPresetsSettings";

export const Route = createFileRoute("/settings/organs")({ component: OrganPresetsSettings });
