const express = require('express');
const axios = require('axios');
const { MessagingResponse } = require('twilio').twiml;
require('dotenv').config();

const { google } = require('googleapis');

const app = express();
app.use(express.urlencoded({ extended: false }));

const historicoConversas = {};

app.post('/whatsapp', async (req, res) => {
  const telefone = req.body.From;
  const msg = req.body && req.body.Body ? req.body.Body.trim() : '';

  if (!historicoConversas[telefone]) {
    historicoConversas[telefone] = [
      {
        role: 'system',
        content: `
Você é um atendente virtual da clínica da Dra. Carolina Figurelli, urologista em Porto Alegre, que atende no Medplex Santana – Rua Gomes Jardim, 201 – sala 1602.

Durante a conversa com o paciente, colete:
- nome completo
- tipo de atendimento: convênio ou particular
- nome do convênio (se aplicável)
- data preferida (formato: 2025-07-05)
- horário preferido (formato: 14:00)

Ofereça no máximo duas opções de horário para cada dia.

No final da resposta, retorne SEMPRE o JSON consolidado com esses dados. Mesmo que nem todos os dados tenham sido preenchidos ainda, mantenha o JSON com as chaves e valores \`null\`.

**Não utilize blocos de código Markdown. Não inclua crases (\`) ao redor do JSON.**

Separe a mensagem e o JSON com \`---\`.
`
      }
    ];
  }

  historicoConversas[telefone].push({ role: 'user', content: msg });

  let mensagemPaciente = '';
  let dadosJson = {};

  try {
    const resp = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: historicoConversas[telefone],
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const respostaIA = resp.data.choices[0].message.content;
    historicoConversas[telefone].push({ role: 'assistant', content: respostaIA });

    const partes = respostaIA.split('---');
    mensagemPaciente = partes[0].trim();

    try {
      const jsonStr = partes[1]
        .replace(/```json/, '')
        .replace(/```/, '')
        .replace(/`/g, '')
        .trim();

      dadosJson = JSON.parse(jsonStr);
      console.log('📦 JSON:', dadosJson);

      // Só agenda se todos os campos necessários estiverem preenchidos
      if (dadosJson.nome && dadosJson.data && dadosJson.horario && dadosJson.tipo_atendimento) {
        await agendarConsultaGoogleCalendar(dadosJson);
      }

    } catch (e) {
      console.error('❌ Erro ao interpretar JSON:', e.message);
    }

  } catch (err) {
    console.error('❌ DeepSeek Error:', err.message);
    mensagemPaciente = 'Desculpe, ocorreu um erro ao tentar responder. Pode tentar de novo?';
  }

  const twiml = new MessagingResponse();
  twiml.message(mensagemPaciente);
  res.type('text/xml').send(twiml.toString());
});

const port = process.env.PORT;
app.listen(port, () => {
  console.log(`🟢 Servidor rodando na porta ${port}`);
});


// ------------------------------
// Função de agendamento no Google Calendar
// ------------------------------
async function agendarConsultaGoogleCalendar(dados) {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  const calendar = google.calendar({ version: 'v3', auth });

  const startDateTime = new Date(`${dados.data}T${dados.horario}:00`);
  const endDateTime = new Date(startDateTime.getTime() + 30 * 60000); // 30 minutos depois

  const evento = {
    summary: `Consulta: ${dados.nome}`,
    description: `Atendimento: ${dados.tipo_atendimento}${dados.convenio ? ` - Convênio: ${dados.convenio}` : ''}`,
    start: { dateTime: startDateTime.toISOString(), timeZone: 'America/Sao_Paulo' },
    end: { dateTime: endDateTime.toISOString(), timeZone: 'America/Sao_Paulo' }
  };

  await calendar.events.insert({
    calendarId: process.env.CALENDAR_ID,
    resource: evento
  });

  console.log('📅 Evento criado com sucesso no Google Calendar');
}
