// @effect-diagnostics nodeBuiltinImport:off - Drives the real deploy scripts against a scratch HOME with stub tmux and curl.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const SCRIPTS = import.meta.dirname;

// The stub server is "up" while $FAKE/running exists; a build whose path
// contains bad-build never answers health checks. Each C-c records how many
// backups existed at that moment.
const TMUX_STUB = `#!/usr/bin/env bash
echo "tmux $*" >>"$FAKE/calls.log"
case "$1" in
  has-session) [[ -f $FAKE/session ]] ;;
  list-panes) echo "%0" ;;
  new-session) touch "$FAKE/session" ;;
  kill-session) rm -f "$FAKE/session" "$FAKE/running" ;;
  send-keys)
    if [[ $4 == C-c ]]; then
      echo "stop backups=$(find "$T3_DEPLOY_HOME" -maxdepth 1 -name 'userdata.bak-*' | wc -l | tr -d ' ')" >>"$FAKE/calls.log"
      rm -f "$FAKE/running" "$T3_DEPLOY_HOME/userdata/server-runtime.json"
    else
      echo "$4" >"$FAKE/running"
      echo '{"origin":"http://127.0.0.1:9"}' >"$T3_DEPLOY_HOME/userdata/server-runtime.json"
    fi
    ;;
esac
`;
const CURL_STUB = `#!/usr/bin/env bash
[[ -f $FAKE/running ]] && ! grep -q bad-build "$FAKE/running"
`;
const CP_STUB = `#!/usr/bin/env bash
[[ -z \${FAIL_CP:-} ]] || exit 1
exec /bin/cp "$@"
`;

let root: string;
let fake: string;
let t3Home: string;
let checkout: string;
let env: NodeJS.ProcessEnv;

