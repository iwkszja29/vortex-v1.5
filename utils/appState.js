function validateAppState(input) {
  let value = input;
  if (typeof input === 'string') { try { value = JSON.parse(input); } catch { throw new Error('AppState must be valid JSON.'); } }
  if (!Array.isArray(value)) throw new Error('AppState must be a JSON array.');
  if (!value.length) throw new Error('AppState array cannot be empty.');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string' || !item.key.trim() || !Object.hasOwn(item,'value')) throw new Error('AppState contains an invalid cookie entry.');
  }
  return value;
}
module.exports = { validateAppState };
