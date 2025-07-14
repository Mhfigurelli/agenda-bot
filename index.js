// index.js
const express = require('express');
const axios = require('axios');
const { MessagingResponse } = require('twilio').twiml;
const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

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
Hoje é ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.

Você é um atendente virtual da clínica da Dra. Carolina Figurelli, urologista em Porto Alegre, que atende no Medplex Santana – Rua Gomes Jardim, 201 – sala 1602.

Durante a conversa com o paciente, colete:
- nome completo
- tipo de atendimento: convênio ou particular
- nome do convênio (se aplicável)
- data preferida (formato: 2025-07-05)
- horário preferido (formato: 14:00)

Importante:
- Quando o paciente informar todos os dados, **confirme a consulta como agendada** (sem dizer que é pré-agendamento).
- Evite usar palavras como "em breve", "iremos confirmar", ou "pré-agendada".
- Seja gentil e direto, sem prometer retorno posterior.

No final da resposta, **retorne SEMPRE o JSON consolidado** com esses dados. Mesmo que nem todos os dados tenham sido preenchidos ainda, mantenha o JSON com as chaves e valores \`null\`.

Formato do JSON:
\`\`\`json
{
  "nome": null,
  "tipo_atendimento": null,
  "convenio": null,
  "data": null,
  "horario": null
}
\`\`\`

Separe a resposta do paciente e o JSON com três traços: \`---\`.
Responda em português do Brasil.
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
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();

      dadosJson = JSON.parse(jsonStr);
      console.log('📦 JSON:', dadosJson);

      // Se todos os dados estiverem preenchidos, agenda direto
      if (dadosJson.nome && dadosJson.tipo_atendimento && dadosJson.data && dadosJson.horario) {
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

async function agendarConsultaGoogleCalendar(dados) {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  const calendar = google.calendar({ version: 'v3', auth });

  const startDateTime = new Date(`${dados.data}T${dados.horario}:00`);
  const endDateTime = new Date(startDateTime.getTime() + 30 * 60000);

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
}

const port = process.env.PORT;
app.listen(port, () => {
  console.log(`🟢 Servidor rodando na porta ${port}`);
});
