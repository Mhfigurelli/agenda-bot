/**
 * BOT DE ATENDIMENTO – UROLOGIA (WhatsApp via Twilio)
 * Stack: Node.js (CommonJS) + Express + Twilio + Google Calendar + Luxon + Zod + Pino
 * Deploy: Render.com (Web Service)
 *
 * Este arquivo substitui o fluxo anterior controlado 100% por LLM
 * por uma máquina de estados previsível. A LLM (DeepSeek) é opcional
 * apenas para "embelezar" as mensagens.
 *
 * =====================
 * COMO USAR
 * =====================
 * 1) package.json (exemplo):
 *    {
 *      "name": "bot-urologia",
 *      "version": "1.0.0",
 *      "main": "index.js",
 *      "scripts": { "start": "node index.js" },
 *      "dependencies": {
 *        "express": "^4.19.2",
 *        "twilio": "^5.3.6",
 *        "googleapis": "^133.0.0",
 *        "luxon": "^3.5.0",
 *        "zod": "^3.23.8",
 *        "pino": "^9.3.2",
 *        "pino-http": "^10.3.0",
 *        "axios": "^1.7.7"
 *      }
 *    }
 *
 * 2) Variáveis no Render:
 *    - (Twilio) TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *    - (Calendar) GOOGLE_CREDENTIALS (JSON completo) OU GOOGLE_PROJECT_EMAIL + GOOGLE_PRIVATE_KEY
 *    - (Calendar) GOOGLE_CALENDAR_ID OU CALENDAR_ID
 *    - (Clínica) CLINIC_TIMEZONE=America/Sao_Paulo, CLINIC_NAME, CLINIC_ADDRESS, CLINIC_PHONE, ACCEPT_HEALTH_PLANS=true
 *    - (Opcional) DEEPSEEK_API_KEY (para humanizar respostas)
 *    - NÃO crie variável "port" minúscula. Render injeta PORT.
 *
 * 3) Twilio WhatsApp webhook:
 *    - When a message comes in: https://SEU-SERVICE.onrender.com/whatsapp
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
const { z } = require('zod');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { twiml: { MessagingResponse } } = require('twilio');
const axios = require('axios');

// =====================
// APP & LOGS
// =====================
const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio envia x-www-form-urlencoded
app.use(express.json());

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
app.use(pinoHttp({ logger }));

const TZ = process.env.CLINIC_TIMEZONE || 'America/Sao_Paulo';
const CLINIC_NAME = process.env.CLINIC_NAME || 'Clínica de Urologia';
const CLINIC_ADDRESS = process.env.CLINIC_ADDRESS || 'Endereço não configurado';
const CLINIC_PHONE = process.env.CLINIC_PHONE || '';
const ACCEPT_HEALTH_PLANS = String(process.env.ACCEPT_HEALTH_PLANS || 'true') === 'true';

// =====================
// SESSÃO EM MEMÓRIA (trocar por Redis depois)
// =====================
const SESSIONS = new Map();
function getSession(id) {
  if (!SESSIONS.has(id)) SESSIONS.set(id, { state: 'welcome', data: {}, updatedAt: Date.now() });
  return SESSIONS.get(id);
}
function setSession(id, session) {
  session.updatedAt = Date.now();
  SESSIONS.set(id, session);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of SESSIONS.entries()) {
    if (now - v.updatedAt > 1000 * 60 * 60 * 6) SESSIONS.delete(k); // 6h
  }
}, 1000 * 60 * 30);

// =====================
// GOOGLE CALENDAR
// =====================
function googleClient() {
  let email, key;
  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      email = creds.client_email || creds.email;
      key = (creds.private_key || '').replace(/\\n/g, '\n');
    } catch (e) {
      throw new Error('GOOGLE_CREDENTIALS inválido: ' + e.message);
    }
  } else {
    email = process.env.GOOGLE_PROJECT_EMAIL;
    key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  }
  if (!email || !key) throw new Error('Credenciais Google ausentes. Configure GOOGLE_CREDENTIALS ou GOOGLE_PROJECT_EMAIL/GOOGLE_PRIVATE_KEY.');
  const auth = new google.auth.JWT({ email, key, scopes: ['https://www.googleapis.com/auth/calendar'] });
  return google.calendar({ version: 'v3', auth });
}
function getCalendarId() {
  return process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID;
}
async function isFreeSlot(calendarId, startISO, endISO) {
  const calendar = googleClient();
  const resp = await calendar.freebusy.query({
    requestBody: { timeMin: startISO, timeMax: endISO, timeZone: TZ, items: [{ id: calendarId }] },
  });
  const busy = resp.data.calendars?.[calendarId]?.busy || [];
  return busy.length === 0;
}
async function createEvent({ calendarId, summary, description, startISO, endISO, dedupeKey, attendeePhone }) {
  const calendar = googleClient();
  const eventId = crypto.createHash('sha1').update(dedupeKey).digest('hex').slice(0, 24);
  try {
    const existing = await calendar.events.get({ calendarId, eventId });
    if (existing?.data?.id) return existing.data;
  } catch (_) {}
  const event = await calendar.events.insert({
    calendarId,
    requestBody: {
      id: eventId,
      summary,
      description,
      start: { dateTime: startISO, timeZone: TZ },
      end: { dateTime: endISO, timeZone: TZ },
      location: CLINIC_ADDRESS,
      reminders: { useDefault: true },
      extendedProperties: { private: { attendeePhone: attendeePhone || '' } },
    },
  });
  return event.data;
}

// =====================
// SUGESTÃO DE HORÁRIOS
// =====================
const ReasonSchema = z.enum([
  'Consulta',
  'Vasectomia – avaliação',
  'Litíase/Rim – avaliação',
  'HPB/Próstata – avaliação',
  'Disfunção Erétil – avaliação',
  'Pediátrica – avaliação',
]);

function nextClinicSlots({ dateFrom = DateTime.now().setZone(TZ), durationMin = 30, count = 3 }) {
  const slots = [];
  let cursor = dateFrom.plus({ minutes: 15 }).startOf('minute');
  const endWindow = dateFrom.plus({ days: 14 });
  while (cursor < endWindow && slots.length < count) {
    const isWeekday = cursor.weekday <= 5;
    const inMorning = cursor.hour >= 9 && cursor.hour < 12;
    const inAfternoon = cursor.hour >= 14 && cursor.hour < 18;
    if (isWeekday && (inMorning || inAfternoon)) {
      const start = cursor;
      const end = cursor.plus({ minutes: durationMin });
      slots.push({ start, end });
      cursor = cursor.plus({ minutes: 45 });
    } else {
      if (cursor.hour < 9) cursor = cursor.set({ hour: 9, minute: 0 });
      else if (cursor.hour < 14) cursor = cursor.set({ hour: 14, minute: 0 });
      else cursor = cursor.plus({ days: 1 }).set({ hour: 9, minute: 0 });
    }
  }
  return slots;
}

async function suggestFreeSlots({ calendarId, count = 3, durationMin = 30 }) {
  const candidates = nextClinicSlots({ durationMin, count: count * 4 });
  const picked = [];
  for (const c of candidates) {
    const startISO = c.start.toISO();
    const endISO = c.end.toISO();
    /* eslint-disable no-await-in-loop */
    const free = await isFreeSlot(calendarId, startISO, endISO);
    if (free) picked.push({ startISO, endISO, label: c.start.setLocale('pt-BR').toFormat("ccc, dd/LL 'às' HH:mm") });
    if (picked.length >= count) break;
  }
  return picked;
}

