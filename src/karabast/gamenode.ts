import path from "node:path";

/**
 * @displayName Local gamenode launch
 * @strategicPurpose The pinned forceteki clone is read-only from swu-mcp, and its `npm run dev` writes `.env` into it
 * (forceteki scripts/run-server.js:6-29), so the gamenode is started directly with every setting passed as an
 * environment variable, and with the loopback guard preloaded so it can reach no other host (#182 phase 2).
 * @tacticalObjective The command, arguments and environment for `node --require <guard>
 * <clone>/build/server/gamenode/index.js`: development mode (test card data, in-memory users, no DynamoDB:
 * GameServer.ts:213-217, :247), NODE_ENV development (without it the Discord dispatcher demands webhook URLs,
 * DiscordDispatcher.ts constructor), 127.0.0.1 and the given port, a local-only NEXTAUTH secret, and every webhook,
 * stats and AWS variable removed from the inherited environment.
 */

export interface GamenodeLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** One line, for logs and the report. */
  display: string;
}

const LAUNCH_ENV = { NODE_ENV: "development", ENVIRONMENT: "development", GAME_NODE_HOST: "127.0.0.1", GAME_NODE_NAME: "swu-mcp-local", NEXTAUTH_SECRET: "swu-mcp-local-only" };
const DROP = /^(NODE_ENV|AWS_|DISCORD_|SWUSTATS_|SWUBASE_|INTRASERVICE_|PROFILE_CAPTURE_|FORCE_ENABLE_STATS|USE_LOCAL_DYNAMODB|ADDITIONAL_CORS)/;

export function gamenodeLaunch(o: { forcetekiRoot: string; guard: string; port: number; node: string; inherit?: Readonly<Record<string, string | undefined>> }): GamenodeLaunch {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.inherit ?? process.env)) if (v !== undefined && !DROP.test(k)) env[k] = v;
  Object.assign(env, LAUNCH_ENV, { GAME_NODE_SOCKET_IO_PORT: String(o.port) });
  const args = ["--require", o.guard, path.join(o.forcetekiRoot, "build/server/gamenode/index.js")];
  const shown = Object.entries({ ...LAUNCH_ENV, GAME_NODE_SOCKET_IO_PORT: String(o.port) })
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return { command: o.node, args, env, display: `${shown} node --require ${o.guard} ${args[2]}` };
}
