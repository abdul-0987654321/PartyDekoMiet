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

/**
 * Finds a record by id, or by the name the customer used.
 *
 * The ids are generated strings like S20261022-4F2QX. The model is told to pass
 * one, and mostly does - but a customer says "Sofia detail", and "Sofia" is
 * right there in the conversation, so it passes that instead. A strict id
 * lookup then returns "not found", and the customer is told "I'm unable to
 * retrieve the details" about a service that exists and is on screen.
 *
 * Refusing on a technicality is the wrong trade here: resolving the name is
 * unambiguous whenever the name is, and when it is not, saying which ones
 * matched is far better than a flat failure.
 *
 * @returns {{record: object}|{error: string}}
 */
function resolve(list, wanted, what) {
  const key = String(wanted ?? '').trim();
  if (!key) return { error: `Kein ${what} angegeben.` };

  const byId = list.find((r) => r.id === key);
  if (byId) return { record: byId };

  const lower = key.toLowerCase();
  const exact = list.filter((r) => String(r.name || '').toLowerCase() === lower);
  if (exact.length === 1) return { record: exact[0] };

  const partial = list.filter((r) => String(r.name || '').toLowerCase().includes(lower));
  if (partial.length === 1) return { record: partial[0] };

  if (exact.length > 1 || partial.length > 1) {
    const names = (exact.length > 1 ? exact : partial).map((r) => r.name).join(', ');
    return { error: `"${key}" passt auf mehrere: ${names}. Frag den Kunden, welche gemeint ist.` };
  }
  return {
    error: list.length
      ? `${what} "${key}" gibt es nicht. Vorhanden: ${list.map((r) => r.name).join(', ')}.`
      : `Es ist noch kein ${what} hinterlegt.`,
  };
}

/**
 * One shape for a service, everywhere it is returned.
 *
 * Price and duration are spelled out as strings as well as given as numbers.
 * A bare `"priceChf": 1000` next to a bare `"durationMin": 15` was quoted back
 * to a customer as "15 minutes, 10 CHF" - the model mixed two unlabelled
 * numbers up. `"price": "CHF 1000.-"` cannot be mixed up with `"duration":
 * "15 Minuten"`, and the numbers stay for anything that needs to compute.
 */
function serviceView(s) {
  // Number('') is 0, and a price of 0 is a real price - "free" is not the same
  // answer as "not filled in yet". So an empty field stays absent.
  const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
  const price = num(s.priceChf);
  const mins = num(s.durationMin);
  return {
    id: s.id,
    name: s.name,
    price: Number.isFinite(price) && price > 0 ? `CHF ${price}.-` : 'kein Preis hinterlegt',
    duration: Number.isFinite(mins) && mins > 0 ? `${mins} Minuten` : 'keine Dauer hinterlegt',
    priceChf: Number.isFinite(price) ? price : null,
    durationMin: Number.isFinite(mins) ? mins : null,
    // What the service includes. Empty means the owner has not written it yet -
    // say so, never invent one.
    details: String(s.notes || '').trim(),
  };
}

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
        services: services.map(serviceView),
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
        professional_id: { type: 'string', description: 'id from list_professionals; her name also works' },
      },
      required: ['professional_id'],
      additionalProperties: false,
    },
    handler: async (args, { directory }) => {
      if (!directory) return UNAVAILABLE('Das Team-Verzeichnis');
      const hit = resolve(directory.listProfessionals({ activeOnly: true }), args.professional_id, 'Professional');
      if (hit.error) return { ok: false, error: hit.error };
      const profile = directory.profileFor(hit.record.id);
      if (!profile) return { ok: false, error: `Professional ${hit.record.name} nicht gefunden.` };
      return {
        ok: true,
        professional: {
          id: profile.professional.id,
          name: profile.professional.name,
          languages: profile.professional.languages,
          workingHours: profile.professional.workingHours || '',
          hasPhoto: Boolean(profile.professional.photoFileId),
        },
        services: profile.services.map(serviceView),
        location: profile.location ? { name: profile.location.name, address: profile.location.address } : null,
      };
    },
  },
  {
    name: 'get_service',
    description:
      'Everything known about ONE service: what it includes, how long it takes, what it costs, and who offers it. Call this whenever a customer asks about a particular service by name - never answer "I cannot retrieve the details".',
    parameters: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'id from list_services; the service name also works' },
      },
      required: ['service_id'],
      additionalProperties: false,
    },
    handler: async (args, { directory }) => {
      if (!directory) return UNAVAILABLE('Das Team-Verzeichnis');
      const hit = resolve(directory.listServices({ activeOnly: true }), args.service_id, 'Service');
      if (hit.error) return { ok: false, error: hit.error };
      const service = hit.record;

      // A service either belongs to one professional or is offered by everyone.
      // The customer asked about the service, so answer for the service.
      const all = directory.listProfessionals({ activeOnly: true });
      const offeredBy = service.professionalId
        ? all.filter((p) => p.id === service.professionalId)
        : all;

      return {
        ok: true,
        service: serviceView(service),
        offeredBy: offeredBy.map((p) => ({
          id: p.id,
          name: p.name,
          languages: p.languages,
          workingHours: p.workingHours || '',
          hasPhoto: Boolean(p.photoFileId),
        })),
        note: serviceView(service).details
          ? undefined
          : 'Zu diesem Service ist keine Beschreibung hinterlegt. Sag ehrlich, dass dazu nichts weiter hinterlegt ist, nenne Dauer und Preis, und biete an, die Frage ans Team weiterzugeben. Erfinde keine Beschreibung.',
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
        professional_id: { type: 'string', description: 'id from list_professionals; her name also works' },
        note: { type: 'string', description: 'Optional one-line caption in the customer language' },
      },
      required: ['professional_id'],
      additionalProperties: false,
    },
    handler: async (args, { directory, photos, chatId }) => {
      if (!directory) return UNAVAILABLE('Das Team-Verzeichnis');
      if (!photos) return UNAVAILABLE('Der Bildversand');
      const hit = resolve(directory.listProfessionals({ activeOnly: true }), args.professional_id, 'Professional');
      if (hit.error) return { ok: false, error: hit.error };
      const professional = hit.record;
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
        professional_id: { type: 'string', description: 'id from list_professionals; her name also works' },
        service_id: { type: 'string', description: 'id from get_professional_profile; the service name also works' },
        date: { type: 'string', description: 'ISO format YYYY-MM-DD' },
        start_time: { type: 'string', description: 'HH:MM, 24h' },
      },
      required: ['professional_id', 'service_id', 'date', 'start_time'],
      additionalProperties: false,
    },
    handler: async (args, { directory, calendar }) => {
      if (!calendar) return UNAVAILABLE('Der Kalender');
      if (!directory) return UNAVAILABLE('Das Team-Verzeichnis');
      const who = resolve(directory.listProfessionals({ activeOnly: true }), args.professional_id, 'Professional');
      if (who.error) return { ok: false, error: who.error };
      const what = resolve(directory.listServices({ activeOnly: true }), args.service_id, 'Service');
      if (what.error) return { ok: false, error: what.error };
      const professional = who.record;
      const service = what.record;
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
