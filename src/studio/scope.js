'use strict';
/**
 * One professional's view of the Studio directory.
 *
 * Each professional now has her own WhatsApp number. A client writing to that
 * number is writing to her, so the bot on that line must not offer him one of
 * the other women, quote their prices, or read out the whole team - and it
 * must not do so even if the model asks for it, which is why this is a filter
 * around the directory rather than a line in the prompt.
 *
 * The Studio's own number is unscoped and still sees everyone.
 *
 * Services with no professionalId are the studio's standard list, offered by
 * everyone, so they stay visible on her line. Only another woman's own service
 * disappears.
 */

/**
 * @param {object} directory the real src/studio/directory
 * @param {string} [professionalId] empty/missing = no scoping at all
 */
function scopeToProfessional(directory, professionalId) {
  if (!professionalId) return directory;

  const hers = (p) => p && p.id === professionalId;
  const herService = (s) => Boolean(s) && (!s.professionalId || s.professionalId === professionalId);

  return {
    ...directory,

    listProfessionals: (opts) => directory.listProfessionals(opts).filter(hers),

    getProfessional: (id) => (id === professionalId ? directory.getProfessional(id) : null),

    listServices: (opts = {}) => {
      // Asking for somebody else's services on her line returns nothing rather
      // than falling back to everyone's.
      if (opts.professionalId && opts.professionalId !== professionalId) return [];
      return directory.listServices(opts).filter(herService);
    },

    getService: (id) => {
      const service = directory.getService(id);
      return herService(service) ? service : null;
    },

    profileFor: (id) => (id === professionalId ? directory.profileFor(id) : null),
  };
}

module.exports = { scopeToProfessional };
