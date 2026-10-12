'use strict';
/**
 * Tool registry for OpenAI function calling.
 *
 * Each tool declares its JSON schema and a handler. Handlers receive the injected
 * services; a tool whose service is not wired yet reports that honestly instead of
 * throwing, so the agent loop can be tested before the catalog and calendar exist.
 *
 * Services (all optional, filled in per phase):
 *   catalog   { search(query), byId(id) }
 *   calendar  { checkAvailability({productId, start}), createEvent(booking) }
 *   bookings  { create(booking) }
 *   messenger { sendProduct(chatId, product) }
 *   notify    { owner(text, meta) }
 */

const UNAVAILABLE = (what) => ({
  ok: false,
  error: `${what} ist noch nicht angebunden. Sag dem Kunden, dass du das gerade nicht pruefen kannst, und gib den Fall weiter.`,
});

const DEFS = [
  {
    name: 'search_products',
    description:
      'Search the rental catalog for decoration sets. Use whenever the customer mentions a theme, colour, age or occasion. Never name products or prices from memory.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text from the customer, e.g. "Einhorn Geburtstag 5 Jahre"' },
        theme: { type: 'string', description: 'Theme if known, e.g. Einhorn, Prinzessin, Dino' },
        color: { type: 'string', description: 'Colour wish if known, e.g. rosa, gold' },
        limit: { type: 'integer', description: 'Max results, default 5', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args, { catalog }) => {
      if (!catalog) return UNAVAILABLE('Der Produktkatalog');
      const results = await catalog.search(args);
      return { ok: true, count: results.length, products: results };
    },
  },
  {
    name: 'send_product',
    description:
      'Send one product to the customer as a picture with name, price and shop link. Call once per product, at most 3 per reply.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'id or handle from search_products' },
        note: { type: 'string', description: 'Optional one-line caption in the customer language' },
      },
      required: ['product_id'],
      additionalProperties: false,
    },
    handler: async (args, { catalog, messenger, chatId }) => {
      if (!catalog || !messenger) return UNAVAILABLE('Der Produktversand');
      const product = await catalog.byId(args.product_id);
      if (!product) return { ok: false, error: `Produkt ${args.product_id} nicht gefunden.` };
      await messenger.sendProduct(chatId, product, args.note);
      return { ok: true, sent: product.title };
    },
  },
  {
    name: 'check_availability',
    description:
      'Check whether a product is free for the 3-day rental window starting on the pickup date. Always call this before saying anything about free dates.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'id or handle from search_products' },
        start_date: { type: 'string', description: 'Pickup date, ISO format YYYY-MM-DD' },
      },
      required: ['product_id', 'start_date'],
      additionalProperties: false,
    },
    handler: async (args, { calendar }) => {
      if (!calendar) return UNAVAILABLE('Der Kalender');
      return await calendar.checkAvailability({
        productId: args.product_id,
        start: args.start_date,
      });
    },
  },
  {
    name: 'create_booking_request',
    description:
      'Create a PENDING booking request once product, pickup date and customer name are known. This is never a confirmed booking. After calling it, send the shop link and ask the customer to pay there.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        start_date: { type: 'string', description: 'Pickup date, ISO YYYY-MM-DD' },
        customer_name: { type: 'string', description: "The customer's real name, as they gave it. Ask for it if you do not have it. Never invent one and never use 'Customer'." },
        occasion: { type: 'string', description: 'e.g. 5. Geburtstag' },
        child_age: {
          type: 'integer',
          description: 'How old the celebrated person turns, in YEARS. This is NOT the party date. Leave it out if the customer has not said it.',
        },
        theme_notes: { type: 'string', description: 'Theme, colours, wishes' },
        has_reference_photo: { type: 'boolean' },
      },
      required: ['product_id', 'start_date', 'customer_name'],
      additionalProperties: false,
    },
    handler: async (args, services) => {
      const { bookings } = services;
      if (!bookings) return UNAVAILABLE('Die Buchungsverwaltung');
      return await bookings.create({ ...args, chatId: services.chatId });
    },
  },
  {
    name: 'handoff_to_human',
    description:
      'Hand the conversation to a human. Use for damage, loss, cancellation, changes to an existing booking, exceptions, extensions, complaints, or anything you are unsure about. Tell the customer briefly that a colleague will get back to them, without promising a time.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short category: damage | cancellation | change | exception | extension | complaint | unclear',
        },
        summary: { type: 'string', description: 'One or two sentences for the owner, in German' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    handler: async (args, { notify, chatId, onHandoff }) => {
      if (onHandoff) onHandoff(args);
      if (notify) {
        await notify.owner(
          `Uebergabe an Mensch (${args.reason})\nChat: ${chatId || 'n/a'}\n${args.summary || ''}`,
          { kind: 'handoff', ...args }
        );
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
