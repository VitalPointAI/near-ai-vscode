export function redactSecrets(value: string): string {
  const bearerSafe = value.replace(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  return bearerSafe.replace(/\brpt-[A-Za-z0-9_-]{8,}/g, '[REDACTED]').replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