// =====================
// TWILIO UTIL
// =====================
const twimlMessage = (text) => {
  const resp = new MessagingResponse();
  resp.message(text);
  return resp.toString();
};

// =====================
// OPTIONAL: DEEPSEEK PARA HUMANIZAR TEXTO
// =====================
async function humanize(text) {
  if (!process.env.DEEPSEEK_API_KEY) return text;
  try {
    const r = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Você é um atendente cordial e objetivo. Reescreva a mensagem mantendo o sentido e a brevidade.' },
        { role: 'user', content: text }
      ],
      temperature: 0.4
    }, {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });
    return r.data.choices?.[0]?.message?.content?.trim() || text;
  } catch (_) { return text; }
}

// =====================
// FSM (Máquina de Estados)
// =====================
function normalizeYesNo(txt) {
  const t = (txt || '').trim().toLowerCase();
  if (["sim", "s", "yes", "y", "ok", "claro"].includes(t)) return true;
  if (["nao", "não", "n", "no"].includes(t)) return false;
  return null;
}
function parseSlotSelection(txt) {
  const m = String(txt).match(/^(1|2|3)$/);
  return m ? Number(m[1]) : null;
}

app.post('/whatsapp', async (req, res) => {
  const from = req.body?.From;
  const body = (req.body?.Body || '').trim();
  if (!from) return res.status(400).send('Missing From');

  const phone = String(from);
  const session = getSession(phone);
  logger.info({ state: session.state, from: phone, text: body }, 'incoming');

  try {
    if (body.toLowerCase() === 'menu' || body.toLowerCase() === 'reiniciar') {
      setSession(phone, { state: 'welcome', data: {} });
    }

    if (session.state === 'welcome') {
      const greet = `Olá! Você está falando com o assistente da ${CLINIC_NAME}.\n`+
        `Endereço: ${CLINIC_ADDRESS}.\n`+
        (CLINIC_PHONE ? `Telefone: ${CLINIC_PHONE}.\n` : '') +
        `Posso ajudar a agendar uma consulta? (responda Sim ou Não)`;
      session.state = 'ask_continue';
      setSession(phone, session);
      res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize(greet)));
      return;
    }

    if (session.state === 'ask_continue') {
      const yes = normalizeYesNo(body);
      if (yes === true) {
        if (ACCEPT_HEALTH_PLANS) {
          session.state = 'ask_insurance';
          setSession(phone, session);
          res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('O atendimento será por convênio (plano de saúde) ou particular?')));
        } else {
          session.state = 'ask_reason';
          setSession(phone, session);
          res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Certo! Qual o motivo da consulta? (Ex.: Consulta, Vasectomia – avaliação, HPB/Próstata – avaliação, etc.)')));
        }
        return;
      }
      if (yes === false) {
        res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Sem problemas! Se precisar, envie "menu" para recomeçar.')));
        setSession(phone, { state: 'welcome', data: {} });
        return;
      }
      res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Não entendi. Responda com Sim ou Não, por favor.')));
      return;
    }

    if (session.state === 'ask_insurance') {
      const t = body.toLowerCase();
      if (t.includes('particular')) {
        session.data.billing = { mode: 'particular' };
        session.state = 'ask_reason';
        setSession(phone, session);
        res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Perfeito. Qual o motivo da consulta?')));
        return;
      }
      if (t.includes('convenio') || t.includes('convênio') || t.includes('plano')) {
        session.data.billing = { mode: 'convenio' };
        session.state = 'ask_plan_name';
        setSession(phone, session);
        res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Qual o nome do seu plano de saúde?')));
        return;
      }
      res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Por favor, responda "particular" ou "convênio".')));
      return;
    }

    if (session.state === 'ask_plan_name') {
      session.data.planName = body;
      session.state = 'ask_reason';
      setSession(phone, session);
      res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Obrigado! Qual o motivo da consulta?')));
      return;
    }

    if (session.state === 'ask_reason') {
      const reason = body.trim();
      const parsed = ReasonSchema.safeParse(reason);
      session.data.reason = parsed.success ? parsed.data : reason;
      session.state = 'propose_slots';
      setSession(phone, session);

      const calendarId = getCalendarId();
      const suggestions = await suggestFreeSlots({ calendarId, count: 3, durationMin: 30 });
      if (suggestions.length === 0) {
        res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Não encontrei horários livres nos próximos dias. Pode me dizer um dia e horário preferidos?')));
        return;
      }
      session.data.suggestions = suggestions;
      setSession(phone, session);
      const msg = [
        'Tenho estes horários:',
        ...suggestions.map((s, i) => `${i + 1}) ${s.label}`),
        'Responda com 1, 2 ou 3 para escolher.',
      ].join('\n');
      res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize(msg)));
      return;
    }

    if (session.state === 'propose_slots') {
      const pick = parseSlotSelection(body);
      const list = session.data.suggestions || [];
      if (!pick || !list[pick - 1]) {
        res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Por favor, escolha 1, 2 ou 3.')));
        return;
      }
      const chosen = list[pick - 1];
      session.data.chosen = chosen;
      session.state = 'confirm_slot';
      setSession(phone, session);
      res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize(`Você confirma ${chosen.label}? (Sim/Não)`)));
      return;
    }

    if (session.state === 'confirm_slot') {
      const yes = normalizeYesNo(body);
      if (yes === true) {
        const calendarId = getCalendarId();
        const { startISO, endISO } = session.data.chosen;
        const summary = `${session.data.reason} – ${CLINIC_NAME}`;
        const descriptionParts = [ `Origem: WhatsApp`, `Telefone: ${phone}` ];
        if (session.data.billing?.mode === 'convenio') descriptionParts.push(`Convênio: ${session.data.planName || ''}`);
        const description = descriptionParts.join('\n');
        const dedupeKey = `${phone}|${startISO}|${endISO}`;

        const stillFree = await isFreeSlot(calendarId, startISO, endISO);
        if (!stillFree) {
          session.state = 'ask_reason';
          setSession(phone, session);
          res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Poxa, esse horário acabou de ser ocupado. Vamos tentar outro. Qual o motivo da consulta mesmo?')));
          return;
        }

        const event = await createEvent({
          calendarId,
          summary,
          description,
          startISO,
          endISO,
          dedupeKey,
          attendeePhone: phone,
        });

        session.state = 'booked';
        session.data.eventId = event.id;
        setSession(phone, session);

        const when = DateTime.fromISO(startISO).setZone(TZ).setLocale('pt-BR').toFormat("cccc, dd 'de' LLLL 'às' HH:mm");
        const done = `Agendamento confirmado para ${when}.\n`+
          `${CLINIC_NAME}\n${CLINIC_ADDRESS}\n`+
          (CLINIC_PHONE ? `Dúvidas: ${CLINIC_PHONE}\n` : '')+
          'Se precisar remarcar, responda "menu" para recomeçar.';
        res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize(done)));
        return;
      }
      if (yes === false) {
        session.state = 'ask_reason';
        setSession(phone, session);
        res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Sem problemas. Qual o motivo da consulta?')));
        return;
      }
      res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Responda com Sim ou Não, por favor.')));
      return;
    }

    if (session.state === 'booked') {
      res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Você já tem um agendamento. Envie "menu" para iniciar um novo fluxo.')));
      return;
    }

    // fallback
    res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Desculpe, não entendi. Envie "menu" para recomeçar.')));
  } catch (err) {
    logger.error({ err }, 'handler error');
    res.set('Content-Type', 'text/xml').send(twimlMessage('Tive um erro aqui do meu lado. Pode enviar "menu" para recomeçar?'));
  }
});

app.get('/', (_req, res) => {
  res.status(200).send({ status: 'ok', service: 'bot-urologia', tz: TZ });
});

const port = process.env.PORT || 3000; // Render injeta PORT
app.listen(port, () => {
  logger.info(`bot-urologia running on port ${port}`);
});
