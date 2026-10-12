const index = process.env.VAGUS_SMOKE_TERMINAL_INDEX ?? 'unknown';
for (let line = 1; line <= 1000; line++) {
  process.stdout.write(`VAGUS_T${index}_${String(line).padStart(6, '0')}_${'X'.repeat(192)}\n`);
}
