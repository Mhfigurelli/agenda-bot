const express = require('express');
const axios = require('axios');
const { MessagingResponse } = require('twilio').twiml;
const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));

const historicoConversas = {};

// 🔧 Utilitário para limpar e interpretar JSON vindo da IA
function limparJsonResposta(texto) {
  const match = texto.match(/({[\s\S]*})/);
  if (!match) throw new Error('JSON não encontrado na resposta');
  const jsonLimpo = match[1]
    .replace(/`/g, '"')
    .replace(/'/g, '"')
    .replace(/\\n/g, '')
    .replace(/\s+/g, ' ');
  return JSON.parse(jsonLimpo);
}

// 📆 Função para agendar no Google Calendar
async function agendarConsultaGoogleCalendar(dados) {
  if (!dados.nome || !dados.data || !dados.horario) {
    console.log('⚠️ Dados incompletos para agendamento. JSON:', dados);
    return;
  }

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

  console.log(`📅 Consulta marcada para ${dados.nome} em ${dados.data} às ${dados.horario}`);
}

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
- data preferida (formato: DD/MM/AAAA)
- horário preferido (formato: 14:00)

Ofereça no máximo duas opções de horário para cada dia.

No final da resposta, retorne SEMPRE o JSON consolidado com esses dados. Mesmo que nem todos os dados tenham sido preenchidos ainda, mantenha o JSON com as chaves e valores null.

Sempre use aspas duplas (") no JSON.

Responda em português do Brasil. Separe o texto do JSON com três hifens (\`---\`).
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
      dadosJson = limparJsonResposta(partes[1]);
      console.log('📦 JSON:', dadosJson);

      // 🔁 Agenda se tiver os campos obrigatórios
      if (dadosJson.nome && dadosJson.data && dadosJson.horario) {
  try {
    // Normaliza o horário para o formato HH:mm
    let horario = dadosJson.horario.toString().replace(/[^\d]/g, '');
    if (horario.length === 4) {
      horario = horario.slice(0, 2) + ':' + horario.slice(2);
    } else if (horario.length === 2) {
      horario = horario + ':00';
    } else {
      throw new Error('Formato de horário inválido');
    }
    dadosJson.horario = horario;

    await agendarConsultaGoogleCalendar(dadosJson);
  } catch (err) {
    console.error('⛔ Erro ao preparar horário para o agendamento:', err.message);
  }
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🟢 Servidor rodando na porta ${port}`);
});