function makeBuild(dir: string) {
  NodeFS.mkdirSync(NodePath.join(dir, "apps/server/dist"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(dir, "node_modules"));
  NodeFS.writeFileSync(NodePath.join(dir, "apps/server/dist/bin.mjs"), "");
  return NodeFS.realpathSync(dir);
}

function runScript(script: string, ...args: string[]) {
  return NodeChildProcess.spawnSync("bash", [NodePath.join(SCRIPTS, script), ...args], {
    env,
    encoding: "utf8",
  });
}

// Read-only probes (has-session, list-panes) are left out.
const calls = () =>
  NodeFS.existsSync(NodePath.join(fake, "calls.log"))
    ? NodeFS.readFileSync(NodePath.join(fake, "calls.log"), "utf8")
        .trim()
        .split("\n")
        .filter((call) => !/^tmux (has-session|list-panes)/.test(call))
    : [];
const backups = () => NodeFS.readdirSync(t3Home).filter((name) => name.startsWith("userdata.bak-"));
const current = () => NodeFS.readlinkSync(NodePath.join(root, "builds/current"));

beforeEach(() => {
  root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-deploy-")));
  fake = NodePath.join(root, "fake");
  t3Home = NodePath.join(root, "home/.t3");
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(fake);
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(NodePath.join(bin, "tmux"), TMUX_STUB, { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(bin, "curl"), CURL_STUB, { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(bin, "cp"), CP_STUB, { mode: 0o755 });

  NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(t3Home, "userdata/marker"), "before swap");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(t3Home, "userdata/statev2.sqlite"));
  db.exec("CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT)");
  db.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 'completed')");
  db.close();

  checkout = makeBuild(NodePath.join(root, "checkout"));
  // The live server is up from the checkout, as on the first swap.
  NodeFS.writeFileSync(NodePath.join(fake, "session"), "");
  NodeFS.writeFileSync(NodePath.join(fake, "running"), "checkout");
  NodeFS.writeFileSync(
    NodePath.join(t3Home, "userdata/server-runtime.json"),
    '{"origin":"http://127.0.0.1:9"}\n',
  );

  const { TMUX: _tmux, ...inherited } = process.env;
  env = {
    ...inherited,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: NodePath.join(root, "home"),
    FAKE: fake,
    T3_DEPLOY_HOME: t3Home,
    T3_DEPLOY_BUILDS: NodePath.join(root, "builds"),
    T3_DEPLOY_CHECKOUT: checkout,
    T3_DEPLOY_NODE: process.execPath,
    T3_DEPLOY_IDLE_WAIT_MINUTES: "0",
    T3_DEPLOY_IDLE_INTERVAL: "1",
    T3_DEPLOY_HEALTH_TIMEOUT: "2",
    T3_DEPLOY_STOP_TIMEOUT: "5",
    T3_DEPLOY_POLL: "0.2",
  };
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("fork deploy", () => {
  it("aborts a swap on a busy server without stopping it", () => {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(t3Home, "userdata/statev2.sqlite"));
    db.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('r2', 'running')");
    db.close();
    const build = makeBuild(NodePath.join(root, "good"));

    const result = runScript("swap.sh", build, "--foreground", "--no-skills");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("busy: 1 active run(s)");
    expect(calls()).toEqual([]);
    expect(backups()).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(root, "builds/current"))).toBe(false);
  });

  it("takes the backup only after the server stopped, then installs skills", () => {
    const build = makeBuild(NodePath.join(root, "good"));
    const skillSource = NodePath.join(checkout, ".agents/skills/t3-orchestration");
    NodeFS.mkdirSync(skillSource, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(skillSource, "SKILL.md"), "");
    const skillDirs = [
      NodePath.join(root, "claude-a/skills"),
      NodePath.join(root, "agents/skills"),
    ];
    env.T3_DEPLOY_SKILL_DIRS = skillDirs.join(":");

    const result = runScript("swap.sh", build, "--foreground");

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(calls().filter((call) => call.startsWith("stop "))).toEqual(["stop backups=0"]);
    expect(backups()).toHaveLength(1);
    expect(NodeFS.readFileSync(NodePath.join(t3Home, backups()[0]!, "marker"), "utf8")).toBe(
      "before swap",
    );
    expect(current()).toBe(build);
    expect(NodeFS.readlinkSync(NodePath.join(root, "builds/previous"))).toBe(checkout);
    for (const dir of skillDirs) {
      expect(NodeFS.readlinkSync(NodePath.join(dir, "t3-orchestration"))).toBe(skillSource);
    }
  });

  it("rolls back when the new build fails its health check", () => {
    const build = makeBuild(NodePath.join(root, "bad-build"));

    const result = runScript("swap.sh", build, "--foreground", "--no-skills");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`rolled back to ${checkout}`);
    const steps = calls().map((call) =>
      call.replace(/^tmux send-keys -t =t3code: (?!C-c).*$/, "tmux start-cmd"),
    );
    expect(steps).toEqual([
      "tmux send-keys -t =t3code: C-c",
      "stop backups=0",
      "tmux kill-session -t =t3code",
      `tmux new-session -d -s t3code -c ${build}`,
      "tmux start-cmd",
      "tmux send-keys -t =t3code: C-c",
      "stop backups=1",
      "tmux kill-session -t =t3code",
      `tmux new-session -d -s t3code -c ${checkout}`,
      "tmux start-cmd",
    ]);
    expect(NodeFS.readFileSync(NodePath.join(fake, "running"), "utf8")).toContain(checkout);
    expect(current()).toBe(checkout);
    expect(NodeFS.existsSync(NodePath.join(root, "builds/previous"))).toBe(false);
    // The backup went back into place; the failed state was set aside.
    expect(backups()).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(t3Home, "userdata/marker"), "utf8")).toBe(
      "before swap",
    );
    expect(NodeFS.readdirSync(t3Home).some((name) => name.startsWith("userdata.failed-"))).toBe(
      true,
    );
  });

  it("never starts a second server while the old one holds the owner lock", () => {
    const build = makeBuild(NodePath.join(root, "good"));
    env.T3_DEPLOY_STOP_TIMEOUT = "1";
    const lock = new NodeSqlite.DatabaseSync(NodePath.join(t3Home, "userdata/server-owner.sqlite"));
    lock.exec("BEGIN EXCLUSIVE");
    try {
      const result = runScript("swap.sh", build, "--foreground", "--no-skills");

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("did not stop; not starting another");
      expect(calls().some((call) => call.startsWith("tmux new-session"))).toBe(false);
      expect(backups()).toEqual([]);
    } finally {
      lock.close();
    }
  });

  it("restarts the previous build when the backup fails after the stop", () => {
    const build = makeBuild(NodePath.join(root, "good"));
    env.FAIL_CP = "1";

    const result = runScript("swap.sh", build, "--foreground", "--no-skills");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("swap aborted after stop");
    expect(calls().filter((call) => call.startsWith("tmux new-session"))).toEqual([
      `tmux new-session -d -s t3code -c ${checkout}`,
    ]);
    expect(NodeFS.readFileSync(NodePath.join(fake, "running"), "utf8")).toContain(checkout);
    expect(current()).toBe(checkout);
  });

  it("changes nothing on a dry run", () => {
    const build = makeBuild(NodePath.join(root, "good"));

    const result = runScript("swap.sh", build, "--dry-run", "--no-skills");

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("+ cp -a");
    expect(result.stdout).toContain(`+ ln -sfn ${build}`);
    expect(calls()).toEqual([]);
    expect(backups()).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(root, "builds/current"))).toBe(false);
  });
});
