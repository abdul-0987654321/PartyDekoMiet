'use strict';
/**
 * The identity this bot presents when it links to WhatsApp.
 *
 * Baileys takes it as [platform, browser, version]. The phone shows the pair as
 * "<browser> (<platform>)" under Linked devices.
 *
 * The two login methods do NOT accept the same thing, which is the whole reason
 * this file exists:
 *
 *   QR        anything goes. The brand name is shown as-is.
 *   Pairing   Baileys derives a numeric companion platform id from the BROWSER
 *             name and sends it in the link_code_companion_reg request. A name
 *             it does not recognise becomes OTHER_WEB_CLIENT (9), and the phone
 *             refuses the link - "check the phone number is correct on your
 *             device", on every number, forever. Chrome is id 1.
 *
 * We shipped ['PartyDekoMiet', 'Chrome', '120.0.0'] - brand in the platform
 * slot - and then ['Ubuntu', 'Studio', ...] - brand in the browser slot, which
 * is the one that must be a real browser. Both broke pairing; the working QR
 * hid it both times.
 *   refs: WhiskeySockets/Baileys requestPairingCode -> getCompanionPlatformId,
 *         ClaxonAI/PitchMyWeb#31, rmyndharis/OpenWA#1666, #1857
 *
 * So: pairing links as a plain recognised browser, QR keeps the business name.
 * The owner still ends up with a named device, because the name they see comes
 * from the QR link they actually keep.
 */

/** Platforms WhatsApp is known to accept. */
const KNOWN_PLATFORMS = Object.freeze(['Ubuntu', 'macOS', 'Windows', 'Linux']);
const DEFAULT_PLATFORM = 'Ubuntu';
const DEFAULT_VERSION = '22.04.4';

/**
 * Browser names Baileys maps to a real companion platform id. Anything else
 * becomes OTHER_WEB_CLIENT, which the phone rejects during pairing.
 */
const KNOWN_BROWSERS = Object.freeze(['Chrome', 'Edge', 'Firefox', 'Opera', 'Safari']);
const PAIRING_BROWSER = 'Chrome';

const BUSINESS_NAMES = Object.freeze({ party: 'PartyDekoMiet', studio: 'Studio' });

function businessName(business, env) {
  return (
    String(env[business === 'studio' ? 'STUDIO_DEVICE_NAME' : 'PARTY_DEVICE_NAME'] || '').trim() ||
    BUSINESS_NAMES[business] ||
    BUSINESS_NAMES.party
  );
}

/**
 * @param {object} [opts]
 * @param {'party'|'studio'} [opts.business]
 * @param {'qr'|'pairing'} [opts.mode] how this socket will be linked
 * @param {object} [opts.env]
 * @returns {[string, string, string]} [platform, browser, version] for Baileys
 */
function browserTriple({ business = 'party', mode = 'qr', env = process.env } = {}) {
  const rawPlatform = String(env.WHATSAPP_PLATFORM || '').trim();
  // An unrecognised override is the exact bug this file exists to prevent, so
  // it is ignored rather than passed through.
  const platform =
    KNOWN_PLATFORMS.find((p) => p.toLowerCase() === rawPlatform.toLowerCase()) || DEFAULT_PLATFORM;

  const version = String(env.WHATSAPP_DEVICE_VERSION || DEFAULT_VERSION);

  if (mode === 'pairing') {
    // Never the business name here, whatever is configured.
    const rawBrowser = String(env.WHATSAPP_PAIRING_BROWSER || '').trim();
    const browser =
      KNOWN_BROWSERS.find((b) => b.toLowerCase() === rawBrowser.toLowerCase()) || PAIRING_BROWSER;
    return [platform, browser, version];
  }

  return [platform, businessName(business, env), version];
}

/** How the pair reads on the phone, for logging. */
function deviceLabel(triple) {
  return `${triple[1]} (${triple[0]})`;
}

module.exports = {
  browserTriple,
  deviceLabel,
  KNOWN_PLATFORMS,
  KNOWN_BROWSERS,
  DEFAULT_PLATFORM,
  PAIRING_BROWSER,
};
