# Watchtower service

An off-chain service that watches accounts on-chain and quietly tells the right person. It uses the watcher logic in
[`sdk/src/watchtower.ts`](../sdk/src/watchtower.ts) and runs it as a pure notifier.

| Event | Who is told | How it is known |
|---|---|---|
| Wrong PIN (any account) | the owner | `GuessFinalized(ok = false)`, public |
| A key-only private send moved zero (private mode) | the owner | the K-only counter the account shares with the watchtower, decrypted off-chain |
| The duress PIN was used (private mode) | the trusted contacts only | the encrypted duress flag of every guess, allowed to the watchtower only, decrypted off-chain |
| PIN-approved operation, restriction, escape, recovery, … | the owner | public events |

## Rules of the silent alarm

- It never goes to the owner's own device or channel: the phone may be in the attacker's hands. The config check rejects
  a trusted contact that is also an owner channel (the same mailbox written another way counts), and the router drops it
  again at runtime.
- Nothing visible happens on-chain when the duress PIN is used: the service sends no transaction (no restriction, no
  freeze), and the contracts emit the same events as for the real PIN. The duress flag is decrypted for **every** guess,
  real or not, through Zama's relayer and KMS (off-chain), so the requests look the same either way.
- The alarm says only which account, when, and that the duress PIN was used, plus the owner's optional short note. No
  message from this service ever carries an amount (no balance, no transfer amount, no limit, no decoy).
- The owner's messages are the same for a real and a duress PIN.
- The trusted contacts and channels live in the service's own config file, never on-chain.
- Run it on a machine the owner does not carry: the fake channel's file and console, and the delivery log, are on the
  watchtower's machine, and the fake channel shows every message, the alarm included.

The service does not call anyone by itself; it sends messages, and what happens next is up to the person who gets them.

## What it sends on-chain

Nothing around a PIN entry: it never finalizes a guess (the owner's app does). The only transaction it can send is
`guardianRestrict` when a key-only tripwire fires (key theft probing the hidden limit), as the design always had it; set
`restrictOnTripwire: false` to turn that off. That needs a little ETH on the watchtower key; decrypting needs none.

## Run it locally

```bash
cp watchtower/config.example.json watchtower/config.json   # then edit: accounts, owner, trusted
cp watchtower/env.example watchtower/.env                  # then fill in: WATCHTOWER_KEY, and the channels you have
npm run watchtower -- --config watchtower/config.json --check
npm run watchtower -- --config watchtower/config.json
```

- `watchtower/.env` and `watchtower/data/` are git-ignored. The key, the bot token and the SMTP login are read from the
  env file and never printed.
- Without a Telegram bot token or an SMTP host, those messages go to the fake channel: one JSON line each in
  `watchtower/data/notices.jsonl` (and the console). Nothing is paid for: no SMS gateway, no hosting.
- Telegram: create a bot with @BotFather; each recipient must send it `/start` once (a bot cannot write first); use the
  numeric chat id as `to`.
- E-mail: any SMTP server (port 465 with TLS, or 587); `from` goes in the config, the login in the env file.
- The account must have been created with this watchtower's address as its guardian: only then does it share the
  duress flag and the K-only counter with it.
- State (how far it got) is saved after every pass, so a restart continues where it stopped; after a few failed passes
  in a row it moves to the next RPC URL in the config.

## Tests

```bash
npm run test:watchtower                      # routing, texts, config check, channels (no chain)
node scripts/run-tests.mjs WatchtowerService.test.ts   # against the contracts on the mock FHEVM
```
