import { PiProvider } from "./agent/providers/pi/pi-provider.js";

async function main(): Promise<void> {
  const provider = new PiProvider({ noSession: true });
  const observed = new Set<string>();
  const session = await provider.startSession({ workingDirectory: process.cwd() }, (event) => {
    observed.add(event.type);
  });
  console.log(`Pi RPC ready; Vagus session ${session.id}`);
  console.log(`Observed event types: ${[...observed].sort().join(", ")}`);
  await session.dispose();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
