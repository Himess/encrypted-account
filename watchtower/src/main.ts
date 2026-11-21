/**
 * Watchtower service, local run.
 *
 *   npx ts-node watchtower/src/main.ts --config watchtower/config.json           run until stopped (Ctrl+C)
 *   npx ts-node watchtower/src/main.ts --config watchtower/config.json --check   check the config and the channels, exit
 *   npx ts-node watchtower/src/main.ts --config watchtower/config.json --once    one pass, wait for deliveries, exit
 *   npx ts-node watchtower/src/main.ts --config watchtower/config.json --pause <account> [opId …]
 *        the trusted contact's brake after a silent alarm: pauses the account's pending ops (or the given ones) with the
 *        guardian key, each once, for up to 72 hours. The service never does this by itself.
 *
 * The key, the bot token and the SMTP login are read from env files and never printed. A channel without its secret is
 * replaced by the fake channel (messages go to its JSONL file), so the service runs before any real channel is set up.
 */
import * as path from "path";
import { ethers } from "ethers";
import { Channel, EmailChannel, FakeChannel, TelegramChannel } from "./channels";
import { ChannelKind, loadConfig, readEnvFile, validateConfig } from "./config";
import { sepoliaDecryptor } from "./fhevm";
import { WatchtowerService, pausePending } from "./service";
import { ACCOUNT_P_ABI } from "../../web/src/abi";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = arg("--config") ?? path.join("watchtower", "config.json");
  const cfg = loadConfig(file);
  cfg.stateFile ??= path.join("watchtower", "data", "state.json");
  cfg.deliveryLog ??= path.join("watchtower", "data", "deliveries.jsonl");
  const { errors, warnings } = validateConfig(cfg);
  for (const w of warnings) console.log(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.log(`error: ${e}`);
    process.exit(2);
  }

  const fake = new FakeChannel({ file: cfg.channels?.fake?.file ?? path.join("watchtower", "data", "notices.jsonl"), console: cfg.channels?.fake?.console ?? true });
  const channels: Partial<Record<ChannelKind, Channel>> = { fake };
  const status: string[] = [];
  const tg = cfg.channels?.telegram;
  const tgToken = readEnvFile(tg?.envFile ?? path.join("watchtower", ".env"))[tg?.botTokenVar ?? "TELEGRAM_BOT_TOKEN"];
  if (tgToken) {
    channels.telegram = new TelegramChannel(tgToken);
    status.push("telegram: bot token found");
  } else status.push("telegram: no bot token, its messages go to the fake channel");
  const em = cfg.channels?.email;
  const emEnv = readEnvFile(em?.envFile ?? path.join("watchtower", ".env"));
  const host = emEnv[em?.hostVar ?? "SMTP_HOST"];
  if (host && em?.from) {
    channels.email = EmailChannel.smtp({
      host,
      port: Number(emEnv[em?.portVar ?? "SMTP_PORT"] ?? 465),
      user: emEnv[em?.userVar ?? "SMTP_USER"],
      pass: emEnv[em?.passVar ?? "SMTP_PASS"],
      secure: em.secure,
      from: em.from,
    });
    status.push("email: SMTP host found");
  } else status.push("email: no SMTP host or sender, its messages go to the fake channel");
  for (const s of status) console.log(s);

  const key = readEnvFile(cfg.guardianKey.envFile)[cfg.guardianKey.var] ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.log(`error: no valid ${cfg.guardianKey.var} in ${cfg.guardianKey.envFile}`);
    process.exit(2);
  }
  // the first RPC that answers; after a few failed passes in a row the scan moves to the next one
  const urls = cfg.network.rpcUrls;
  const connect = async (start: number): Promise<{ provider: ethers.JsonRpcProvider; index: number }> => {
    for (let k = 0; k < urls.length; k++) {
      const index = (start + k) % urls.length;
      const p = new ethers.JsonRpcProvider(urls[index], cfg.network.chainId, { staticNetwork: true });
      try {
        await p.getBlockNumber();
        return { provider: p, index };
      } catch {
        p.destroy();
      }
    }
    throw new Error("no RPC URL answered");
  };
  let { provider, index } = await connect(0);
  const guardian = new ethers.Wallet(key, provider);
  console.log(`watchtower ${guardian.address} · ${cfg.accounts.length} account(s) · chain ${cfg.network.chainId}`);
  if (process.argv.includes("--check")) {
    provider.destroy();
    return;
  }
  const pauseAt = process.argv.indexOf("--pause");
  if (pauseAt > 0) {
    const target = ethers.getAddress(process.argv[pauseAt + 1] ?? "");
    const ids = process.argv.slice(pauseAt + 2).filter((x) => /^\d+$/.test(x)).map((x) => BigInt(x));
    const res = await pausePending(new ethers.Contract(target, ACCOUNT_P_ABI as any, guardian), ids.length ? ids : undefined);
    if (res.length === 0) console.log("no pending operation to pause");
    for (const r of res) console.log(r.hash ? `paused op ${r.opId}: ${r.hash}` : `op ${r.opId}: not paused (${r.error})`);
    provider.destroy();
    return;
  }
  if (cfg.network.fhevm !== "sepolia") throw new Error('only fhevm = "sepolia" is wired for a live run');
  const dec = await sepoliaDecryptor(provider, guardian); // keeps its own provider for the relayer's reads
  const make = (p: ethers.JsonRpcProvider) => new WatchtowerService({ config: cfg, configFile: file, guardian: guardian.connect(p), ...dec, channels, fallback: fake });
  let svc = make(provider);
  if (process.argv.includes("--once")) {
    await svc.tickAll();
    await svc.drain();
    return;
  }
  let stopped = false;
  process.on("SIGINT", () => (stopped = true));
  process.on("SIGTERM", () => (stopped = true));
  const ms = Math.max(1, cfg.pollSeconds ?? 4) * 1000;
  let fails = 0;
  while (!stopped) {
    const t0 = Date.now();
    fails = (await svc.tickAll()) > 0 ? fails + 1 : 0;
    if (fails >= 3 && urls.length > 1) {
      // state is saved after every pass: a new service on the next RPC continues where this one stopped
      await svc.drain();
      const c = await connect(index + 1);
      index = c.index;
      svc = make(c.provider);
      console.log(`[rpc] moved to RPC #${index + 1}`);
      fails = 0;
    }
    const wait = ms - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await svc.drain();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e?.message ?? e).slice(0, 400));
    process.exit(1);
  });
