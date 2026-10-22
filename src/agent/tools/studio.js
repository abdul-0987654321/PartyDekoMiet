'use strict';
/**
 * Tool registry for the Studio agent (OpenAI function calling).
 *
 * Mirrors tools/index.js's DEFS/toolSchemas/runTool shape on purpose, so the two
 * registries stay easy to compare, but the tools themselves are Studio's own:
 * professionals/services instead of a product catalog, a timed slot instead of a
 * multi-day rental window. Nothing here ever lets the model answer about a
 * professional, a price or a slot from its own memory - every fact is read back
 * through directory/calendar/appointments at reply time, and create_appointment_request
 * is always PENDING, same as create_booking_request is for Party.
 *
 * Services (all optional, filled in per phase):
 *   directory     studio/directory.js (professionals, services, locations)
 *   calendar      studio-service.js   { checkSlotAvailability(...) }
 *   appointments  appointments.js     { create(...) }
 *   notify        { owner(text, meta) }
 */

const UNAVAILABLE = (what) => ({
  ok: false,
  error: `${what} ist noch nicht angebunden. Sag dem Kunden, dass du das gerade nicht pruefen kannst, und gib den Fall weiter.`,
});

const DEFS = [
  {
    name: 'list_professionals',
    description:
      'List the professionals currently taking appointments. Use this to find who is available before offering a name, instead of guessing from memory.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async (_args, { directory }) => {
      if (!directory) return UNAVAILABLE('Das Team-Verzeichnis');
      const professionals = directory.listProfessionals({ activeOnly: true });
      return {
        ok: true,
        count: professionals.length,
        professionals: professionals.map((p) => ({ id: p.id, name: p.name, languages: p.languages })),
      };
    },
  },
  {
    name: 'list_services',
    description:
      "The studio's service list: every active service with its duration and price. Use this for a general question like \"what do you offer?\" or \"what are your prices?\", where no particular professional has been named yet. These are the only services and the only prices that may ever be mentioned.",
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async (_args, { directory }) => {
      if (!directory) return UNAVAILABLE('Das Team-Verzeichnis');
      const services = directory.listServices({ activeOnly: true });
      return {
        ok: true,
        count: services.length,
        services: services.map((s) => ({
          id: s.id,
          name: s.name,
          durationMin: s.durationMin,
          priceChf: s.priceChf,
          // What the service actually includes. Without it the bot knows a name,
          // a length and a price and nothing else, so "tell me more about it"
          // can only be answered with "I cannot retrieve the details" - which
          // is what a customer was told live.
          details: s.notes || '',
        })),
      };
    },
  },
  {
    name: 'get_professional_profile',
    description:
      'Get one professional\'s full profile: her services, prices and location. Always call this before naming a service, a price or an address - never answer those from an earlier message in this chat.',
    parameters: {
      type: 'object',
      properties: {
        professional_id: { type: 'string', description: 'id from list_professionals' },
      },
      required: ['professional_id'],
      additionalProperties: false,
    },
    handler: async (args, { directory }) => {
      if (!directory) return UNAVAILABLE('Das Team-Verzeichnis');
      const profile = directory.profileFor(args.professional_id);
      if (!profile) return { ok: false, error: `Professional ${args.professional_id} nicht gefunden.` };
      return {
        ok: true,
        professional: {
          id: profile.professional.id,
          name: profile.professional.name,
          languages: profile.professional.languages,
          workingHours: profile.professional.workingHours || '',
          hasPhoto: Boolean(profile.professional.photoFileId),
        },
        services: profile.services.map((s) => ({
          id: s.id,
          name: s.name,
          durationMin: s.durationMin,
          priceChf: s.priceChf,
          details: s.notes || '',
        })),
        location: profile.location ? { name: profile.location.name, address: profile.location.address } : null,
      };
    },
  },
  {
    name: 'send_professional_photo',
    description:
      "Send the customer a professional's photo, when they ask to see her or ask for pictures. Only works if her profile has one - get_professional_profile says so in hasPhoto. Send at most one per reply, and never describe her appearance in words yourself.",
    parameters: {
      type: 'object',
      properties: {
        professional_id: { type: 'string', description: 'id from list_professionals' },
        note: { type: 'string', description: 'Optional one-line caption in the customer language' },
      },
      required: ['professional_id'],
      additionalProperties: false,
    },
    handler: async (args, { directory, photos, chatId }) => {
      if (!directory) return UNAVAILABLE('Das Team-Verzeichnis');
      if (!photos) return UNAVAILABLE('Der Bildversand');
      const professional = directory.getProfessional(args.professional_id);
      if (!professional) return { ok: false, error: `Professional ${args.professional_id} nicht gefunden.` };
      if (!professional.photoFileId) {
        // Not an error the customer should hear as a failure - there is simply
        // no photo on file, and inventing a description instead would be worse.
        return { ok: false, error: `Fuer ${professional.name} ist kein Foto hinterlegt. Sag das ehrlich, beschreibe sie nicht.` };
      }
      try {
        await photos.sendProfessional(chatId, professional, args.note);
        return { ok: true, sent: professional.name };
      } catch (err) {
        return { ok: false, error: `Das Foto konnte nicht gesendet werden: ${err.message}` };
      }
    },
  },
  {
    name: 'check_appointment_slot',
    description:
      'Check whether a professional is free for a service at a given date and time. Always call this before saying anything about a free time - never guess or confirm from memory.',
    parameters: {
      type: 'object',
      properties: {
        professional_id: { type: 'string', description: 'id from list_professionals' },
        service_id: { type: 'string', description: 'id from get_professional_profile' },
        date: { type: 'string', description: 'ISO format YYYY-MM-DD' },
        start_time: { type: 'string', description: 'HH:MM, 24h' },
      },
      required: ['professional_id', 'service_id', 'date', 'start_time'],
      additionalProperties: false,
    },
    handler: async (args, { directory, calendar }) => {
      if (!calendar) return UNAVAILABLE('Der Kalender');
      if (!directory) return UNAVAILABLE('Das Team-Verzeichnis');
      const professional = directory.getProfessional(args.professional_id);
      if (!professional) return { ok: false, error: `Professional ${args.professional_id} nicht gefunden.` };
      const service = directory.getService(args.service_id);
      if (!service) return { ok: false, error: `Service ${args.service_id} nicht gefunden.` };
      return await calendar.checkSlotAvailability({
        professionalId: professional.id,
        professionalName: professional.name,
        date: args.date,
        startTime: args.start_time,
        durationMin: Number(service.durationMin) || 60,
      });
    },
  },
  {
    name: 'create_appointment_request',
    description:
      'Create a PENDING appointment request once professional, service, date, time and customer name are known. This is never a confirmed appointment - the team confirms it afterwards.',
    parameters: {
      type: 'object',
      properties: {
        professional_id: { type: 'string' },
        service_id: { type: 'string' },
        date: { type: 'string', description: 'ISO YYYY-MM-DD' },
        start_time: { type: 'string', description: 'HH:MM, 24h' },
        customer_name: {
          type: 'string',
          description: "The customer's real name, as they gave it. Ask for it if you do not have it. Never invent one and never use 'Customer'.",
        },
        source_portal: { type: 'string', description: 'Where the customer said they found this, if mentioned' },
      },
      required: ['professional_id', 'service_id', 'date', 'start_time', 'customer_name'],
      additionalProperties: false,
    },
    handler: async (args, services) => {
      const { appointments } = services;
      if (!appointments) return UNAVAILABLE('Die Terminverwaltung');
      return await appointments.create({ ...args, chatId: services.chatId });
    },
  },
  {
    name: 'handoff_to_human',
    description:
      'Hand the conversation to a human. Use for complaints, changes to an existing appointment, cancellations, exceptions, or anything you are unsure about, including anything about a service beyond what the price list covers. Tell the customer briefly that a colleague will get back to them, without promising a time.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short category: cancellation | change | exception | complaint | unclear',
        },
        summary: { type: 'string', description: 'One or two sentences for the owner, in German' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    handler: async (args, { notify, chatId, onHandoff }) => {
      if (onHandoff) onHandoff(args);
      if (notify) {
        const { m } = require('../../notify/messages');
        await notify.owner(m().handoffTool(args.reason, chatId, args.summary), { kind: 'handoff', ...args });
      }
      return { ok: true, handed_off: true, reason: args.reason };
    },
  },
];

/** OpenAI tool schemas. */
function toolSchemas() {
  return DEFS.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

/** Runs one tool call. Never throws: the model gets the error as a tool result. */
async function runTool(name, args, services) {
  const def = DEFS.find((d) => d.name === name);
  if (!def) return { ok: false, error: `Unbekanntes Werkzeug: ${name}` };
  try {
    return await def.handler(args || {}, services || {});
  } catch (err) {
    return { ok: false, error: `Werkzeug ${name} fehlgeschlagen: ${err.message}` };
  }
}

module.exports = { DEFS, toolSchemas, runTool };
