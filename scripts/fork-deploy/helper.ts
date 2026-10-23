// @effect-diagnostics nodeBuiltinImport:off - Plain node helper for the fork-deploy shell scripts; omarchy may lack the sqlite3 CLI.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

// The run statuses `isBlockingRun` treats as in flight
// (apps/server/src/orchestration-v2/Orchestrator.ts). `queued` is left out: a
// held queue can sit there indefinitely and would block every deploy.
const ACTIVE_RUN_STATUSES = ["preparing", "starting", "running", "waiting"];

function activeRuns(dbPath: string): number {
  // readOnly maps to SQLITE_OPEN_READONLY: the live database is never opened for writing.
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    const row = db
      .prepare(
        `SELECT count(*) AS n FROM orchestration_v2_projection_runs WHERE status IN (${placeholders})`,
      )
      .get(...ACTIVE_RUN_STATUSES) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

// The server holds `BEGIN EXCLUSIVE` on server-owner.sqlite for its lifetime
// (apps/server/src/serverOwnership.ts). The file holds no data, so probing it
// the same way and rolling back is how we learn the owner has gone.
function ownerLockFree(stateDir: string): boolean {
  const lockPath = NodePath.join(stateDir, "server-owner.sqlite");
  if (!NodeFS.existsSync(lockPath)) return true;
  const db = new NodeSqlite.DatabaseSync(lockPath);
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK;");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

interface ProviderInstance {
  readonly driver?: string;
  readonly environment?: ReadonlyArray<{ readonly name?: string; readonly value?: unknown }>;
  readonly config?: { readonly homePath?: string };
}

const expandHome = (value: string) =>
  value === "~" || value.startsWith("~/") ? NodePath.join(NodeOS.homedir(), value.slice(1)) : value;

// One skills dir per Claude config dir (each Claude account is a provider
// instance with its own homePath or CLAUDE_CONFIG_DIR, as ClaudeSkills.ts
// resolves it), Codex's skills dir per Codex home, and ~/.agents/skills.
function skillDirs(settingsPath: string): string[] {
  const home = NodeOS.homedir();
  const claudeHomes = [process.env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(home, ".claude")];
  const codexHomes = [process.env.CODEX_HOME?.trim() || NodePath.join(home, ".codex")];
  if (NodeFS.existsSync(settingsPath)) {
    const settings: { providerInstances?: Record<string, ProviderInstance> } = JSON.parse(
      NodeFS.readFileSync(settingsPath, "utf8"),
    );
    for (const instance of Object.values(settings.providerInstances ?? {})) {
      const env = new Map(
        (instance.environment ?? []).map((v) => [v.name, String(v.value ?? "")] as const),
      );
      const homePath = instance.config?.homePath?.trim() ?? "";
      if (instance.driver === "claudeAgent") {
        const dir = homePath || env.get("CLAUDE_CONFIG_DIR")?.trim();
        if (dir) claudeHomes.push(dir);
      } else if (instance.driver === "codex") {
        const dir = homePath || env.get("CODEX_HOME")?.trim();
        if (dir) codexHomes.push(dir);
      }
    }
  }
  const dirs = [
    ...claudeHomes.map((dir) => NodePath.join(NodePath.resolve(expandHome(dir)), "skills")),
    ...codexHomes.map((dir) => NodePath.join(NodePath.resolve(expandHome(dir)), "skills")),
    NodePath.join(home, ".agents", "skills"),
  ];
  return [...new Set(dirs)];
}

const [command, arg] = process.argv.slice(2);
if (!arg) {
  process.stderr.write(
    "usage: helper.ts active-runs <db> | lock-free <state-dir> | skill-dirs <settings>\n",
  );
  process.exit(2);
}
switch (command) {
  case "active-runs":
    process.stdout.write(`${activeRuns(arg)}\n`);
    break;
  case "lock-free":
    process.exit(ownerLockFree(arg) ? 0 : 1);
    break;
  case "skill-dirs":
    process.stdout.write(`${skillDirs(arg).join("\n")}\n`);
    break;
  default:
    process.stderr.write(`unknown command: ${command}\n`);
    process.exit(2);
}
