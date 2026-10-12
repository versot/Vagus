/** Desktop bridge credentials belong to the Host, never to provider/package workers. */
export function providerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.VAGUS_HOST_TOKEN;
  delete environment.VAGUS_ALLOWED_ORIGINS;
  return environment;
}
