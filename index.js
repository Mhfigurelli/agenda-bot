/**
 * BOT DE ATENDIMENTO – UROLOGIA (WhatsApp via Twilio)
 * Stack: Node.js (CommonJS) + Express + Twilio + Google Calendar + Luxon + Zod + Pino
 * Deploy: Render.com (Web Service)
 *
 * Versão estável – humanização DESATIVADA (humanize = no-op).
 * Regras novas:
 *  - IPE/IPERGS: só oferece horários a partir de 14 dias.
 *  - Particular: prioriza horários mais próximos.
 *  - Grade de 15 em 15 minutos (00, 15, 30, 45).
 *  - Sempre oferece apenas 2 opções por vez.
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

// =====================
// APP & LOGS
// =====================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
app.use(pinoHttp({ logger }));

const TZ = process.env.CLINIC_TIMEZONE || 'America/Sao_Paulo';
const CLINIC_NAME = process.env.CLINIC_NAME || 'Dra. Carolina Figurelli – Urologia';
const CLINIC_ADDRESS = process.env.CLINIC_ADDRESS || 'Medplex Santana – R. Gomes Jardim, 201 – sala 1602';
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
function setSession(id, session) { session.updatedAt = Date.now(); SESSIONS.set(id, session); }
setInterval(() => { const now = Date.now(); for (const [k, v] of SESSIONS.entries()) { if (now - v.updatedAt > 1000 * 60 * 60 * 6) SESSIONS.delete(k); } }, 1000 * 60 * 30);

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
function getCalendarId() { return process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID; }
async function isFreeSlot(calendarId, startISO, endISO) {
  const calendar = googleClient();
  const resp = await calendar.freebusy.query({ requestBody: { timeMin: startISO, timeMax: endISO, timeZone: TZ, items: [{ id: calendarId }] } });
  const busy = resp.data.calendars?.[calendarId]?.busy || [];
  return busy.length === 0;
}
async function createEvent({ calendarId, summary, description, startISO, endISO, dedupeKey, attendeePhone }) {
  const calendar = googleClient();
  const eventId = crypto.createHash('sha1').update(dedupeKey).digest('hex').slice(0, 24);
  try { const existing = await calendar.events.get({ calendarId, eventId }); if (existing?.data?.id) return existing.data; } catch (_) {}
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
// SLOTS & PARSERS
// =====================
const ReasonSchema = z.enum([
  'Consulta', 'Vasectomia – avaliação', 'Litíase/Rim – avaliação', 'HPB/Próstata – avaliação', 'Disfunção Erétil – avaliação', 'Pediátrica – avaliação',
]);

function isIpe(name = '') {
  const n = String(name || '').normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return /\b(ipe|ipergs)\b/i.test(n);
}

function snapToQuarter(dt) {
  // arredonda pra cima pro próximo múltiplo de 15 minutos
  const m = dt.minute;
  const next = Math.ceil(m / 15) * 15;
  if (next === 60) return dt.plus({ hours: 1 }).set({ minute: 0, second: 0, millisecond: 0 });
  return dt.set({ minute: next, second: 0, millisecond: 0 });
}

function nextClinicSlots({ dateFrom = DateTime.now().setZone(TZ), durationMin = 15, count = 2 }) {
  const slots = [];
  let cursor = snapToQuarter(dateFrom.set({ second: 0, millisecond: 0 }).plus({ minutes: 1 }));
  const endWindow = dateFrom.plus({ days: 14 });
  while (cursor < endWindow && slots.length < count) {
    const isWeekday = cursor.weekday <= 5;
    const inMorning = cursor.hour >= 9 && cursor.hour < 12;
    const inAfternoon = cursor.hour >= 14 && cursor.hour < 18;
    if (isWeekday && (inMorning || inAfternoon) && [0, 15, 30, 45].includes(cursor.minute)) {
      const start = cursor;
      const end = cursor.plus({ minutes: durationMin });
      slots.push({ start, end });
      cursor = cursor.plus({ minutes: 15 }); // blocos de 15 em 15
    } else {
      if (cursor.hour < 9) cursor = cursor.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
      else if (cursor.hour < 14) cursor = cursor.set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
      else cursor = cursor.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
      cursor = snapToQuarter(cursor);
    }
  }
  return slots;
}

async function suggestFreeSlots({ calendarId, count = 2, durationMin = 15, dateFrom = DateTime.now().setZone(TZ) }) {
  const candidates = nextClinicSlots({ dateFrom, durationMin, count: count * 12 });
  const picked = [];
  for (const c of candidates) {
    const startISO = c.start.toISO();
    const endISO = c.end.toISO();
    // eslint-disable-next-line no-await-in-loop
    const free = await isFreeSlot(calendarId, startISO, endISO);
    if (free) picked.push({ startISO, endISO, label: c.start.setLocale('pt-BR').toFormat("ccc, dd/LL 'às' HH:mm") });
    if (picked.length >= count) break;
  }
  return picked;
}

async function suggestForSpecificDay({ calendarId, date, count = 2, durationMin = 15 }) {
  let cursor = snapToQuarter(date.setZone(TZ).startOf('day').set({ hour: 9, minute: 0 }));
  const endDay = date.setZone(TZ).endOf('day');
  const picked = [];
  while (cursor < endDay && picked.length < count) {
    const inMorning = cursor.hour >= 9 && cursor.hour < 12; const inAfternoon = cursor.hour >= 14 && cursor.hour < 18;
    if (inMorning || inAfternoon) {
      const startISO = cursor.toISO();
      const endISO = cursor.plus({ minutes: durationMin }).toISO();
      // eslint-disable-next-line no-await-in-loop
      const free = await isFreeSlot(calendarId, startISO, endISO);
      if (free) picked.push({ startISO, endISO, label: cursor.setLocale('pt-BR').toFormat("ccc, dd/LL 'às' HH:mm") });
      cursor = cursor.plus({ minutes: 15 });
    } else {
      if (cursor.hour < 9) cursor = cursor.set({ hour: 9, minute: 0 });
      else if (cursor.hour < 14) cursor = cursor.set({ hour: 14, minute: 0 });
      else cursor = cursor.plus({ days: 1 }).set({ hour: 9, minute: 0 });
      cursor = snapToQuarter(cursor);
    }
  }
  return picked;
}

function parsePreferredDate(text) {
  if (!text) return null; const t = text.toLowerCase();
  const now = DateTime.now().setZone(TZ);
  const weekdays = { 'segunda': 1, 'terca': 2, 'terça': 2, 'quarta': 3, 'quinta': 4, 'sexta': 5 };
  if (/(hoje)/.test(t)) return now;
  if (/(amanh[aã])/.test(t)) return now.plus({ days: 1 });
  const mProx = t.match(/pr[oó]xim[aoa]?\s+(segunda|ter[cç]a|terça|quarta|quinta|sexta)/);
  if (mProx) { const wd = weekdays[mProx[1].normalize('NFD').replace(/\p{Diacritic}/gu, '')]; return nextWeekday(now, wd); }
  const mWd = t.match(/\b(segunda|ter[cç]a|terça|quarta|quinta|sexta)\b/);
  if (mWd) { const wd = weekdays[mWd[1].normalize('NFD').replace(/\p{Diacritic}/gu, '')]; return nextOrSameWeekday(now, wd); }
  return null;
}
function nextOrSameWeekday(from, targetWd) { let d = from; for (let i = 0; i < 7; i++) { if (d.weekday === targetWd && d >= from.startOf('day')) return d; d = d.plus({ days: 1 }); } return null; }
function nextWeekday(from, targetWd) { let d = from.plus({ days: 1 }); for (let i = 0; i < 7; i++) { if (d.weekday === targetWd) return d; d = d.plus({ days: 1 }); } return null; }

// =====================
// TWILIO UTIL
// =====================
const twimlMessage = (text) => { const resp = new MessagingResponse(); resp.message(text); return resp.toString(); };

// =====================
// HUMANIZE (NO-OP) – DESATIVADA
// =====================
async function humanize(text) { return text; }

// =====================
// FSM (Máquina de Estados)
// =====================
function parseSlotSelection(txt) { const m = String(txt).match(/^(1|2)$/); return m ? Number(m[1]) : null; }

app.post('/whatsapp', async (req, res) => {
  const from = req.body?.From; const body = (req.body?.Body || '').trim(); if (!from) return res.status(400).send('Missing From');
  const phone = String(from); let session = getSession(phone);
  // Reinício rápido do fluxo (menu, remarcar, etc.)
  const lower = (body || '').toLowerCase();
  const restartWords = ['menu','reiniciar','recomeçar','recomecar','começar','comecar','novo','novo atendimento','reagendar','remarcar','cancelar','agendar de novo'];
  if (restartWords.some(w => lower.includes(w))) {
    setSession(phone, { state: 'welcome', data: {} });
    session = getSession(phone);
  }
  logger.info({ state: session.state, from: phone, text: body }, 'incoming');

  try {
    if (session.state === 'welcome') {
      const greet = `Olá! Eu sou a assistente da ${CLINIC_NAME}.\n${CLINIC_ADDRESS}${CLINIC_PHONE ? `\nTelefone: ${CLINIC_PHONE}` : ''}`;
      session.state = 'ask_name';
      setSession(phone, session);
      const ask = await humanize(greet + '\nComo posso te chamar? (nome e sobrenome)');
      res.set('Content-Type', 'text/xml').send(twimlMessage(ask));
      return;
    }

    if (session.state === 'ask_name') {
      const name = body.replace(/[\n\r]/g,' ').trim(); if (name.length < 2) { res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Pode me dizer seu nome completo?'))); return; }
      session.data.name = name; if (ACCEPT_HEALTH_PLANS) { session.state = 'ask_insurance'; setSession(phone, session); res.set('Content-Type','text/xml').send(twimlMessage(await humanize(`Obrigada, ${name.split(' ')[0]}! O atendimento será por convênio ou particular?`))); return; }
      session.state = 'ask_reason'; setSession(phone, session); res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Ótimo! Qual o motivo da consulta? Se já tiver um dia em mente, pode dizer “amanhã”, “próxima quarta”, etc.'))); return;
    }

    if (session.state === 'ask_insurance') {
      const t = body.toLowerCase();
      if (t.includes('particular')) { session.data.billing = { mode:'particular' }; session.state='ask_reason'; setSession(phone, session); res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Perfeito. Qual o motivo da consulta? Se quiser, já diga um dia (ex.: “próxima quarta”).'))); return; }
      if (t.includes('convenio') || t.includes('convênio') || t.includes('plano')) { session.data.billing = { mode:'convenio' }; session.state='ask_plan_name'; setSession(phone, session); res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Qual é o nome do seu plano?'))); return; }
      res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Certo, é por convênio ou particular?'))); return;
    }

    if (session.state === 'ask_plan_name') { session.data.planName = body.trim(); session.state='ask_reason'; setSession(phone, session); res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Obrigado! Qual o motivo da consulta? Se já tiver um dia em mente, pode me dizer.'))); return; }

    if (session.state === 'ask_reason') {
      const reason = body.trim(); const parsed = ReasonSchema.safeParse(reason); session.data.reason = parsed.success ? parsed.data : reason; session.state = 'propose_slots'; setSession(phone, session);
      const preferred = parsePreferredDate(body);
      const calendarId = getCalendarId();
      const isIpePlan = session.data.billing?.mode === 'convenio' && isIpe(session.data.planName);
      let suggestions = [];
      let info = null;
      if (isIpePlan) {
        const minIpe = DateTime.now().setZone(TZ).plus({ weeks: 2 }).startOf('day').set({ hour: 9, minute: 0 });
        if (preferred) {
          const base = preferred < minIpe ? minIpe : preferred;
          if (preferred < minIpe) info = `Para ${session.data.planName}, podemos agendar a partir de ${minIpe.setLocale('pt-BR').toFormat('dd/LL')}.`;
          suggestions = await suggestForSpecificDay({ calendarId, date: base, count: 2, durationMin: 15 });
        } else {
          info = `Para ${session.data.planName}, os horários começam a partir de ${minIpe.setLocale('pt-BR').toFormat('dd/LL')}.`;
          suggestions = await suggestFreeSlots({ calendarId, count: 2, durationMin: 15, dateFrom: minIpe });
        }
      } else {
        if (preferred) suggestions = await suggestForSpecificDay({ calendarId, date: preferred, count: 2, durationMin: 15 });
        else suggestions = await suggestFreeSlots({ calendarId, count: 2, durationMin: 15 });
      }
      if (suggestions.length === 0) { res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Não encontrei horários livres agora. Pode me dizer um dia que prefira, tipo “amanhã” ou “próxima quarta”?'))); return; }
      session.data.suggestions = suggestions; setSession(phone, session);
      const firstName = (session.data.name || '').split(' ')[0] || '';
      const lines = [];
      if (info) lines.push(info);
      lines.push(firstName ? `${firstName}, encontrei estes horários:` : 'Encontrei estes horários:');
      lines.push(...suggestions.map((s,i)=> `${i+1}) ${s.label}`));
      lines.push('Pode escolher 1 ou 2. Se preferir outro dia, diga (ex.: “próxima quarta”).');
      const msg = lines.join('\n');
      res.set('Content-Type','text/xml').send(twimlMessage(await humanize(msg))); return;
    }

    if (session.state === 'propose_slots') {
      const preferred = parsePreferredDate(body);
      const isIpePlan = session.data.billing?.mode === 'convenio' && isIpe(session.data.planName);
      if (preferred) {
        const calendarId = getCalendarId();
        let base = preferred;
        let info = null;
        if (isIpePlan) {
          const minIpe = DateTime.now().setZone(TZ).plus({ weeks: 2 }).startOf('day').set({ hour: 9, minute: 0 });
          if (preferred < minIpe) { base = minIpe; info = `Para ${session.data.planName}, começamos a partir de ${minIpe.setLocale('pt-BR').toFormat('dd/LL')}.`; }
        }
        const suggestions = await suggestForSpecificDay({ calendarId, date: base, count: 2, durationMin: 15 });
        if (suggestions.length === 0) { res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Esse dia está cheio. Podemos tentar outro?'))); return; }
        session.data.suggestions = suggestions; setSession(phone, session);
        const msg = [ info ? info : 'Ótimo! Para essa data, tenho:', ...suggestions.map((s,i)=> `${i+1}) ${s.label}`), 'Qual fica melhor? (1 ou 2)' ].join('\n');
        res.set('Content-Type','text/xml').send(twimlMessage(await humanize(msg))); return;
      }
      const pick = parseSlotSelection(body); const list = session.data.suggestions || [];
      if (!pick || !list[pick - 1]) { res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Certo, me diga o número do horário (1 ou 2) ou uma data, tipo “amanhã”/“próxima quarta”.'))); return; }
      const chosen = list[pick - 1]; session.data.chosen = chosen; session.state = 'confirm_slot'; setSession(phone, session);
      const name = (session.data.name || '').split(' ')[0] || '';
      res.set('Content-Type','text/xml').send(twimlMessage(await humanize(`${name ? name + ', ' : ''}confirmo ${chosen.label}? (Sim/Não)`))); return;
    }

    if (session.state === 'confirm_slot') {
      const t = body.toLowerCase(); const yes = ['sim','s','yes','y','ok','claro'].includes(t); const no = ['nao','não','n','no'].includes(t);
      if (yes) {
        const calendarId = getCalendarId(); const { startISO, endISO } = session.data.chosen; const summary = `${session.data.reason} – ${CLINIC_NAME}`;
        const descriptionParts = [ `Origem: WhatsApp`, `Telefone: ${phone}`, `Paciente: ${session.data.name || ''}` ]; if (session.data.billing?.mode === 'convenio') descriptionParts.push(`Convênio: ${session.data.planName || ''}`);
        const description = descriptionParts.join('\n'); const dedupeKey = `${phone}|${startISO}|${endISO}`;
        const stillFree = await isFreeSlot(calendarId, startISO, endISO);
        if (!stillFree) { session.state = 'ask_reason'; setSession(phone, session); res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Esse horário acabou de ficar indisponível. Me diga o motivo da consulta e eu te ofereço novas opções, tudo bem?'))); return; }
        const event = await createEvent({ calendarId, summary, description, startISO, endISO, dedupeKey, attendeePhone: phone });
        session.state = 'booked'; session.data.eventId = event.id; setSession(phone, session);
        const when = DateTime.fromISO(startISO).setZone(TZ).setLocale('pt-BR').toFormat("cccc, dd 'de' LLLL 'às' HH:mm");
        const done = `Perfeito, ficou agendado para ${when}.\n${CLINIC_NAME}\n${CLINIC_ADDRESS}${CLINIC_PHONE ? `\nDúvidas: ${CLINIC_PHONE}` : ''}\nSe precisar remarcar, é só escrever “menu”.`;
        res.set('Content-Type','text/xml').send(twimlMessage(await humanize(done))); return;
      }
      if (no) { session.state = 'ask_reason'; setSession(phone, session); res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Sem problema. Qual o motivo da consulta e qual dia você prefere?'))); return; }
      res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Responda com Sim ou Não, por favor.'))); return;
    }

    if (session.state === 'booked') { res.set('Content-Type','text/xml').send(twimlMessage(await humanize('Você já tem um agendamento confirmado. Para iniciar outro ou remarcar, envie “menu” ou escreva “remarcar”.'))); return; }

    // fallback
    res.set('Content-Type', 'text/xml').send(twimlMessage(await humanize('Desculpe, não entendi. Podemos tentar de novo?')));
  } catch (err) {
    logger.error({ err }, 'handler error');
    res.set('Content-Type', 'text/xml').send(twimlMessage('Tive um erro aqui do meu lado. Pode enviar "menu" para recomeçar?'));
  }
});

app.get('/', (_req, res) => { res.status(200).send({ status: 'ok', service: 'bot-urologia', tz: TZ }); });

const port = process.env.PORT || 3000; // Render injeta PORT
app.listen(port, () => { logger.info(`bot-urologia running on port ${port}`); });
