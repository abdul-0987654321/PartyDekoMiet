'use strict';
/** Minimal leveled logger. Timestamps are in the configured timezone. */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const level = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const emit = (name, msg) => {
  if (LEVELS[name] > level) return;
  const line = `${stamp()} ${name.toUpperCase().padEnd(5)} ${msg}`;
  if (name === 'error') console.error(line);
  else console.log(line);
};

module.exports = {
  error: (m) => emit('error', m),
  warn: (m) => emit('warn', m),
  info: (m) => emit('info', m),
  debug: (m) => emit('debug', m),
};
