'use strict';
/**
 * The identity this bot presents when it links to WhatsApp.
 *
 * Baileys takes it as [platform, browser, version], and WhatsApp shows the pair
 * as "<browser> (<platform>)" under Linked devices on the owner's phone.
 *
 * Why this is its own file: the platform slot is NOT free text. QR login
 * accepts anything there, but the phone-number pairing endpoint checks it
 * against known operating systems and drops the handshake when it does not
 * recognise one - the code is issued, the phone says "check the phone number is
 * correct on your device", and the socket closes as logged out. We shipped
 * ['PartyDekoMiet', 'Chrome', '120.0.0'], so pairing by number could never have
 * worked on any number, while the QR kept working and hid it.
 *   refs: rmyndharis/OpenWA#1666, #1857 (same symptom, same cause)
 *
 * So the platform stays a real OS name and the business name moves into the
 * browser slot, where it is still what the owner reads on their phone:
 *   Studio (Ubuntu)   /   PartyDekoMiet (Ubuntu)
 *
 * Both slots are overridable by env, because this is WhatsApp-side behaviour
 * that can tighten again, and changing it must not need a code change.
 */

/** Platforms WhatsApp is known to accept for pairing-code login. */
const KNOWN_PLATFORMS = Object.freeze(['Ubuntu', 'macOS', 'Windows', 'Linux']);
const DEFAULT_PLATFORM = 'Ubuntu';
const DEFAULT_VERSION = '22.04.4';

const BUSINESS_NAMES = Object.freeze({ party: 'PartyDekoMiet', studio: 'Studio' });

/**
 * @param {object} [opts]
 * @param {'party'|'studio'} [opts.business]
 * @param {object} [opts.env]
 * @returns {[string, string, string]} [platform, browser, version] for Baileys
 */
function browserTriple({ business = 'party', env = process.env } = {}) {
  const raw = String(env.WHATSAPP_PLATFORM || '').trim();
  // An unrecognised override is the exact bug this file exists to prevent, so
  // it is ignored rather than passed through.
  const platform = KNOWN_PLATFORMS.find((p) => p.toLowerCase() === raw.toLowerCase()) || DEFAULT_PLATFORM;

  const name =
    String(env[business === 'studio' ? 'STUDIO_DEVICE_NAME' : 'PARTY_DEVICE_NAME'] || '').trim() ||
    BUSINESS_NAMES[business] ||
    BUSINESS_NAMES.party;

  return [platform, name, String(env.WHATSAPP_DEVICE_VERSION || DEFAULT_VERSION)];
}

/** How the pair reads on the phone, for logging. */
function deviceLabel(triple) {
  return `${triple[1]} (${triple[0]})`;
}

module.exports = { browserTriple, deviceLabel, KNOWN_PLATFORMS, DEFAULT_PLATFORM };
