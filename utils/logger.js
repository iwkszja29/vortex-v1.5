const SECRET_KEYS = /app.?state|cookie|token|password|secret|authorization|session/i;
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, SECRET_KEYS.test(k) ? '[REDACTED]' : sanitize(v)]));
  if (typeof value === 'string') return value.replace(/(cookie|token|password|secret|appstate)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]');
  return value;
}
function createLogger() {
  const emit = (level, event, details={}) => console.log(JSON.stringify({ time:new Date().toISOString(), level, event, details:sanitize(details) }));
  return { info:(e,d)=>emit('INFO',e,d), warn:(e,d)=>emit('WARN',e,d), error:(e,d)=>emit('ERROR',e,d), command:(e,d)=>emit('COMMAND',e,d), mqtt:(e,d)=>emit('MQTT',e,d) };
}
module.exports = { createLogger, sanitize };
